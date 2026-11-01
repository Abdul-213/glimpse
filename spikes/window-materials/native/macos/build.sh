#!/usr/bin/env bash
# Builds the macOS helper dylib. Needs Xcode Command Line Tools (xcode-select --install).
# The SDK does not need to know NSGlassEffectView: the code looks it up at runtime.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
clang -dynamiclib -fobjc-arc -O2 -Wall -Wextra \
  -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -framework Foundation -framework AppKit -framework WebKit -framework QuartzCore \
  -o build/libglimmaterial.dylib glimmaterial.m
echo "built $(pwd)/build/libglimmaterial.dylib"
