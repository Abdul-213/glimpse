#!/usr/bin/env sh
# Re-sign the built spike .app so the TCC permission tests control exactly which
# code identity macOS sees.
#
#   scripts/mac-sign.sh adhoc                       # ad-hoc: DR = cdhash, changes every rebuild
#   scripts/mac-sign.sh "Glimpse Spike Self-Signed" # stable self-signed identity from your keychain
#   scripts/mac-sign.sh show                        # print identity, cdhash and designated requirement
#
# APP defaults to the newest build/*/*.app; override with APP=/path/to/X.app.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-show}"
app="${APP:-$(ls -td "$here"/build/*/*.app 2>/dev/null | head -n 1)}"
[ -n "$app" ] && [ -d "$app" ] || { echo "no .app found; build first (see TESTING.md)"; exit 1; }

show() {
	echo "== $app"
	defaults read "$app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null | sed 's/^/bundle id: /'
	codesign -dvvv "$app" 2>&1 | grep -E '^(Identifier|CDHash|Signature|Authority|TeamIdentifier|CodeDirectory)' || true
	codesign -d -r- "$app" 2>&1 | grep designated || echo "designated requirement: (none)"
	codesign --verify --deep --strict "$app" && echo "verify: OK" || echo "verify: FAILED"
}

case "$mode" in
show) show ;;
*)
	ident="$mode"
	[ "$mode" = "adhoc" ] && ident="-"
	# Inside-out: every Mach-O and nested bundle first, then the app itself.
	find "$app/Contents" -type f \( -name '*.dylib' -o -name '*.so' -o -perm -u+x \) | while read -r f; do
		if file "$f" | grep -q 'Mach-O'; then codesign --force --sign "$ident" "$f"; fi
	done
	find "$app/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.bundle' \) ! -path "$app" | while read -r d; do
		codesign --force --sign "$ident" "$d"
	done
	codesign --force --sign "$ident" "$app"
	show
	;;
esac
