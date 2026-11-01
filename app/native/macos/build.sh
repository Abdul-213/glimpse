#!/usr/bin/env sh
# Build app/native/macos/build/libglimpse.dylib (needs the Xcode Command Line Tools:
# `xcode-select --install`). Universal (arm64 + x86_64) by default; ARCHS="arm64"
# builds one architecture. Minimum macOS 14, like Electrobun and SCScreenshotManager.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/build"
mkdir -p "$out"
archs="${ARCHS:-arm64 x86_64}"
arch_flags=""
for a in $archs; do arch_flags="$arch_flags -arch $a"; done

# shellcheck disable=SC2086
clang -dynamiclib $arch_flags -mmacosx-version-min=14.0 -O2 \
	-fobjc-arc -fvisibility=hidden \
	-Wall -Wextra -Werror -Wno-unused-parameter -Wunguarded-availability-new \
	-install_name @rpath/libglimpse.dylib \
	-framework Foundation -framework AppKit -framework ScreenCaptureKit \
	-framework CoreGraphics -framework CoreMedia -framework CoreVideo -framework Accelerate \
	-o "$out/libglimpse.dylib" \
	"$here/glimpse.m" "$here/window.m" "$here/capture.m"

# Ad-hoc sign so the dylib loads on Apple Silicon (the app bundle is re-signed as a whole).
codesign --force --sign - "$out/libglimpse.dylib"
echo "OK: $out/libglimpse.dylib ($archs)"
