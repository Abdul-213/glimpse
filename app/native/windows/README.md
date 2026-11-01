# Windows native helper (`glimpse.dll`)

The single Windows helper library, per [GLIM-26](../../../docs/decisions/GLIM-26-stack.md) and
[ARCHITECTURE.md](../../../ARCHITECTURE.md#6-native-helpers). C++17, C ABI.

| File | What |
|---|---|
| `glimpse.h` | Status codes (mirrored in `app/src/bun/native/status.ts`), ABI version, export macro |
| `glimpse.cpp` | `glim_abi_version`, `glim_last_error` |
| `capture.cpp` | Screen capture (GLIM-36): GDI `BitBlt` (Snip, fallback) and DXGI Desktop Duplication (Live), per-monitor-DPI-aware physical pixels, BGRA→RGBA into the caller's buffer, bilinear resampling for mixed-DPI pieces. `glim_capture_displays_json`, `glim_capture_piece`, `glim_capture_release`. |
| `picker.cpp` | Region-picker helpers (GLIM-91): `glim_list_windows` (`EnumWindows` + `DWMWA_EXTENDED_FRAME_BOUNDS`, cloaked and shell windows and our own process dropped, app name from the exe's `FileDescription`; physical px, front to back), `glim_focus_save` / `glim_focus_restore` (`GetForegroundWindow` / `SetForegroundWindow`). Links `dwmapi` and `version`. |
| `frame.cpp` | Pinned Live frame (GLIM-90, live-popup.md §2.4/§12.2): `glim_frame_create/set_rect/set_style/set_highlight/show/window_id/info/destroy`. A `WS_EX_LAYERED \| WS_EX_TRANSPARENT \| WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW \| WS_EX_TOPMOST` popup on a helper-owned UI thread (own message loop, PMv2), `HTTRANSPARENT` hit-testing, `WDA_EXCLUDEFROMCAPTURE`, painted with `UpdateLayeredWindow` from a premultiplied DIB (ticks, linked box, tag; tag text through GDI grayscale coverage). Physical px in. |

WGC from the capture spike is not ported: it draws a border round the monitor that an
unpackaged app can't remove. Self-capture exclusion needs nothing here:
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` is a plain user32 call made from
TypeScript (`app/src/bun/native/windows.ts`), and so are the picker overlay's ex-style
(`WS_EX_TOOLWINDOW`) and `HWND_TOPMOST`. Loupe pixels need no export either: they are GDI
one-shots through the capture service.

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
