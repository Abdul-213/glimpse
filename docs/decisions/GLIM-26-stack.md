# GLIM-26: Stack decision

Status: **Accepted, provisional** (2026-11-01). Adopted by the agent team so build work can start, at the owner's instruction to carry the project through to completion. The owner can override it; the parts most likely to change are listed under "Revisit if". · Scope: Windows + macOS, Linux as a headless dev/CI target only.

## Decision

**Electrobun (Bun + system webview), plus small per-OS native helper libraries loaded with `bun:ffi`.** No Rust sidecar and no Tauri for now.

| Layer | Choice |
|---|---|
| Shell | Electrobun, pinned to **2.0.6-beta.2** (the first build whose transparent Windows windows show WebView2 content; see `spikes/overlay/FINDINGS.md`). Move to the first stable release that contains the fix. |
| Main process | Bun + TypeScript (strict). |
| Native gaps | One helper library per OS, called through `bun:ffi`, with all AppKit/Win32 calls dispatched to the main thread: **macOS** `libglimpse.dylib` (Objective-C/Swift: window level, `NSVisualEffectView`, `sharingType`, ScreenCaptureKit capture with window exclusion, Carbon hotkeys if needed). **Windows** `glimpse.dll` (C++: DXGI/WGC/GDI capture). Plain Win32 calls that need no callback (`SetWindowDisplayAffinity`, `DwmSetWindowAttribute`) go straight through `bun:ffi` to `user32`/`dwmapi`. |
| Capture | Windows: DXGI Desktop Duplication, GDI fallback. macOS: ScreenCaptureKit (`SCScreenshotManager` for Snip, `SCStream` for Live). Electrobun's `Screen.captureRegion` is not used. |
| Hotkeys | Electrobun `GlobalShortcut` on Windows (`RegisterHotKey`). macOS: Carbon `RegisterEventHotKey` in the helper dylib (the NSEvent monitor needs Accessibility and can't consume the key). |
| Secrets | `Bun.secrets` (Keychain / Credential Manager). |
| OCR | PaddleOCR (PP-OCRv5 mobile det + rec, ONNX) on ONNX Runtime from Bun, subject to GLIM-17. |
| Translation | Firefox Translations / Bergamot (MPL-2.0) per GLIM-85, run as WASM inside Bun, subject to GLIM-17. SMaLL-100 / M2M-100 via ONNX Runtime as the long-tail fallback. |
| UI | Solid + TypeScript in the webviews, Tailwind driven by DESIGN.md tokens, unstyled primitives (Kobalte/Ark), Motion One for animation. Built with Bun's bundler. |
| Tests | `bun test` for logic; the Linux headless harness (GLIM-86) for end-to-end runs with a file-based capture backend and a fake display. |

## Why

- Six of the seven spikes built and passed their unit tests on Windows CI (2026-10-30), and every gap they found is closable with a few hundred lines of native code behind `bun:ffi`. None needed a separate process.
- One language (TypeScript) for the app, the UI and the provider layer keeps the agent-written codebase small and testable on Linux.
- A Rust sidecar would add a second build toolchain, IPC and code signing surface for things `bun:ffi` already reaches. Tauri would mean re-doing the spikes.

## Revisit if

- **GLIM-17 fails:** ONNX Runtime or the Bergamot WASM can't run acceptably inside Bun. Then move inference (only) into a sidecar process: first choice a compiled Bun binary with onnxruntime, second a small Rust binary. The rest of the stack stays.
- **Real-machine checks of the spikes fail** in a way native helpers can't fix (for example WebView2 transparency still broken, or overlays that can't sit above fullscreen apps). Then Tauri is the fallback.
- **Electrobun 2.x stalls** on a fix we need for more than a release cycle.

## Open items carried forward

- Real-machine verification of GLIM-13–16, 18, 19 on Windows and macOS (owner).
- The macOS helper code has not been compiled yet; CI compiles it on a macOS runner (GLIM-34).
