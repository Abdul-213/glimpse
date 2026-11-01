#!/usr/bin/env sh
# Build native/macos/build/libglimcapture.dylib (needs Xcode command line tools:
# `xcode-select --install`). Builds for the host architecture; set ARCHS="arm64 x86_64"
# for a universal binary.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/build"
archs="${ARCHS:-$(uname -m)}"
outs=""
for a in $archs; do
	swiftc -O -swift-version 5 -emit-library -module-name GlimCapture \
		-target "$a-apple-macos12.3" \
		-framework ScreenCaptureKit -framework CoreGraphics -framework CoreMedia \
		-framework CoreVideo -framework Accelerate \
		-o "$here/build/libglimcapture-$a.dylib" "$here/GlimCapture.swift"
	outs="$outs $here/build/libglimcapture-$a.dylib"
done
# shellcheck disable=SC2086
lipo -create $outs -output "$here/build/libglimcapture.dylib"
# swiftc/ld already ad-hoc sign on Apple Silicon; make it explicit for x86_64 too.
codesign --force --sign - "$here/build/libglimcapture.dylib"
echo "OK: $here/build/libglimcapture.dylib"
