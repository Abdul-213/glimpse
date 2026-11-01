# GLIM-15 findings: region screen capture and the macOS permission on unsigned builds

Status: **code complete, not yet run on real hardware.** Everything was written and checked on a headless Linux machine. Of the per-OS native code, only the Windows library has been compiled (cross-compiled with zig). The Swift library has never been compiled. Running [TESTING.md](TESTING.md) on a real Windows PC and a real Mac turns the expectations below into results.

## TL;DR

- **Electrobun's built-in capture is not usable for Glimpse.** Electrobun 2.0.5 has `Screen.captureRegion()`, but:
  - On macOS it uses the deprecated `CGWindowListCreateImage` at *nominal* (1x) resolution. That loses the Retina detail OCR needs, and the API is unsupported from macOS 26.
  - On Windows it calls `GetPixel` **once per pixel**, so a 1080p region takes seconds to minutes.
  - Its permission helpers (`Utils.screenCapture.hasAccess/requestAccess/openSettings`) are fine thin wrappers over `CGPreflight…`/`CGRequest…`.
- **Approach: a small native library per OS, loaded in-process with `bun:ffi`.** Swift on macOS (~430 lines), C++ on Windows (~930 lines).
  - Bun allocates the RGBA `Uint8Array` and native code writes straight into it: one GPU/IOSurface → CPU copy, with the BGRA→RGBA swizzle done during that copy.
  - No sidecar, no IPC, no extra copies. Electrobun itself works the same way (its native wrapper is an FFI-loaded library), so capture needs neither a Rust sidecar nor Tauri.
- **Windows: DXGI Desktop Duplication is the expected primary for Live mode, with GDI as the simple path for Snip.**
  - DXGI draws no capture border, is cheap once warm, and only does work when asked for a frame.
  - WGC is implemented too, but it draws a coloured border around the whole monitor while capturing. Microsoft documents that removing the border needs user consent plus a package-manifest capability, which an unpackaged app doesn't have. Check W3 tests whether we can remove it at all.
- **macOS: ScreenCaptureKit, at native Retina resolution.** `SCStream` for Live (persistent, returns the latest frame); `SCScreenshotManager` for Snip (macOS 14+).
- **Permission on unsigned builds: an ad-hoc-signed Glimpse loses its Screen Recording grant on every update.**
  - TCC identifies an app by its code signature's *designated requirement*. For ad-hoc code that requirement is just the cdhash, which changes with every build (Apple DTS, [forum thread 795739][quinn-adhoc]; [TN3127][tn3127]).
  - So the user re-grants after every update, often after first removing a stale entry that still shows as switched on.
  - Likely cheap fix: **sign every release with one stable self-signed code-signing certificate** kept in CI. It is free and still "unsigned" as far as Gatekeeper is concerned, but it gives TCC a stable designated requirement. Steps P8–P10 test this.
  - A paid Developer ID fixes both TCC persistence and Gatekeeper.
- **Expected verdicts:**
  - Windows: **pass** (capture via DXGI/GDI; the WGC border is a known caveat).
  - macOS: **partial**. Capture should pass, but the grant does not persist with ad-hoc signing. It becomes **pass** if P9 confirms that a stable self-signed identity keeps the grant.

## What was built (`spikes/capture/`)

| Path | What |
|---|---|
| `src/core/` | Pure TypeScript, unit-tested: geometry (per-display split, output scale, logical↔physical); latency stats (nearest-rank p50/p95); fixed-rate loop accounting (dropped ticks, CPU); RGBA helpers and RGBA→float32 CHW tensor; a minimal PNG encoder; macOS permission-state derivation. |
| `src/native/lib.ts` | `bun:ffi` binding to the native C ABI: `gc_displays_json`, `gc_capture_piece`, `gc_set_option`, `gc_reset`, `gc_stats_json`, plus `gc_mac_*` and `gc_wgc_request_borderless`. |
| `native/windows/glimcapture.cpp` | GDI, DXGI duplication and WGC behind that ABI. WinRT goes through hand-declared ABI interfaces with explicit IIDs, so it builds with MSVC *or* zig/mingw and needs no C++/WinRT. |
| `native/macos/GlimCapture.swift` | `SCScreenshotManager` and `SCStream` backends, plus preflight / request / probe. Async SCK calls are wrapped in semaphores with 3 s timeouts. |
| `src/app/runner.ts` | Shared runner: standard regions, snapshots → PNG, latency bench, 4 fps loop, JSON + Markdown results, permission report. |
| `src/cli.ts` | Plain-Bun CLI: `displays`, `capture`, `bench`, `loop`, `suite`, `perm*`, `wgc-borderless`. |
| `src/bun/index.ts` | Electrobun app: a small window to type a rect, pick a backend, run captures and drive the permission tests. Electrobun's built-in capture is included as an extra backend. |
| `scripts/mac-sign.sh`, `scripts/mac-tcc-dump.sh` | Re-sign the built .app ad-hoc or with a named identity; read what TCC stored. |
| `native/fake/fakecapture.c` | Linux test double with the same ABI, used to test the real FFI path. |

## Getting pixels to Bun

- **Contract:** tightly packed RGBA8, top row first, alpha forced to 255, `width*height*4` bytes. This is the HWC layout ONNX preprocessing starts from. `rgbaToChwFloat32()` shows the next step (normalise → CHW float32). Resizing to the model's input size belongs to the ONNX spike.
- **One copy per capture:**
  - Windows: `CopySubresourceRegion` copies the region from the GPU frame into a cached staging texture, then `Map` plus a row copy with swizzle writes it into the Bun buffer.
  - macOS: `vImagePermuteChannels_ARGB8888` writes the `CVPixelBuffer` (IOSurface) straight into the destination sub-rect of the Bun buffer.
  - Pieces from several displays are written at their offsets in the same buffer.
- **Why not a sidecar:**
  - To avoid copying frames through a pipe, a sidecar needs shared memory plus a signalling channel.
  - It is one more process to sign, ship and supervise.
  - On macOS it does not change TCC attribution: the responsible process is still the app that launched it.
  - In-process FFI is lighter in every respect. The cost is that a crash in native code takes down the Bun main process, which is acceptable at this code size.
- **FFI overhead, measured here against the fake library:** a 400x120 px grab through the real 15-argument `gc_capture_piece` binding, including the fake's synthetic pixel fill, takes **p50 ≈ 0.13 ms, p95 ≈ 0.2–0.3 ms**. The binding is not a bottleneck.
- **Threading caveat:**
  - Captures run synchronously on Bun's JS thread. A Windows capture blocks it for about 1–20 ms.
  - macOS SCK calls block on a semaphore while SCK calls back on its own queue. If Electrobun's Bun thread is the AppKit main thread *and* SCK delivers a completion on the main queue, the call stalls until the 3 s timeout (check M4).
  - Production fix: call SCK from a native worker thread and signal Bun through a `JSCallback(threadsafe)`.

## Coordinates and mixed DPI

- **macOS:**
  - One global *point* space (CoreGraphics top-left convention). Electrobun's `Screen` API uses the same space.
  - `planCapture()` splits a region per display and picks the output scale: the highest `pixelScale` among the displays the region touches.
  - Each piece is captured with `sourceRect` in display-local points and `width/height` in output pixels. SCK scales the 1x part up and the Retina part keeps full detail.
  - Destination edges are rounded from global positions, so pieces tile without seams (unit-tested with fractional edges).
- **Windows:**
  - The native library sets per-monitor-DPI-aware-v2 on the calling thread, and on the process if Electrobun hasn't already. Everything is therefore in **physical** virtual-desktop pixels, where a region spanning monitors is still one rectangle.
  - GDI grabs that rectangle in one `BitBlt`. DXGI and WGC capture per monitor and the pieces are composed.
  - Electrobun's own `Screen` API uses a synthesised **logical** layout: each monitor at its logical size, placed next to its neighbour. `logicalToNative()` maps a logical rect to physical per monitor (matched by HMONITOR id), for the future overlay.
  - With mixed DPI, a logical rect that spans monitors is not a rectangle in physical space. The overlay should work in physical px on Windows.
- Parts of a region that are on no display come back opaque black.

## Windows: API comparison

| | GDI `BitBlt` | DXGI Desktop Duplication | Windows.Graphics.Capture |
|---|---|---|---|
| Min OS | any | Win 8 | Win10 1803 (monitor capture 1903; cursor toggle 2004; border toggle 20348 / Win11) |
| Region grab | Any rect in one call, including across monitors | Whole output per monitor → GPU copy of the region → readback | Whole monitor per session → GPU copy of the region → readback |
| Warm cost at 2–4 fps | CPU copy from the compositor: a few ms for small regions, more for 1080p (expected) | Very low. `AcquireNextFrame(0)` returns only when the desktop changed; otherwise the last GPU copy is reused. | Very low. Drain the newest frame from the pool, otherwise reuse the last. |
| Cold start | none | Device + duplication, tens of ms (expected) | Device, item, pool and session; first frame ~30–100 ms (expected) |
| Capture indicator | none | **none** | **coloured border around the whole monitor** (see below) |
| Cursor | never captured | never drawn into the image (separate pointer-shape API) | `IsCursorCaptureEnabled` (off in the spike) |
| Fragility | Robust; CAPTUREBLT can make the cursor flicker | `ACCESS_LOST` on mode change, desktop switch, UAC or fullscreen transitions (must recreate). Must use the adapter that owns the output (hybrid GPUs). Limited duplications per output. Rotated outputs not handled here. | Robust across mode changes; needs WinRT/D3D interop |
| Excludes `WDA_EXCLUDEFROMCAPTURE` windows (GLIM-16) | yes (Win10 2004+) | yes | yes |

**Recommendation, to confirm with checks W2–W7:**
- DXGI for Live mode: persistent, no border.
- GDI for one-shot Snip: no session to warm up, nothing fragile.
- WGC as the fallback where DXGI fails, e.g. `DXGI_ERROR_UNSUPPORTED` on some hybrid-GPU or remote setups.

**The WGC border.**
- Microsoft's reference for `GraphicsCaptureSession.IsBorderRequired` (Windows 10 build 20348+ / Windows 11) says the border is removed only after the app gets consent through `GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless)`.
- That call shows a prompt and requires the `graphicsCaptureWithoutBorder` capability in the app's *package manifest*. If the user declines, setting the property to false "will succeed, but the value will be ignored" ([MS docs][wgc-border]).
- Glimpse is an unpackaged Win32 app, so the documented route may not be open to it.
- One anecdotal report says setting the property via `IGraphicsCaptureSession3` works without the request ([handmade.network][handmade]).
- Check W3 tries both routes and logs what `get_IsBorderRequired` reads back.
- Before build 20348 the border cannot be turned off at all.
- This is the main reason WGC is not the recommended primary: a border around the whole monitor whenever Live mode runs breaks principle 1, "Never in the way".

## macOS: API choice

- **`SCStream` (macOS 12.3+):**
  - One stream per display.
  - `sourceRect` = the region; output size = points × scale; `minimumFrameInterval` = 1/fps; `queueDepth` 3; BGRA, sRGB, cursor off.
  - Only the newest complete frame is kept, so the stream's buffer pool never runs dry.
  - SCK sends *idle* frames (no pixels) when nothing changed; the spike counts them.
  - This suits Live mode: CPU stays near zero while the screen is static, and getting a frame is a memcpy.
- **`SCScreenshotManager.captureSampleBuffer` (macOS 14+):** a one-shot capture using the same filter and configuration, so it is the natural Snip path. Developers report it is slow when called once per frame ([SCK screenshot latency report][sck-latency]). Check M1 measures this.
- **Fallbacks:**
  - macOS 12.3–13: use `SCStream` for single shots too (start, take the first frame, stop).
  - Older systems would need `CGWindowListCreateImage` / `CGDisplayCreateImageForRect`. Both are deprecated since macOS 14 and *obsoleted* in the macOS 15 SDK, so they no longer compile against it ([WebKit bug][webkit-obsolete]).
  - Chromium's source says the CGWindowList API is not supported for snapshots on macOS 26 and switches to SCK there ([Chromium snapshot_mac.mm][chromium-snapshot]).
  - In some cases on macOS 27 betas the call returns grey images ([forum thread 849969][forum-849969]).
- **Recommendation:** set Glimpse's minimum to macOS 14 (SCK screenshot plus stream), or to 12.3 if the stream-only fallback is worth carrying. Don't use the CG APIs.
- `SCShareableContent` is fetched once and cached: it is slow, and it is the call that triggers TCC.
- `SCContentFilter(display:excludingWindows:)` is also where GLIM-16 will pass Glimpse's own windows.

## macOS Screen Recording permission on unsigned builds

### How detection works

| API | What it tells you |
|---|---|
| `CGPreflightScreenCaptureAccess()` | `true` only if *this process* is allowed. Never prompts. The result is effectively fixed for the life of the process, so after a grant the app must be relaunched (macOS offers "Quit & Reopen"). |
| `CGRequestScreenCaptureAccess()` | Shows the system prompt only while the state is *not determined*; after that it returns `false` silently. It returns immediately. The user then turns the toggle on in System Settings › Privacy & Security › Screen & System Audio Recording. |
| SCK errors | `SCStreamError.userDeclined` (-3801) when access is not permitted. |

- No public API tells *denied* apart from *not determined*, and reading `TCC.db` needs Full Disk Access.
- So the spike, and Glimpse, must persist "have we asked before" and derive a tri-state in `src/core/permission.ts`:
  - `granted`
  - `not-determined`
  - `denied-or-restart-needed`: denied, just granted and waiting for a relaunch, or granted to a different signature.
- Electrobun's `Utils.screenCapture` exposes the same two calls plus `openSettings()`.

### Who TCC thinks the app is

1. **Responsible process.** TCC charges access to the app that launched the process tree.
   - The CLI run from Terminal uses Terminal's grant.
   - A Glimpse sidecar or helper launched by Glimpse.app would use Glimpse's grant.
   - Permission tests must therefore launch the `.app` via LaunchServices (`open` or Finder), which is why TESTING.md insists on it.
2. **Code identity = designated requirement (DR).** TCC stores a code requirement with each grant and checks the running code against it.
   - Apple DTS (Quinn): "macOS tracks code identity using the code's designated requirement. Ad hoc signed code does not include a stable DR, and thus macOS is unable to tell that version N+1 of your app is the 'same code' as version N." Ad-hoc signing "will cause problems if you're building a Mac app that you intend to distribute widely" ([forum 795739][quinn-adhoc]; background in [TN3127 Inside Code Signing: Requirements][tn3127]).
   - For ad-hoc code the DR is `cdhash H"…"`. Any change to the executable or its sealed resources, including our bundled JS, changes the cdhash.
3. **What Electrobun produces.**
   - Hutch's dev builds skip signing; the native executables carry only the ad-hoc/linker signature from their toolchain.
   - Hutch's own signing runs only for canary/stable builds, needs `ELECTROBUN_DEVELOPER_ID`, and is documented for a *Developer ID Application* identity ([Electrobun code-signing guide][eb-signing]).
   - Windows signing is not part of Hutch's pipeline at all.
   - An "unsigned" Glimpse release built with Hutch is therefore an **ad-hoc-signed** app.

### Consequences for an ad-hoc / unsigned Glimpse

- **First run:** prompt → user turns the toggle on → Quit & Reopen → capture works.
- **Restarts:** the grant persists.
- **Every update, because the cdhash changes:**
  - The stored grant no longer matches the new code, so Glimpse sees `preflight=false`.
  - System Settings may still show the toggle **on**: a stale entry for the old signature.
  - Users typically have to toggle it off and on, or remove it with "−" and add it again. Steps P6/P7 record exactly what is needed.
  - This repeats on every release and is a real onboarding cost.
- A developer reports the same symptom in [forum 795739][quinn-adhoc].

### Mitigations, cheapest first

1. **Stable self-signed code-signing identity (free).**
   - Create one certificate, keep its private key in CI secrets, and sign every release with it (`codesign --force --sign "<identity>"`, inside-out).
   - The DR becomes `identifier "<bundle id>" and certificate leaf = H"<cert hash>"`, which stays the same across builds, so TCC should treat an update as the same app. Steps P8–P10 test this hypothesis.
   - It does **not** help with Gatekeeper: a self-signed app is still from an unidentified developer and needs "Open Anyway" once per download.
   - I found no Apple statement that endorses or rules out self-signed identities for TCC. Third-party guides recommend exactly this for local builds that keep losing Screen Recording. The test decides.
   - Risk: if the key is lost or rotated, every user has to re-grant once.
2. **Apple Developer ID (paid).** A stable DR anchored to Apple makes TCC persistence work. It also allows notarization, which removes the Gatekeeper bypass, and Hutch supports it out of the box. It is the "proper" answer if the project accepts the cost and the identity.
3. **Ship ad-hoc and explain.** Onboarding detects `preflight=false` after an update and walks the user through re-granting, including removing the stale entry. It works, but it is the worst UX.

### Other permission behaviour to expect

- **macOS 15 Sequoia+ periodic re-confirmation:**
  - Apps that capture the screen without the system picker (`SCContentSharingPicker`) get a recurring alert: "… is requesting to bypass the system private window picker and directly access your screen and audio".
  - It was weekly in the betas and shipped as **monthly** ("Allow For One Month") ([TidBITS][tidbits-monthly]; [9to5Mac][9to5-monthly]; [forum 765103][forum-765103]).
  - Glimpse's region-picker flow cannot use the system picker, so **expect this to apply to Glimpse**, signed or not (P14). Design and onboarding copy need to plan for it.
- **macOS 26 Tahoe:**
  - The settings pane is named *Screen & System Audio Recording*.
  - Reports say *plain executables* (outside any .app) stopped appearing in the list in 26.1 ([forum 807898][forum-807898]).
  - That is another reason Glimpse must capture from inside its .app bundle and never from a helper binary outside it.
- **Revocation while running:** expect running streams to stop with an error and new SCK calls to fail. `CGPreflight` may keep returning the cached `true` until relaunch (P12).

## What was verified here (headless Linux) and what wasn't

| Verified here | How |
|---|---|
| Bun 1.4.4 + Electrobun 2.0.5 (Hutch) install; devkit prepare | `bun install`, `electrobun prepare` |
| TypeScript typechecks against the real Electrobun API (`Screen`, `Utils.screenCapture`, `BrowserWindow`) | `tsc -p .` clean |
| Electrobun app **builds** for Linux and bundles the main process; the `import.meta.dir`-relative lookup of the native library survives bundling | `electrobun build` → `build/dev-linux-x64/` |
| Windows DLL **compiles and links** for x86_64-windows-gnu, importing only system DLLs and UCRT; all 8 exports present | `zig c++` cross-compile with `-Wall -Wextra` (only the usual `GetProcAddress` cast warnings) |
| WinRT interface IIDs and vtable order | Checked against windows-rs metadata (`Windows.Graphics.Capture`, `windowsgraphicscaptureinterop`, Direct3D11 interop) |
| Geometry, stats, loop/drop accounting, PNG, tensor conversion, permission tri-state, codesign parsing | 37 unit tests (`bun test`) |
| The real `bun:ffi` binding (15 mixed-type args), multi-display composition into one buffer, error propagation, suite output | `test/ffi.test.ts` against `native/fake/fakecapture.c` |
| What Electrobun's built-in capture does on each OS | Read Electrobun's native source at v2.0.5 (`nativeWrapper.mm`, `nativeWrapper.cpp`) |

| Not verified (needs the manual run) |
|---|
| Any real capture: pixel correctness, latency, CPU, dropped frames |
| The Swift library compiling at all (no macOS toolchain here). Small fix-ups may be needed on the first build. |
| The Windows DLL running: COM/WinRT calls, DXGI recovery, WGC border behaviour |
| The Electrobun window and its `host-message` command channel at runtime, on Windows and macOS |
| Every TCC behaviour above (P1–P15), above all the self-signed hypothesis (P9) |
| Whether SCK calls from Bun's thread inside the Electrobun app ever hit the 3 s timeout (M4) |

## Gaps and risks

- **CPU numbers cover only the Bun process.** Compositor-side cost (dwm.exe, WindowServer, replayd) is not counted; TESTING.md asks for a manual check in Task Manager / Activity Monitor.
- **Not handled:**
  - Rotated monitors: DXGI returns an error.
  - HDR / wide-gamut outputs: DXGI `DuplicateOutput` converts to BGRA8; WGC and SCK are asked for BGRA/sRGB.
  - DXGI's hardware-cursor overlay: never in the image, which is what Glimpse wants anyway.
  - WGC frame-pool resize after a resolution change: the texture is re-created, the pool isn't.
- A Windows capture blocks the JS thread while it runs. At 4 fps with captures under 10 ms that is fine. 1080p GDI may be too slow for that; if so, move it to a worker.
- **Electrobun specifics not explored:**
  - Launching the .app with CLI args (the spike uses its window instead).
  - Whether `electrobun dev` launches through LaunchServices. Permission tests use `build` + `open` to be safe.
- The WGC and DXGI sessions keep a GPU device per monitor alive. Release them when Live mode stops (`gc_reset`).

## Expected outcome per OS

| OS | Expected | Why |
|---|---|---|
| **Windows** | **Pass** | DXGI/GDI give border-free region capture into a Bun buffer with low latency, and mixed DPI is handled in physical px. Caveat: the WGC border is probably not removable for an unpackaged app, so WGC is a fallback only. Electrobun's built-in capture: **fail** (GetPixel per pixel). |
| **macOS** | **Partial**; **pass** if P9 holds | SCK capture at native resolution should work from inside the Electrobun .app. Permission is the weak spot: ad-hoc builds lose the grant on every update, and a stable self-signed signature (or a Developer ID) is expected to fix that. The monthly Sequoia re-prompt applies either way. Electrobun's built-in capture: **fail** (1x only, deprecated, broken on macOS 26+). |

Capture needs neither a Rust sidecar nor Tauri on either OS: a small FFI-loaded native library per OS is enough. That approach also fits GLIM-16, where exclusion is a filter argument on SCK and a window flag on Windows.

## Sources

- Apple DTS (Quinn), "Why does my app lose Screen Recording permission after updating (adhoc signature)?": [developer.apple.com/forums/thread/795739][quinn-adhoc]
- Apple, TN3127 Inside Code Signing: Requirements: [developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements][tn3127]
- Apple, `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`: [cgpreflightscreencaptureaccess()][cg-preflight], [cgrequestscreencaptureaccess()][cg-request]
- Apple, `SCScreenshotManager`: [developer.apple.com/documentation/screencapturekit/scscreenshotmanager][sck-shot]
- Electrobun code-signing guide (Hutch signs only canary/stable builds, with `ELECTROBUN_DEVELOPER_ID`): [code-signing.mdx][eb-signing]
- Electrobun v2.0.5 native capture implementations: [macOS nativeWrapper.mm][eb-mac], [Windows nativeWrapper.cpp][eb-win]
- Microsoft, `GraphicsCaptureSession.IsBorderRequired`: [learn.microsoft.com … isborderrequired][wgc-border]; `GraphicsCaptureAccess.RequestAccessAsync`: [learn.microsoft.com … requestaccessasync][wgc-access]
- Handmade Network, wcap thread (border removable via `IGraphicsCaptureSession3` without the request; anecdotal): [handmade.network/forums/t/8701-wcap/2][handmade]
- Microsoft, Desktop Duplication API: [learn.microsoft.com … desktop-dup-api][dxgi-dup]
- TidBITS, "Apple Reduces Excessive Sequoia Permission Requests, Shifts to Monthly": [tidbits.com][tidbits-monthly]; 9to5Mac: [9to5mac.com][9to5-monthly]
- Apple forums, the "App is Requesting to Bypass System Private Window Picker" alert: [thread 765103][forum-765103]
- Apple forums, plain executables missing from the Screen Recording list on macOS 26.1: [thread 807898][forum-807898]
- WebKit, "CGWindowListCreateImage is unavailable: obsoleted in macOS 15.0": [lists.webkit.org][webkit-obsolete]
- Chromium `ui/snapshot/snapshot_mac.mm` ("On macOS 26, the CGWindowList API is not supported for snapshots"): [chromium.googlesource.com][chromium-snapshot]
- Apple forums, "ScreenCaptureKit is NOT a full replacement for CGWindowListCreateImage" (grey images on macOS 27 betas): [thread 849969][forum-849969]
- SCK screenshot latency report: [developer.apple.com/forums/tags/screencapturekit][sck-latency]
- windows-rs metadata used to check the IIDs: [github.com/microsoft/windows-rs … metadata][windows-rs]

[quinn-adhoc]: https://developer.apple.com/forums/thread/795739
[tn3127]: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
[cg-preflight]: https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()
[cg-request]: https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()
[sck-shot]: https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager
[eb-signing]: https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/code-signing.mdx
[eb-mac]: https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/native/macos/nativeWrapper.mm
[eb-win]: https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/native/win/nativeWrapper.cpp
[wgc-border]: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
[wgc-access]: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscaptureaccess.requestaccessasync
[handmade]: https://handmade.network/forums/t/8701-wcap/2
[dxgi-dup]: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api
[tidbits-monthly]: https://tidbits.com/2024/08/19/apple-reduces-excessive-sequoia-permission-requests-shifts-to-monthly
[9to5-monthly]: https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/
[forum-765103]: https://developer.apple.com/forums/thread/765103
[forum-807898]: https://developer.apple.com/forums/thread/807898
[webkit-obsolete]: https://lists.webkit.org/pipermail/webkit-unassigned/2024-August/1177206.html
[chromium-snapshot]: https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7632.159/ui/snapshot/snapshot_mac.mm
[forum-849969]: https://developer.apple.com/forums/thread/849969
[sck-latency]: https://developer.apple.com/forums/tags/screencapturekit?page=4
[windows-rs]: https://github.com/microsoft/windows-rs/tree/master/metadata
