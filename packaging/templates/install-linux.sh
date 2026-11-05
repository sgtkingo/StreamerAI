#!/usr/bin/env bash
set -euo pipefail
release="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" != "--apply" ]]; then
  printf 'Dry run: validate bundle; install %s in /opt/streamerai/releases; create streamerai user; initialize /var/lib/streamerai/{data,keys}; register systemd server and localhost HTTPS gateway. Pass --apply as root to install.\n' "$release"
  exit 0
fi
[[ "${2:-}" == "--allow-prototype" ]] || { printf 'Service installer is a prototype; use --apply --allow-prototype for controlled acceptance testing.\n' >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || { printf 'Installation requires root.\n' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { printf 'Only Linux x64 is supported.\n' >&2; exit 1; }
"$release/runtime/node" "$release/service/verify-bundle.mjs" "$release" --complete
version="$("$release/runtime/node" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$release/bundle.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || exit 1
target="/opt/streamerai/releases/$version"
[[ ! -e /opt/streamerai/current && ! -e "$target" ]] || { printf 'Existing installation detected; upgrades require the supervised update procedure.\n' >&2; exit 1; }
getent passwd streamerai >/dev/null || useradd --system --home-dir /var/lib/streamerai --shell /usr/sbin/nologin streamerai
install -d -m 0755 /opt/streamerai/releases
cp -a -- "$release" "$target"
chown -R root:root "$target"
chmod -R go-w "$target"
install -d -m 0700 -o streamerai -g streamerai /var/lib/streamerai /var/lib/streamerai/data /var/lib/streamerai/keys /var/lib/streamerai/gateway
if [[ ! -e /var/lib/streamerai/keys/master.key ]]; then
  "$target/runtime/node" -e 'const f=require("node:fs");f.writeFileSync(process.argv[1],require("node:crypto").randomBytes(32).toString("base64")+"\n",{mode:0o600,flag:"wx"})' /var/lib/streamerai/keys/master.key
fi
chown streamerai:streamerai /var/lib/streamerai/keys/master.key
chmod 0600 /var/lib/streamerai/keys/master.key
ln -s "$target" /opt/streamerai/current
install -m 0644 "$target/service/streamerai-server.service" "$target/service/streamerai-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now streamerai-server.service streamerai-gateway.service
printf 'Installed locally: https://localhost:8443. Trust the instance CA before use. User data is retained on service removal.\n'
