# Windows native helper (`glimpse.dll`)

Empty for now. This is where the single Windows helper library lives, per
[GLIM-26](../../../docs/decisions/GLIM-26-stack.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md#native-helpers).

- Source: C++ for what plain `bun:ffi` can't reach, chiefly DXGI Desktop Duplication / Windows
  Graphics Capture with a GDI fallback. See `spikes/capture/native/windows/` (`build.ps1` for MSVC,
  `build-zig.sh` for cross-compiling) for a working starting point.
- Do **not** add plain Win32 calls that need no callback (`SetWindowDisplayAffinity`,
  `DwmSetWindowAttribute`, `SetWindowLongPtrW`) here: call them straight from TypeScript through
  `bun:ffi` against `user32.dll` / `dwmapi.dll`, as the capture-exclusion and window-materials
  spikes do.
- Exported C symbols are prefixed `glim_` and return plain status codes (0 = ok, otherwise an
  `HRESULT` or Win32 error); the TypeScript side (`app/src/bun/native/windows.ts`) turns them into
  typed results.
- Output to `build/glimpse.dll` (gitignored), copied next to the main bundle via
  `electrobun.config.ts` `copy`, only when building on Windows.
- Compiled in CI on a Windows runner (GLIM-34).
