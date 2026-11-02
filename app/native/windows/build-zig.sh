#!/usr/bin/env sh
# Cross-compile app/native/windows/build/glimpse.dll from Linux or macOS with zig
# (checks that the Windows helper compiles and links without a Windows machine).
# ZIG=/path/to/zig overrides the zig on PATH.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/build"
"${ZIG:-zig}" c++ -target x86_64-windows-gnu -O2 -shared -std=c++17 \
	-Wall -Wextra -Werror -Wno-unused-parameter -Wno-cast-function-type-mismatch \
	-o "$here/build/glimpse.dll" "$here/glimpse.cpp" "$here/capture.cpp" "$here/picker.cpp" "$here/frame.cpp" "$here/announce.cpp" "$here/session.cpp" \
	-ld3d11 -ldxgi -luser32 -lgdi32 -ldwmapi -lversion -lole32 -lwtsapi32
echo "OK: $here/build/glimpse.dll"
