#!/usr/bin/env bash
# Run a command against a throwaway, unlocked GNOME Keyring on a headless Linux
# box, so Bun.secrets (libsecret) has a Secret Service to talk to.
#
#   bash scripts/linux-headless-keyring.sh [--fetch] <command...>
#
# - Uses a private dbus session (dbus-run-session) and private XDG dirs under a
#   temp directory, so the user's real keyring is never touched.
# - Uses the system gnome-keyring-daemon + libsecret if installed. Otherwise
#   looks in ./.keyring-prefix (Debian/Ubuntu packages unpacked without root).
#   --fetch creates that prefix with `apt-get download` + `dpkg-deb -x`.
# - The keyring password is empty; this is for tests only.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
prefix="${GLIM_KEYRING_PREFIX:-$here/.keyring-prefix}"

if [[ "${1:-}" == "--fetch" ]]; then
	shift
	debs="$(mktemp -d)"
	(cd "$debs" && apt-get download libsecret-1-0 libsecret-common gnome-keyring libgcr-base-3-1 libgck-1-0 libsecret-tools)
	mkdir -p "$prefix"
	for f in "$debs"/*.deb; do dpkg-deb -x "$f" "$prefix"; done
	rm -rf "$debs"
	echo "unpacked keyring packages into $prefix"
fi

if [[ $# -eq 0 ]]; then
	echo "usage: $0 [--fetch] <command...>" >&2
	exit 2
fi

multiarch="$(gcc -print-multiarch 2>/dev/null || echo x86_64-linux-gnu)"
if [[ -d "$prefix/usr/bin" ]]; then
	export PATH="$prefix/usr/bin:$PATH"
	export LD_LIBRARY_PATH="$prefix/usr/lib/$multiarch${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if ! command -v gnome-keyring-daemon >/dev/null; then
	echo "SKIP: gnome-keyring-daemon not found (install gnome-keyring + libsecret-1-0, or re-run with --fetch)" >&2
	exit 3
fi
if ! command -v dbus-run-session >/dev/null; then
	echo "SKIP: dbus-run-session not found (install dbus)" >&2
	exit 3
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data" "$tmp/config" "$tmp/run"
chmod 700 "$tmp/run"
export XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" XDG_RUNTIME_DIR="$tmp/run"
export GLIM_HEADLESS_KEYRING=1

# A plaintext (unencrypted, never locked) "login" collection, set as default.
# Same approach as Bun's own CI (test/js/bun/secrets-ci-setup.md).
mkdir -p "$tmp/data/keyrings"
chmod 700 "$tmp/data/keyrings"
cat >"$tmp/data/keyrings/login.keyring" <<'EOF'
[keyring]
display-name=login
ctime=0
mtime=0
lock-on-idle=false
lock-after=false
EOF
printf 'login' >"$tmp/data/keyrings/default"

# Inside the private bus: start the daemon (secrets component only), then exec the command.
dbus-run-session -- bash -c '
	set -e
	printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
	exec "$@"
' bash "$@"
