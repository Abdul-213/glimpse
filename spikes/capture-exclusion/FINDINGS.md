# GLIM-16 spike: OS-level capture exclusion, findings

Status: built and checked on headless Linux only. **Not yet run on Windows or macOS.** The user runs `TESTING.md` on real machines, and the results table there takes precedence over the expectations below.

Electrobun source read at tag `v2.0.5` ([`d06abc9`](https://github.com/blackboardsh/electrobun/tree/d06abc9edf0b4e55116129cabbfe17bf89e11791)), the release the spike pins. Upstream `main` is `3c4b81a` (2026-10-29), the same commit the GLIM-14 hotkey spike read. A code search there for `SetWindowDisplayAffinity` and `sharingType` found nothing new.

## 1. Electrobun and capture exclusion

**Electrobun has no capture-exclusion API.** At v2.0.5 there is no `sharingType`, `SetWindowDisplayAffinity`, `setContentProtection` or ScreenCaptureKit anywhere in the native code (`package/src/native/{macos,win,linux}`). The only hit is a desktop smoke-test script that *reads* `GetWindowDisplayAffinity`. So Glimpse has to do this itself, but the raw handle is available:

- **`BrowserWindow.ptr`** ([`BrowserWindow.ts` L142](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/sdks/main/core/BrowserWindow.ts#L142)) calls `getWindowPointer` ([`core/main.zig` L2898](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/core/main.zig#L2898)). That returns whatever the native `createWindowWithFrameAndStyleFromWorker` returned:
  - **Windows:** the top-level **`HWND`** ([`win/nativeWrapper.cpp` L11309](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/native/win/nativeWrapper.cpp#L11309)). It is created on Electrobun's main GUI thread, with `WS_EX_APPWINDOW`, plus `WS_EX_LAYERED` when `transparent: true` (L11383).
  - **macOS:** the **`NSWindow *`** ([`macos/nativeWrapper.mm` L9036](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/native/macos/nativeWrapper.mm#L9036)). Its `windowNumber` is the `CGWindowID`, which is also `SCWindow.windowID`.
- `setAlwaysOnTop(true)` is `NSFloatingWindowLevel` on macOS (L9235) and the topmost flag on Windows.
- **Electrobun does have a capture API, `Screen.captureRegion(rect)`** (RGBA, logical coordinates). It isn't suitable for Glimpse:
  - **macOS:** it is **`CGWindowListCreateImage`** at nominal resolution ([L10654](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/native/macos/nativeWrapper.mm#L10654)). That API is *obsoleted* in the macOS 15 SDK, has no exclusion filter, and only gives 1x pixels on Retina, which is bad for OCR. Reading the code, the flipped CTM before `CGContextDrawImage` may also leave rows upside down (TESTING M5 checks).
  - **Windows:** it calls **`GetPixel` once per pixel** on the screen DC ([L14122](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/native/win/nativeWrapper.cpp#L14122)). That's correct, and because it's GDI it respects display affinity, but it's far too slow for Live mode's 2–4 fps. Glimpse needs its own capture path on both OSes (see GLIM-15).

## 2. Windows: `WDA_EXCLUDEFROMCAPTURE`

**Approach in the spike.** Plain `bun:ffi` into `user32.dll`: `SetWindowDisplayAffinity(popup.ptr, 0x11)`, then a `GetWindowDisplayAffinity` read-back. **No native helper library is needed**, unlike the macOS side and the GLIM-14 Carbon hotkeys. The [docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) only require a top-level window that "must belong to the current process". There's no same-thread rule, so calling from Electrobun's Bun worker thread on an HWND owned by the main thread is allowed. The spike also checks `GetAncestor(GA_ROOT) == hwnd` and that the window belongs to this process (`GetWindowThreadProcessId`), and shows both.

**What the API does** (documentation and widely reported behaviour, not yet seen on our machines):

- `WDA_EXCLUDEFROMCAPTURE` (0x11, Windows 10 2004 / build 19041+) removes the window from the composed image that capture APIs receive. The window stays visible on the physical monitor, and **whatever is behind it shows through** in captures. That is exactly what Live mode needs: Glimpse captures the game text *under* its own popup.
- It applies to **every capture API that reads the DWM-composed desktop**:
  - GDI `BitBlt`/`GetPixel` on the screen DC;
  - **DXGI Desktop Duplication**;
  - **Windows.Graphics.Capture** (WGC; a window capture of the excluded window itself gives black or nothing);
  - and so to every tool built on them: **Snipping Tool, PrtScn, ShareX, OBS (all methods), Teams/Zoom/Meet/Discord screen share, Xbox Game Bar**.

  It is DWM-level, not per-caller, so **there is no way to exclude a window from Glimpse's capture but keep it in the user's own screenshots**.
- Requires DWM composition, which is always on in Windows 8+.
- On builds before 19041 the value silently acts as `WDA_MONITOR`, which shows a **black rectangle**. That's fatal for Live mode, because OCR would read a black box and diffs would flicker. Glimpse 1.0 should require build 19041+ on Windows. Windows 10 2004 is from 2020, and Windows 10 itself is out of support since 2025-10.
- Not a security boundary (Microsoft: "no guarantee"). A photo of the screen still works. Not every path is clear either: some RDP and Miracast/projection setups may still show the window (TESTING W14).
- `WS_EX_LAYERED` (Electrobun's transparent windows) is expected to work on Windows 10+. W12 checks the transparent variant specifically, because the picker overlay will be one.

**Glimpse's capture in the spike.** `BitBlt(SRCCOPY|CAPTUREBLT)` of the whole virtual screen into a DIB through `bun:ffi` (`src/bun/win32.ts`), plus Electrobun's `Screen.captureRegion` around the popup. WGC and DXGI are covered with OBS's capture-method selector (W8), not with in-app code. Calling them from `bun:ffi` means COM/WinRT vtables, which is a lot of code for a spike. The product will want WGC (fast, per-monitor) via a small native module or the Rust sidecar, and exclusion applies there identically.

## 3. macOS: `sharingType` vs ScreenCaptureKit filter

**Approach in the spike.** `native/macos/glimcapture.m` is about 300 lines of Objective-C, built into a universal `libglimcapture.dylib`, copied into the bundle and loaded with `bun:ffi`. It follows the GLIM-14 hotkey pattern:

- `glim_cx_set_sharing` / `get_sharing` / `window_number` / `window_level` take the `NSWindow*` from `BrowserWindow.ptr` and run on the main thread through `dispatch_sync_f(main queue)`. Electrobun's JS runs on a Bun Worker, and AppKit must be called on main.
- `glim_cx_capture(mode, windowID, …)` does the following:
  - fetches fresh `SCShareableContent` on every capture;
  - finds this process's `SCRunningApplication` (by `getpid()`) and the popup's `SCWindow` (by `windowNumber`);
  - builds an `SCContentFilter` per display, in one of three modes: **exclude the popup window**, **exclude the whole app**, or **no exclusion**;
  - captures with `SCScreenshotManager captureImageWithFilter:` (macOS 14+) at full pixel resolution (`contentRect × pointPixelScale`);
  - converts to sRGB RGBA, so the magenta/green detection survives P3 displays.

  The calling worker thread blocks on a semaphore while ScreenCaptureKit's completion handlers run on its own queues, and the main thread is never involved, so there is no deadlock risk. The function also reports which of our windows SCK lists.

**What `sharingType = .none` does, and macOS 15+.**

- On macOS ≤ 14, `NSWindowSharingNone` keeps the window out of `CGWindowListCreateImage` and, by most reports, out of ScreenCaptureKit captures by other apps. Screen sharing then showed what was behind it.
- On **macOS 15 (Sequoia) and later, multiple independent reports say ScreenCaptureKit ignores `sharingType`**, and SCK is what Cmd+Shift+3/4/5, `screencapture`, OBS, QuickTime and browser/WebRTC screen sharing use. So the window shows up in other apps' captures anyway:
  - [tauri#14200](https://github.com/tauri-apps/tauri/issues/14200) (open, `status: upstream`, "no known workaround").
  - [electron#48258](https://github.com/electron/electron/issues/48258) (closed "not planned"). An Electron maintainer called it "an intentional and known change to macOS".
  - An app-level bug in [goat#1321](https://github.com/goat-si/goat/issues/1321) that was fixed by excluding the app's own windows in its SCK filter.

  One [write-up](https://raoufabedini.dev/write-ups/invisible-window-research) claims exclusion still held on macOS 26.3.1. But it tested `CGWindowListCreateImage` and `screencapture`, not other SCK clients, so the evidence conflicts. **I found no Apple documentation that settles it.** Most evidence says: on 15+, `sharingType = .none` reliably affects only legacy CoreGraphics capture. TESTING M4/M7/M8/M9 measure it directly.
- **For Glimpse's own capture this doesn't matter.** An `SCContentFilter` that lists our windows in `excludingWindows:` (or our app in `excludingApplications:`) is the documented, public way to keep them out of a capture *we* make. It doesn't depend on `sharingType`. The risks are small and testable:
  1. The window must be in `SCShareableContent` to be excluded by window. The spike reports `popupInShareableContent` (M2). If `sharingType = .none` ever hides a window from that list, use `excludingApplications:` (M3), which excludes every Glimpse window by process.
  2. A newly created popup needs fresh shareable content, or an updated stream filter (`SCStream updateContentFilter:`) for a running Live stream. The spike re-queries on every capture. The product must refresh the filter whenever a popup is created.
  3. Screen Recording (TCC) permission is required either way. That's GLIM-15's problem (unsigned builds may lose the grant; 15+ shows periodic re-confirmation prompts, reported but not verified here).
- **Excluding the whole app vs single windows.** `excludingApplications:[self]` is simplest and covers the picker, Snip popup and Live popup, plus any future window, with no IDs to track. Glimpse never needs to capture its own windows, so **app-level exclusion is the recommended default**.

## 4. Verified here (headless Linux x64) vs not

Verified:

- Bun 1.4.4 (already in `~/.bun`). `bun install` and `electrobun prepare` fetched the Electrobun 2.0.5 devkit.
- `bun test`: **25 tests, 78 assertions pass**. They cover:
  - the PNG encoder (CRC check value, IHDR fields, IDAT inflate round-trip, IEND);
  - BGRA→RGBA conversion;
  - magenta/green marker counting, including colour-managed values;
  - every verdict branch: PASS, FAIL, black capture, control window missing, exclude-app, observe;
  - per-display merging;
  - rectangle maths for the region under the popup (clipping across monitors);
  - the Windows build gate (19041) and the expected result per affinity;
  - Win32 error text, `sharingType` names, macOS version parsing;
  - per-method expectations and file names.
- `tsc --noEmit` (TypeScript 5.9) passes against the Electrobun 2.0.5 devkit types: `BrowserWindow.ptr`, `setAlwaysOnTop`, `titleBarStyle: "hidden"`, `Screen.captureRegion/getAllDisplays`, `Utils.screenCapture`, and the `bun:ffi` signatures.
- `electrobun build --env=dev` succeeds for `linux-x64`. The bundle contains the Windows and macOS code paths.
- **`glimcapture.m` was semantically checked against the real macOS 15.5 SDK headers** (libclang 18, `-x objective-c -fobjc-arc -fblocks -target arm64-apple-macos14.0 -Wall -Wextra -Wunguarded-availability-new`): **0 diagnostics**. Every selector, property and type (`SCContentFilter initWithDisplay:excludingApplications:exceptingWindows:`, `pointPixelScale`, `SCScreenshotManager`, `SCCaptureResolutionBest`, `NSWindow.sharingType`…) resolves, and nothing used is unavailable at macOS 14. A planted typo was caught, so the check is real. The x86_64 pass couldn't run because only gcc's intrinsic headers were available, which is a tool limitation, not a code problem. It was not compiled or linked.
- Read Electrobun's sources for the handle types, threading and its own capture implementation (section 1).

Not verified (needs the real OSes):

- Running anything at all. No display here.
- That `SetWindowDisplayAffinity` returns TRUE on Electrobun's HWND, and its effect on each capture API and tool (W1–W14).
- Compiling and linking the dylib, the SCK permission flow, and every macOS behaviour (M1–M13), in particular the macOS 15+ `sharingType` question (M4).
- Whether Electrobun's `transparent: true` popup renders and stays excludable on both OSes (W12, M13).
- `GetLastError` after a failed `SetWindowDisplayAffinity` may be clobbered by Bun between FFI calls. The read-back via `GetWindowDisplayAffinity` is the reliable signal.

No GitHub Actions workflow was added. Workflows only run from the repo-root `.github/workflows/`, and this spike must keep everything under `spikes/capture-exclusion/`. A CI runner has no interactive desktop worth testing capture on anyway.

## 5. Gaps and risks

- **WGC and DXGI aren't exercised in-app**, only via OBS. That's fine for the exclusion question, because both read the same composed image, but Glimpse's real capture path still needs building (GLIM-15 / sidecar decision).
- **Live mode uses a stream, not screenshots.** On macOS that means `SCStream` with the same filter type, updated with `updateContentFilter:` when popups come and go. The semantics are the same, but it's untested here.
- **Order: create hidden, exclude, then show.** The spike creates the popup with `hidden: true`, applies the affinity / `sharingType`, then calls `showInactive()`, so it is never visible un-excluded. This is the pattern the product should use (and, on macOS, refresh the SCK filter before the popup's first frame). Whether `SetWindowDisplayAffinity` on a not-yet-shown Electrobun HWND sticks is checked by W1/W11; if the popup fails to appear or shows up in the first capture, apply after show instead.
- **macOS 26:** treat the results of M4/M7/M9 on 26 as the ground truth; the public reports conflict.

## 6. Product implications

1. **Windows: excluded popups disappear from *every* capture, the user's included.** Users can't screenshot or screen-share a Glimpse translation: the popup is invisible in Snipping Tool, ShareX, OBS and Teams/Zoom shares. People *will* want to share a translation ("look what this says"), and support reports like "Glimpse doesn't show in my stream" are likely. Recommendations:
   - **Snip mode:** the translation already goes to the clipboard. Add a **"Copy as image"** / "Save image" action that renders the popup itself (Glimpse draws it from its own state, no screen capture needed).
   - **A setting: "Hide Glimpse from screenshots and screen sharing"**, default **on**. Turning it off would let Live mode OCR its own popup, so when it's off Glimpse must still keep its own capture clean another way: mask the popup's rect out of every frame before diffing and OCR, or pause capture while the popup overlaps the region. A docked Live popup sits *next to* the region, so masking is usually trivial. The picker overlay is only shown while no capture is running.
   - Explain it once in the UI (a tooltip on the setting, and in the docs/FAQ): "Glimpse windows are hidden from screenshots, recordings and screen sharing."
   - Streamers who *want* the translation on stream turn the setting off.
2. **macOS: the reverse.** Glimpse's own capture is clean via the SCK filter regardless of `sharingType`. On 15+ the popups will probably still **appear** in the user's screenshots and screen shares even with `sharingType = .none`. Recommendations:
   - Set `sharingType = .none` anyway: it's harmless, and it covers legacy CG capturers and macOS 14. But **don't promise hiding** in the UI copy on macOS; the same setting's honest label there is "best effort".
   - **Don't rely on `sharingType` for Glimpse's own capture.** Always pass the app in `excludingApplications:`.
3. **Privacy angle.** On Windows, exclusion also means a translation of a sensitive document doesn't leak into a meeting's screen share. That's a small plus for the privacy-conscious users, but on macOS 15+ it likely doesn't hold. Document per OS; never claim it as a security feature.
4. **Minimum OS.** Windows 10 2004 (build 19041). Below that, refuse Live mode, or fall back to masking our own rects in the captured frame. macOS 14 is required anyway by Electrobun and `SCScreenshotManager`.
5. **Architecture.** Exclusion needs very little native code: on Windows none (plain `bun:ffi`), on macOS a small dylib that is really part of the SCK capture module GLIM-15 needs anyway. **Capture exclusion doesn't argue against Electrobun.** It does reinforce that Glimpse needs its own native capture module per OS (Electrobun's `Screen.captureRegion` is too slow on Windows and legacy-only on macOS). If a Rust sidecar is chosen, keep two things in mind:
   - **Windows:** the affinity call must be made **in the Electrobun process**, which owns the HWND. The API refuses windows of other processes, so the sidecar can't do it.
   - **macOS:** the sidecar's SCK filter must exclude **the Electrobun process's app** (by pid or bundle id), not the sidecar's own.

## 7. Expected results per OS (before real testing)

| OS | Expected | Why |
|---|---|---|
| **Windows 10 2004+ / 11** | **Pass** | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on `BrowserWindow.ptr` is a documented, single-call API with no thread requirement, and it removes the window from GDI, DXGI and WGC captures alike (so from Glimpse's capture). The surprise is product-side, not technical: the popup also vanishes from every user tool and screen share (section 6). Risk: the transparent/layered variant (W12). |
| **Windows < 2004** | **Fail** (unsupported) | Falls back to `WDA_MONITOR`, which leaves a black box in captures. Require build 19041. |
| **macOS 14** | **Pass** | The SCK filter excludes our windows from Glimpse's capture. `sharingType = .none` should also hide them from other apps. |
| **macOS 15+ (incl. 26)** | **Pass for Glimpse's own capture; partial overall** | The SCK `excludingWindows`/`excludingApplications` filter is public and reliable for our own capture, which is the requirement. `sharingType = .none` very likely doesn't hide the popup from Cmd+Shift+3/4/5, OBS or screen sharing (M4/M7–M9 expected *present*). That's acceptable for Glimpse (arguably better for users), but it makes behaviour differ from Windows. |

## Sources

- Microsoft, [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)
- [tauri-apps/tauri#14200: macOS 15+: ScreenCaptureKit ignores setContentProtection / NSWindow.sharingType](https://github.com/tauri-apps/tauri/issues/14200)
- [electron/electron#48258: setContentProtection visible in screen sharing on macOS](https://github.com/electron/electron/issues/48258)
- [goat-si/goat#1321: exclude own windows from SCK captures (setContentProtection ignored)](https://github.com/goat-si/goat/issues/1321)
- [Electron commit: hide content-protected windows with ScreenCaptureKit](https://ayakael.net/mirrors/electron/commit/fd88908457a986f06e310e80499e4b2775d8ba70)
- [Invisible-window research write-up (conflicting macOS 26 claim)](https://raoufabedini.dev/write-ups/invisible-window-research)
- [Apple forum: CGWindowListCreateImage → ScreenCaptureKit](https://developer.apple.com/forums/thread/740493)
- [MacPorts #71136: CGWindowListCreateImage obsoleted in macOS 15 SDK](https://trac.macports.org/ticket/71136)
