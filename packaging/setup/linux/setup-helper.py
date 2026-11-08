#!/usr/bin/python3 -I
"""Root-owned, fixed-operation helper. Never accepts a path, URL or shell command."""
import hashlib
import json
import os
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.parse
from pathlib import Path, PurePosixPath

STATE = Path("/var/lib/streamerai")
CA_FILE = STATE / "gateway/pki/authorities/local/root.crt"
CERT_TARGET = Path("/usr/local/share/ca-certificates/streamerai-local.crt")
MANAGED = Path("/opt/streamerai/ollama")
MODEL_STATE = Path("/var/lib/streamerai-ollama")
DESCRIPTOR = Path("/usr/lib/streamerai/ollama.pinned.json")
ORIGINS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/root"}


def emit(**values):
    print(json.dumps(values), flush=True)


def run(arguments, **kwargs):
    return subprocess.run(arguments, check=True, env=SAFE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kwargs.pop("timeout", 60), **kwargs)


class NoApiRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError("The local Ollama API must not redirect requests")


def local_api(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoApiRedirects())
    with opener.open("http://127.0.0.1:11434" + path, timeout=3) as response:
        body = response.read(262145)
    if len(body) > 262144:
        raise ValueError("Invalid local Ollama response")
    return json.loads(body)


def runtime_reachable():
    try:
        version = local_api("/api/version").get("version")
        return isinstance(version, str) and len(version) <= 100 and re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]{0,79})?", version) is not None
    except Exception:
        return False


def protected_file(filename, allowed_uid):
    if filename.is_symlink() or not filename.is_file():
        raise ValueError("Required local setup file is unavailable")
    current = filename
    while current != Path("/"):
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid not in {0, allowed_uid} or info.st_mode & 0o022:
            raise ValueError("Unsafe local setup file permissions")
        current = current.parent
    if filename.stat().st_size > 65536:
        raise ValueError("Local setup file is too large")
    return filename.read_bytes()


def certificate():
    import pwd
    owner = pwd.getpwnam("streamerai").pw_uid
    for attempt in range(30):
        if CA_FILE.exists():
            break
        if attempt == 29:
            raise ValueError("The local HTTPS gateway has not started")
        time.sleep(0.5)
    pem = protected_file(CA_FILE, owner).decode("ascii")
    if pem.count("-----BEGIN CERTIFICATE-----") != 1:
        raise ValueError("Invalid local CA certificate")
    der = ssl.PEM_cert_to_DER_cert(pem)
    run(["/usr/bin/openssl", "x509", "-in", str(CA_FILE), "-noout", "-subject"])
    return pem, hashlib.sha256(der).hexdigest()


def open_administration(expected_fingerprint):
    pem, fingerprint = certificate()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_fingerprint) or fingerprint != expected_fingerprint:
        raise ValueError("The local CA changed; review its fingerprint again")
    if CERT_TARGET.is_symlink():
        raise ValueError("Unsafe certificate destination")
    CERT_TARGET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=CERT_TARGET.parent, prefix=".streamerai-ca-", delete=False) as target:
        temporary = Path(target.name)
        target.write(pem.encode("ascii"))
    try:
        temporary.chmod(0o644)
        os.replace(temporary, CERT_TARGET)
        run(["/usr/sbin/update-ca-certificates"], timeout=120)
    finally:
        temporary.unlink(missing_ok=True)
    emit(status="ready", fingerprint=fingerprint, url="https://localhost:8443/admin")


class TrustedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if parsed.scheme != "https" or parsed.hostname not in ORIGINS or parsed.username or parsed.password:
            raise ValueError("Untrusted Ollama download redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def descriptor():
    value = json.loads(protected_file(DESCRIPTOR, 0))
    if value.get("version") != "0.40.14" or value.get("url") != "https://github.com/ollama/ollama/releases/download/v0.40.14/ollama-linux-amd64.tar.zst" or value.get("bytes") != 1525335029 or not re.fullmatch(r"[a-f0-9]{64}", value.get("sha256", "")):
        raise ValueError("Invalid pinned Ollama descriptor")
    return value


def safe_archive_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError("Unsafe Ollama archive path")
    normalized = str(path)
    if normalized not in {".", "bin", "lib", "lib/ollama"} and not (normalized == "bin/ollama" or normalized.startswith("lib/ollama/")):
        raise ValueError("Unexpected Ollama archive content")
    return normalized


def install_runtime():
    import fcntl
    import pwd
    if runtime_reachable():
        emit(status="already-running")
        return
    if any(Path(name).exists() for name in ["/usr/bin/ollama", "/usr/local/bin/ollama", str(MANAGED / "current/bin/ollama")]):
        raise ValueError("Ollama already exists; start the existing runtime instead")
    if (MANAGED / "current").is_symlink() or Path("/etc/systemd/system/streamerai-ollama.service").exists():
        raise ValueError("An existing managed Ollama configuration needs review; it was not overwritten")
    cache = Path("/var/cache/streamerai")
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache.is_symlink() or cache.stat().st_uid != 0 or cache.stat().st_mode & 0o022:
        raise ValueError("Unsafe installer cache")
    with (cache / "ollama-install.lock").open("a+") as operation_lock:
        fcntl.flock(operation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = descriptor()
        if shutil.disk_usage(cache).free < 8 * 1024 ** 3:
            raise ValueError("At least 8 GiB of free system disk space is recommended for the runtime installation")
        with tempfile.TemporaryDirectory(dir=cache, prefix="ollama-") as directory:
            work = Path(directory)
            archive = work / "runtime.tar.zst"
            digest, downloaded, last_percent = hashlib.sha256(), 0, -1
            download_started = time.monotonic()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), TrustedRedirects())
            request = urllib.request.Request(selected["url"], headers={"User-Agent": "StreamerAI-local-setup"})
            with opener.open(request, timeout=60) as response, archive.open("xb") as target:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    if time.monotonic() - download_started > 3600:
                        raise ValueError("Ollama download timed out; try again with a faster connection")
                    downloaded += len(chunk)
                    if downloaded > selected["bytes"]:
                        raise ValueError("Ollama download exceeded its pinned size")
                    digest.update(chunk)
                    target.write(chunk)
                    percent = downloaded * 100 // selected["bytes"]
                    if percent != last_percent:
                        emit(status="downloading-runtime", percent=percent)
                        last_percent = percent
            if downloaded != selected["bytes"] or digest.hexdigest() != selected["sha256"]:
                raise ValueError("Ollama installer checksum did not match")
            stage = work / "stage"
            stage.mkdir(mode=0o700)
            emit(status="unpacking-runtime")
            process = subprocess.Popen(["/usr/bin/zstd", "--decompress", "--stdout", str(archive)], env=SAFE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                total, count = 0, 0
                with tarfile.open(fileobj=process.stdout, mode="r|") as packed:
                    for member in packed:
                        safe_archive_name(member.name)
                        count += 1
                        total += member.size
                        if member.size < 0 or count > 30000 or total > 10 * 1024 ** 3:
                            raise ValueError("Ollama archive exceeded its unpacked limit")
                        packed.extract(member, path=stage, filter="data")
                if process.wait(timeout=60) != 0:
                    raise ValueError("Ollama archive could not be decoded")
            finally:
                if process.stdout:
                    process.stdout.close()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
            if not (stage / "bin/ollama").is_file() or (stage / "bin/ollama").is_symlink():
                raise ValueError("The archive did not contain the expected runtime")
            target = MANAGED / "releases" / selected["version"]
            if target.exists() or (MANAGED / "current").exists():
                raise ValueError("An installation already exists; no overwrite was performed")
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            # Keep incomplete copies out of the version directory; a failed copy is
            # cleaned by TemporaryDirectory before the installed path is visible.
            with tempfile.TemporaryDirectory(dir=target.parent, prefix=".staging-") as copied:
                shutil.copytree(stage, copied, symlinks=True, dirs_exist_ok=True)
                for current, directories, files in os.walk(copied, followlinks=False):
                    Path(current).chmod(0o755)
                    for name in files:
                        item = Path(current) / name
                        if not item.is_symlink():
                            item.chmod(0o755 if name == "ollama" or ".so" in name else 0o644)
                os.rename(copied, target)
            (MANAGED / "current").symlink_to(target, target_is_directory=True)
        try:
            pwd.getpwnam("streamerai-ollama")
        except KeyError:
            run(["/usr/sbin/adduser", "--system", "--group", "--home", str(MODEL_STATE), "--no-create-home", "streamerai-ollama"])
        account = pwd.getpwnam("streamerai-ollama")
        MODEL_STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        (MODEL_STATE / "models").mkdir(mode=0o700, exist_ok=True)
        for target in [MODEL_STATE, MODEL_STATE / "models"]:
            os.chown(target, account.pw_uid, account.pw_gid)
        for group in ["render", "video"]:
            check = subprocess.run(["/usr/bin/getent", "group", group], env=SAFE_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if check.returncode == 0:
                run(["/usr/sbin/usermod", "-a", "-G", group, "streamerai-ollama"])
        unit = Path("/etc/systemd/system/streamerai-ollama.service")
        if unit.exists():
            raise ValueError("An Ollama service configuration already exists")
        unit.write_text("""[Unit]
Description=StreamerAI optional local Ollama
After=network.target
[Service]
User=streamerai-ollama
Group=streamerai-ollama
ExecStart=/opt/streamerai/ollama/current/bin/ollama serve
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_MODELS=/var/lib/streamerai-ollama/models
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/streamerai-ollama
[Install]
WantedBy=multi-user.target
""", encoding="utf8")
        unit.chmod(0o644)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "enable", "--now", "streamerai-ollama.service"], timeout=120)
        emit(status="runtime-installed")


def start_runtime():
    if runtime_reachable():
        emit(status="already-running")
        return
    for unit in ["streamerai-ollama.service", "ollama.service"]:
        check = subprocess.run(["/usr/bin/systemctl", "show", unit, "--property=LoadState", "--value"], env=SAFE_ENV, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
        if check.returncode == 0 and check.stdout.strip() == b"loaded":
            run(["/usr/bin/systemctl", "start", unit], timeout=120)
            emit(status="runtime-started")
            return
    raise ValueError("No existing system service was found; open the existing Ollama application")


def main():
    if sys.argv[1:] == ["--self-test"]:
        try:
            NoApiRedirects().redirect_request(None, None, 302, None, {}, "https://untrusted.invalid/model")
        except ValueError:
            pass
        else:
            raise AssertionError("Local API redirect accepted")
        for name in ["bin/ollama", "lib/ollama/libtest.so", "./bin/ollama"]:
            safe_archive_name(name)
        for name in ["../../etc/passwd", "/etc/passwd", "bin/another", "lib/ollama/../../escape"]:
            try:
                safe_archive_name(name)
            except ValueError:
                continue
            raise AssertionError("Unsafe archive name accepted")
        emit(status="self-test-ok")
        return
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise ValueError("Run this fixed setup helper through the desktop authorization dialog")
    caller = os.environ.get("PKEXEC_UID", "0")
    if not caller.isdecimal():
        raise ValueError("Invalid local authorization context")
    import pwd
    pwd.getpwuid(int(caller))
    args = sys.argv[1:]
    if args == ["inspect-ca"]:
        _, fingerprint = certificate()
        emit(status="certificate", fingerprint=fingerprint)
    elif len(args) == 2 and args[0] == "open-administration":
        open_administration(args[1])
    elif args == ["install-ollama"]:
        install_runtime()
    elif args == ["start-ollama"]:
        start_runtime()
    else:
        raise ValueError("Unsupported setup operation")


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:
        # Fixed setup errors only; never print secrets, archive contents or a traceback.
        message = str(failure) if isinstance(failure, ValueError) else "Local setup could not finish. Existing data and models were retained."
        emit(error=message)
        sys.exit(1)
