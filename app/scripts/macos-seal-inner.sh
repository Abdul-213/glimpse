#!/bin/sh
# Seal the app inside Electrobun's macOS self-extracting wrapper (GLIM-113).
#
#   sh app/scripts/macos-seal-inner.sh <path/to/Glimpse.app>     (macOS only; desktop.yml)
#
# A stable build's Glimpse.app is a wrapper: Contents/MacOS/launcher plus
# Contents/Resources/<hash>.tar.zst, which holds the real Glimpse.app and is unpacked on first
# launch. Every Mach-O in the inner app is signed (linker-signed ad-hoc; bun is Developer ID
# signed), but the inner bundle itself has no seal (no _CodeSignature), so
# `codesign --verify` fails on it and macOS has no stable code identity for the app it runs.
# Signing it in Electrobun's postBuild hook doesn't work: Electrobun writes
# Contents/Resources/version.json after postBuild, which breaks the seal again.
#
# So this runs after `electrobun build`, when version.json is final: unpack the archive, ad-hoc
# sign the inner bundle, check it verifies, and pack it back under the same name, in the same
# format (ustar, one zstd frame, window <= 8 MiB). The archive name and version.json are
# unchanged, so the launcher finds it as before. Sign the wrapper afterwards; its seal covers the
# new archive.
set -eu

wrapper=${1:?usage: macos-seal-inner.sh <wrapper.app>}
resources="$wrapper/Contents/Resources"
set -- "$resources"/*.tar.zst
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "expected one .tar.zst in $resources, found: $*" >&2; exit 1; }
archive=$1
command -v zstd >/dev/null 2>&1 || brew install zstd

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/x"
zstd -dc "$archive" | tar -xf - -C "$work/x"
set -- "$work"/x/*.app
[ "$#" -eq 1 ] && [ -d "$1" ] || { echo "expected one .app in the archive" >&2; exit 1; }
inner=$1
echo "inner app: ${inner#"$work/x/"} ($(du -sh "$inner" | cut -f1))"
echo "Contents/MacOS:"; ls -la "$inner/Contents/MacOS"
# GLIM-106: the unpacked app must be an accessory app too (no Dock icon). Report only.
lsui=$(plutil -extract LSUIElement raw "$inner/Contents/Info.plist" 2>/dev/null || echo missing)
echo "LSUIElement=$lsui in the inner app"
[ "$lsui" = true ] || echo "::warning::LSUIElement is not set in the inner app's Info.plist (GLIM-106)"

# Seal the bundle without re-signing nested code (bun keeps its Developer ID signature). If a
# nested file needs a signature of its own, fall back to signing everything ad-hoc.
if ! { codesign --force --sign - "$inner" && codesign --verify --deep --strict --verbose=2 "$inner"; }; then
	echo "sealing the top level only did not verify; signing nested code ad-hoc too"
	codesign --force --deep --sign - "$inner"
	codesign --verify --deep --strict --verbose=2 "$inner"
fi
codesign -dv "$inner" 2>&1 | grep -E '^(Identifier|Format|CodeDirectory|Signature|Sealed Resources)' || true

# Same layout as Electrobun's archive: ustar entries "<Name>.app/...", no AppleDouble (._) files.
COPYFILE_DISABLE=1 tar --format ustar --no-mac-metadata -cf "$work/inner.tar" -C "$work/x" "$(basename "$inner")"
zstd -q -15 -T0 --zstd=wlog=23 -f "$work/inner.tar" -o "$work/inner.tar.zst"
mv -f "$work/inner.tar.zst" "$archive"

# Check what the launcher will unpack: a fresh extraction must verify too.
mkdir "$work/check"
zstd -dc "$archive" | tar -xf - -C "$work/check"
codesign --verify --deep --strict --verbose=2 "$work/check/$(basename "$inner")"
echo "sealed inner app packed into $(basename "$archive") ($(du -h "$archive" | cut -f1))"
