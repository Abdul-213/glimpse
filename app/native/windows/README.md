# Windows native helper (`glimpse.dll`)

The single Windows helper library, per [GLIM-26](../../../docs/decisions/GLIM-26-stack.md) and
[ARCHITECTURE.md](../../../ARCHITECTURE.md#6-native-helpers). C++17, C ABI.

| File | What |
|---|---|
| `glimpse.h` | Status codes (mirrored in `app/src/bun/native/status.ts`), ABI version, export macro |
| `glimpse.cpp` | `glim_abi_version`, `glim_last_error` |
| `capture.cpp` | Screen capture (GLIM-36): GDI `BitBlt` (Snip, fallback) and DXGI Desktop Duplication (Live), per-monitor-DPI-aware physical pixels, BGRA→RGBA into the caller's buffer, bilinear resampling for mixed-DPI pieces. `glim_capture_displays_json`, `glim_capture_piece`, `glim_capture_release`. |

WGC from the capture spike is not ported: it draws a border round the monitor that an
unpackaged app can't remove. Self-capture exclusion needs nothing here:
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` is a plain user32 call made from
TypeScript (`app/src/bun/native/windows.ts`).

## Build

```powershell
# MSVC (Developer PowerShell for VS) or zig (winget install -e --id zig.zig)
pwsh app/native/windows/build.ps1          # -> app/native/windows/build/glimpse.dll
```

```sh
# Cross-compile from Linux/macOS with zig, to check it compiles and links
ZIG=/path/to/zig sh app/native/windows/build-zig.sh
```

`electrobun.config.ts` copies `build/glimpse.dll` to `native/glimpse.dll` in the app when
building on Windows. CI compiles it with MSVC (`.github/workflows/native.yml`).

## Rules

- Exports are `glim_*`, return `int32` status (0 ok, -1..-99 Glimpse codes, else an `HRESULT`).
- Text out: `(char* buf, int32 cap) -> full length`. Pixel buffers are caller-owned.
- Don't add plain Win32 calls that need no callback or COM (`SetWindowDisplayAffinity`,
  `DwmSetWindowAttribute`, `SetWindowLongPtrW`): call them from TypeScript through `bun:ffi`.
- Bump `GLIM_ABI` here and `GLIM_ABI_VERSION` in `app/src/bun/native/load.ts` together when
  an export's signature changes.
