#!/usr/bin/python3 -I
"""Normal-user GTK launcher and optional AI setup. The browser stays unprivileged."""
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HELPER = "/usr/lib/streamerai/setup-helper"
MODEL = "qwen3.5:4b"
CERTIFICATE = "/usr/local/share/ca-certificates/streamerai-local.crt"


class NoApiRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError("The local Ollama API must not redirect requests")


def api(path, body=None, stream=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoApiRedirects())
    request = urllib.request.Request("http://127.0.0.1:11434" + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    response = opener.open(request, timeout=120 if body else 3)
    if stream:
        return response
    with response:
        data = response.read(262145)
        if len(data) > 262144:
            raise ValueError("Local runtime returned too much data")
        return json.loads(data)


def detect():
    runtime = False
    model = False
    try:
        version = api("/api/version").get("version")
        runtime = isinstance(version, str) and len(version) <= 100 and re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]{0,79})?", version) is not None
        model = any(item.get("name") == MODEL or item.get("model") == MODEL for item in api("/api/tags").get("models", []) if isinstance(item, dict))
    except Exception:
        pass
    installed = shutil.which("ollama") or next((name for name in ["/usr/bin/ollama", "/usr/local/bin/ollama", "/opt/streamerai/ollama/current/bin/ollama"] if Path(name).is_file()), None)
    return {"runtime": runtime, "model": model, "installed": installed}


def privileged(action, status, fingerprint=None):
    arguments = ["/usr/bin/pkexec", HELPER, action] + ([fingerprint] if fingerprint else [])
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    result = None
    try:
        for line in process.stdout:
            if len(line) > 16384:
                raise ValueError("Setup response exceeded its limit")
            value = json.loads(line)
            if value.get("error"):
                raise ValueError(value["error"])
            if value.get("status") == "downloading-runtime":
                status("Downloading Ollama: {}%".format(value.get("percent", 0)))
            result = value
        if process.wait() != 0 or result is None:
            raise ValueError("Authorization was cancelled or local setup could not finish")
        return result
    finally:
        if process.stdout:
            process.stdout.close()


def browser_certificates():
    """Per-user NSS stores only; never run browsers or user paths as root."""
    certificate = Path(CERTIFICATE)
    if not certificate.is_file() or certificate.is_symlink() or not shutil.which("certutil"):
        return False
    home = Path.home().resolve()
    stores = [home / ".pki/nssdb"]
    for base in [home / ".mozilla/firefox", home / "snap/firefox/common/.mozilla/firefox"]:
        if base.is_dir() and not base.is_symlink():
            stores += [item.parent for item in base.glob("*/cert9.db") if not item.is_symlink()]
    success = True
    for store in stores:
        if store.is_symlink() or home not in store.resolve().parents:
            continue
        store.mkdir(mode=0o700, parents=True, exist_ok=True)
        args = ["/usr/bin/certutil"]
        try:
            if not (store / "cert9.db").exists():
                subprocess.run(args + ["-N", "-d", "sql:" + str(store), "--empty-password"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            subprocess.run(args + ["-A", "-d", "sql:" + str(store), "-n", "StreamerAI local home server", "-t", "C,,", "-i", str(certificate)], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        except Exception:
            success = False
    return success


def main():
    if sys.argv[1:] == ["--self-test"]:
        assert MODEL == "qwen3.5:4b"
        assert HELPER == "/usr/lib/streamerai/setup-helper"
        assert "#setup=" not in CERTIFICATE
        try:
            NoApiRedirects().redirect_request(None, None, 302, None, {}, "https://untrusted.invalid/model")
        except ValueError:
            pass
        else:
            raise AssertionError("Local API redirect accepted")
        print("Desktop helper self-test passed")
        return
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, GLib, Gdk
    if os.geteuid() == 0:
        raise ValueError("Open StreamerAI from your normal desktop account, not as root")
    Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", True)
    styles = Gtk.CssProvider()
    styles.load_from_data(b"""
        window.streamer-setup { background: #14151d; color: #f2eee7; }
        window.streamer-setup label, window.streamer-setup checkbutton label { color: #f2eee7; }
        window.streamer-setup checkbutton:disabled label { color: #d5dbe1; }
        window.streamer-setup button.suggested-action { background: #e50914; color: white; }
        window.streamer-setup .result-details { color: #d5dbe1; }
    """)
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), styles, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    class Setup(Gtk.Window):
        def __init__(self):
            super().__init__(title="StreamerAI server")
            self.set_default_size(620, 480)
            self.set_border_width(24)
            self.set_icon_name("streamerai")
            self.get_style_context().add_class("streamer-setup")
            self.busy = False
            self.last_operation = None
            self.result_success = False
            self.connect("delete-event", lambda *_: self.busy)
            self.connect("destroy", Gtk.main_quit)
            outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
            self.add(outer)
            brand = Gtk.Label()
            brand.set_markup("<span foreground='#e50914' weight='heavy' size='large'>STREAMER</span><span foreground='#ffffff' weight='heavy' size='large'>AI</span>")
            brand.set_xalign(0)
            outer.pack_start(brand, False, False, 0)
            self.pages = Gtk.Stack()
            outer.pack_start(self.pages, True, True, 0)
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
            self.pages.add_named(box, "setup")
            title = Gtk.Label(label="Your home server is installed")
            title.set_xalign(0)
            title.get_style_context().add_class("title")
            box.pack_start(title, False, False, 0)
            description = Gtk.Label(label="Open StreamerAI in your browser. Local AI is optional: existing Ollama installations and models are reused.")
            description.set_line_wrap(True)
            description.set_xalign(0)
            box.pack_start(description, False, False, 0)
            self.status = Gtk.Label(label="Checking local AI…")
            self.status.set_line_wrap(True)
            self.status.set_xalign(0)
            box.pack_start(self.status, False, False, 0)
            self.runtime = Gtk.CheckButton(label="Install Ollama if missing, or start the existing runtime")
            self.model = Gtk.CheckButton(label="Prepare recommended Qwen 3.5 4B model if missing (about 3.4 GB)")
            box.pack_start(self.runtime, False, False, 0)
            box.pack_start(self.model, False, False, 0)
            note = Gtk.Label(label="A new Ollama install downloads about 1.5 GB and needs at least 8 GiB of system disk space. No GPU drivers are installed automatically. You can continue without AI.")
            note.set_line_wrap(True)
            note.set_xalign(0)
            box.pack_start(note, False, False, 0)
            self.prepare = Gtk.Button(label="Prepare selected local AI components")
            self.prepare.get_style_context().add_class("suggested-action")
            self.prepare.connect("clicked", lambda *_: self.work(self.prepare_ai, "AI_READY"))
            box.pack_start(self.prepare, False, False, 0)
            self.open = Gtk.Button(label="Open StreamerAI in browser")
            self.open.connect("clicked", lambda *_: self.work(self.inspect_for_browser, None))
            box.pack_start(self.open, False, False, 0)
            result = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
            self.pages.add_named(result, "result")
            self.result_symbol = Gtk.Label()
            self.result_symbol.set_xalign(0)
            result.pack_start(self.result_symbol, False, False, 0)
            self.result_title = Gtk.Label()
            self.result_title.set_xalign(0)
            result.pack_start(self.result_title, False, False, 0)
            self.result_summary = Gtk.Label()
            self.result_summary.set_xalign(0)
            self.result_summary.set_line_wrap(True)
            result.pack_start(self.result_summary, False, False, 0)
            heading = Gtk.Label(label="INSTALLATION RESULT")
            heading.set_xalign(0)
            result.pack_start(heading, False, False, 0)
            self.result_details = Gtk.Label()
            self.result_details.set_xalign(0)
            self.result_details.set_line_wrap(True)
            self.result_details.set_selectable(True)
            self.result_details.get_style_context().add_class("result-details")
            result.pack_start(self.result_details, False, False, 0)
            actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
            result.pack_end(actions, False, False, 0)
            close_result = Gtk.Button(label="Close")
            close_result.connect("clicked", lambda *_: Gtk.main_quit())
            actions.pack_end(close_result, False, False, 0)
            self.result_primary = Gtk.Button(label="Retry")
            self.result_primary.get_style_context().add_class("suggested-action")
            self.result_primary.connect("clicked", self.result_action)
            actions.pack_end(self.result_primary, False, False, 0)
            self.refresh()

        def message(self, text):
            GLib.idle_add(self.status.set_text, text)

        def show_result(self, success, code, detail):
            self.result_success = success
            self.result_symbol.set_markup("<span foreground='{}' size='xx-large'>{}</span>".format("#6ee2a6" if success else "#f9777d", "✓" if success else "☹"))
            self.result_title.set_markup("<span size='x-large' weight='bold'>{}</span>".format("Ready to watch." if success else "Setup needs another try."))
            if success:
                summary = "StreamerAI is ready in your browser. Existing profiles and models were preserved." if code == "SERVER_READY" else "Local AI is ready. Open StreamerAI to select the model."
            elif code == "AI_SETUP_FAILED":
                summary = "The server remains available, but local AI setup needs another try. Existing models were preserved."
            else:
                summary = "The secure local server could not be opened yet. Your data was preserved; retry setup after checking the details below."
            self.result_summary.set_text(summary)
            self.result_details.set_text("STATUS: {}\nCODE: {}\nDETAIL: {}".format("OK" if success else "ERROR", code, detail.replace("\n", " ")[:600]))
            self.result_primary.set_label("Open StreamerAI" if success else "Retry")
            self.pages.set_visible_child_name("result")

        def result_action(self, *_):
            self.pages.set_visible_child_name("setup")
            if self.result_success:
                self.work(self.inspect_for_browser, None)
            elif self.last_operation:
                self.work(*self.last_operation)

        def work(self, operation, outcome=None):
            if self.busy:
                return
            self.busy = True
            self.last_operation = (operation, outcome)
            self.prepare.set_sensitive(False)
            self.open.set_sensitive(False)
            self.runtime.set_sensitive(False)
            self.model.set_sensitive(False)
            runtime, model = self.runtime.get_active(), self.model.get_active()
            def execute():
                try:
                    operation(runtime, model)
                except Exception as failure:
                    code = "AI_SETUP_FAILED" if operation == self.prepare_ai else "HTTPS_CHECK_FAILED"
                    detail = str(failure) if isinstance(failure, ValueError) else "Setup could not finish. Check the network and try again; existing data was preserved."
                    GLib.idle_add(self.show_result, False, code, detail)
                else:
                    if outcome:
                        GLib.idle_add(self.show_result, True, outcome, "Local address: https://localhost:8443")
                finally:
                    GLib.idle_add(self.finished)
            threading.Thread(target=execute, daemon=True).start()

        def finished(self):
            self.busy = False
            self.prepare.set_sensitive(True)
            self.open.set_sensitive(True)
            self.runtime.set_sensitive(True)
            self.model.set_sensitive(True)

        def refresh(self):
            def check():
                state = detect()
                def display():
                    self.runtime.set_active(not state["runtime"])
                    self.model.set_active(not state["model"])
                    self.status.set_text("Ollama is running; the recommended model is already available." if state["model"] else "Ollama is running; the recommended model can be added." if state["runtime"] else "Ollama is installed but not running." if state["installed"] else "Ollama was not found. Install it below, or continue without AI.")
                GLib.idle_add(display)
            threading.Thread(target=check, daemon=True).start()

        def prepare_ai(self, want_runtime, want_model):
            state = detect()
            if want_runtime and not state["runtime"]:
                if state["installed"]:
                    self.message("Starting the existing Ollama runtime…")
                    try:
                        privileged("start-ollama", self.message)
                    except ValueError as failure:
                        if "No existing system service was found" not in str(failure):
                            raise
                        # Existing user installations remain under the desktop user.
                        subprocess.Popen([state["installed"], "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "OLLAMA_HOST": "127.0.0.1:11434"}, start_new_session=True)
                else:
                    self.message("Preparing Ollama. Authorize the fixed local installer when asked.")
                    privileged("install-ollama", self.message)
                for _ in range(60):
                    state = detect()
                    if state["runtime"]:
                        break
                    time.sleep(1)
            if want_model:
                state = detect()
                if not state["runtime"]:
                    raise ValueError("Start Ollama before downloading a model, or continue without AI")
                if not state["model"]:
                    self.message("Downloading the recommended model…")
                    with api("/api/pull", {"model": MODEL, "stream": True}, stream=True) as response:
                        while True:
                            line = response.readline(1048577)
                            if not line:
                                break
                            if len(line) > 1048576:
                                raise ValueError("Invalid model download progress")
                            progress = json.loads(line)
                            if progress.get("error"):
                                raise ValueError("Ollama could not finish the model download")
                            completed, total = progress.get("completed"), progress.get("total")
                            self.message("Downloading model: {}%".format(int(completed * 100 / total)) if isinstance(completed, int) and isinstance(total, int) and total > 0 else "Preparing the recommended model…")
                    if not detect()["model"]:
                        raise ValueError("The model download did not complete. Try again when connected")
            self.message("Selected AI components are ready. Existing models were preserved.")

        def inspect_for_browser(self, *_):
            self.message("Checking the local HTTPS certificate…")
            certificate = privileged("inspect-ca", self.message)
            def consent():
                dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.OK_CANCEL, text="Trust this server's local HTTPS certificate?")
                dialog.format_secondary_text("This allows your browser to connect securely to this local server. Only continue on the computer where you installed StreamerAI.\n\nSHA-256:\n" + certificate["fingerprint"])
                response = dialog.run()
                dialog.destroy()
                if response == Gtk.ResponseType.OK:
                    GLib.idle_add(lambda: self.work(lambda *_: self.open_browser(certificate["fingerprint"]), "SERVER_READY"))
            GLib.idle_add(consent)

        def open_browser(self, fingerprint):
            result = privileged("open-administration", self.message, fingerprint)
            if not browser_certificates():
                self.message("The system certificate is trusted. Your browser may ask for its own certificate approval; close and reopen it if needed.")
            else:
                self.message("Opening your local server in the browser…")
            url = result["url"]
            if not url.startswith("https://localhost:8443/"):
                raise ValueError("Invalid local server address")
            subprocess.Popen(["/usr/bin/xdg-open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    window = Setup()
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
