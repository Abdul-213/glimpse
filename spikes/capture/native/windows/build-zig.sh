#!/usr/bin/env sh
# Cross-compile glimcapture.dll from Linux/macOS with zig (used to verify the
# Windows code compiles and links without a Windows machine).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/build"
"${ZIG:-zig}" c++ -target x86_64-windows-gnu -O2 -shared -std=c++17 -Wall \
	-o "$here/build/glimcapture.dll" "$here/glimcapture.cpp" \
	-ld3d11 -ldxgi -luser32 -lgdi32
echo "OK: $here/build/glimcapture.dll"
