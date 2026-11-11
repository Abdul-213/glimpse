# GLIM-16 spike: OS-level capture exclusion, test plan

This is a throwaway spike. It answers one question: can an Electrobun window (Glimpse's Snip popup, Live docked popup, picker overlay) stay **visible on screen** while being **absent from Glimpse's own screen captures**? If it can't, Live mode would OCR its own translations.

| | Windows | macOS |
|---|---|---|
| How the popup is excluded | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` via `bun:ffi` on Electrobun's `BrowserWindow.ptr` (the HWND) | Glimpse's own capture: ScreenCaptureKit `SCContentFilter(display:, excludingWindows: [popup])`. Third-party captures: `NSWindow.sharingType = .none`. Both go through `native/macos/glimcapture.m` (dylib + `bun:ffi`) on `BrowserWindow.ptr` (the `NSWindow*`) |
| Glimpse's capture in this app | GDI `BitBlt` of the whole virtual screen, plus Electrobun's `Screen.captureRegion` | `SCScreenshotManager` (3 filter variants), plus Electrobun's `Screen.captureRegion` (this is legacy `CGWindowListCreateImage`) |
| Minimum OS | Windows 10 2004 (build 19041) for `WDA_EXCLUDEFROMCAPTURE` | macOS 14 (Electrobun 2.x and `SCScreenshotManager`) |

## What the app shows

- **Control window** ("NOT excluded"): a normal Glimpse window with a big **green** panel at the top. It must appear in every full-screen capture. That proves the capture saw our windows at all, so an empty or black capture can't pass by accident.
- **Popup**: a borderless, always-on-top **magenta** window that sits over the green panel. It must stay visible on screen and be missing from Glimpse's captures.
- **Buttons**:
  - exclusion toggles (Windows: `WDA_EXCLUDEFROMCAPTURE` / `WDA_MONITOR` / `WDA_NONE`; macOS: `sharingType = none` / `readOnly`, plus Screen Recording permission helpers);
  - **Recreate popup**, one **Capture:** button per capture method, **Run all captures**, **Run all in 5 s** (gives you time to bring another app forward or open a menu), **Move popup to next display**, **Popup back over green panel**, **Open captures folder**.
- **Automatic verdict per capture.** The app counts magenta and green pixels in the captured image:
  - `PASS`: matches the expectation (normally: magenta absent, green present).
  - `FAIL`: the excluded popup is in the capture, or a window that should be gone is there.
  - `INCONCLUSIVE`: the capture is black, or the green control window is missing too (permission problem, or the capture didn't see our windows).
  - `OBSERVED`: no expectation; this is one of the open questions (for example "does `sharingType = none` alone hide the popup from ScreenCaptureKit?").
- **Files**: every capture is saved as a PNG, and every action and result goes to `spike.log`, in:
  - Windows: `%USERPROFILE%\glimpse-capture-spike\`
  - macOS: `~/glimpse-capture-spike/`
  - Override with `GLIM_CAPTURE_DIR`.

  **Always open the PNGs and look at them yourself.** The pixel count is a convenience, not proof.
- **Diagnostics pane**: OS version and build, the popup's `ptr`, and HWND facts (top-level? owned by this process? `GetWindowDisplayAffinity` read-back, DPI awareness) or NSWindow facts (`windowNumber`, `level`, `sharingType` read-back, Screen Recording permission, the app's own windows as ScreenCaptureKit lists them).

Launch options (environment variables):

| Variable | Effect |
|---|---|
| `GLIM_EXCLUSION=off` | Start with the popup **not** excluded (`WDA_NONE` / `sharingType = readOnly`). Default is on. |
| `GLIM_POPUP_TRANSPARENT=1` | Create the popup with `transparent: true`. On Windows, Electrobun makes transparent windows `WS_EX_LAYERED`, which is what Glimpse's picker overlay will be. |
| `GLIM_CAPTURE_DYLIB=/path` | macOS: load the dylib from a custom path. |

---

## Build and run: Windows

Prerequisites:

- Windows 10 2004+ or Windows 11, x64 (arm64 should work too).
- WebView2 Runtime. Windows 11 has it; on Windows 10, get it from https://developer.microsoft.com/microsoft-edge/webview2/.
- Git.
- Bun 1.4.x: `powershell -c "irm bun.sh/install.ps1 | iex"`, then open a new terminal.
- No C compiler is needed. Everything on Windows is `bun:ffi` into `user32` / `gdi32`.
- For the checks: OBS Studio (https://obsproject.com), ShareX (https://getsharex.com), and a video-call app with screen sharing (Teams, Zoom, Google Meet in Chrome or Edge, or Discord).

```powershell
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse
git checkout glim-16-capture-exclusion-spike
cd spikes\capture-exclusion
bun install
bun --bun run prepare:devkit   # first run downloads Hutch + Electrobun 2.0.5 into %USERPROFILE%\.hutch
bun test                       # pure-logic unit tests (25 tests)
bun --bun run typecheck
bun --bun run dev              # builds build\dev-win-*\ and launches it, logs in this terminal
```

To start without exclusion: `$env:GLIM_EXCLUSION="off"; bun --bun run dev`. For the transparent popup: `$env:GLIM_POPUP_TRANSPARENT="1"; bun --bun run dev`. Run `Remove-Item Env:GLIM_EXCLUSION` (or `Env:GLIM_POPUP_TRANSPARENT`) to clear one again.

## Build and run: macOS

Prerequisites:

- macOS 14 or later, Apple Silicon or Intel. Test on **macOS 15.x and/or 26.x** if at all possible. The `sharingType` question below is about 15+.
- Xcode Command Line Tools: `xcode-select --install`. This provides `clang` and the macOS SDK for the dylib.
- Bun 1.4.x: `curl -fsSL https://bun.sh/install | bash`.
- For the checks: OBS Studio, and a video-call app (Zoom, Teams, Google Meet in Chrome or Safari, FaceTime screen sharing, or Discord).

```bash
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse && git checkout glim-16-capture-exclusion-spike
cd spikes/capture-exclusion
bun install
bun --bun run prepare:devkit   # first run downloads Hutch + Electrobun 2.0.5 into ~/.hutch
bun test
bun --bun run typecheck
bun run native:mac             # builds native/macos/build/libglimcapture.dylib (universal)
bun --bun run build            # builds build/dev-macos-*/…app and copies the dylib into it
open build/dev-macos-*/*.app   # launch like a real app
```

> **Screen Recording permission.** On first launch the app calls `CGRequestScreenCaptureAccess`. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then **quit and relaunch** the app (macOS only applies the grant after a restart). Launch with `open`, not from Terminal. If you start the app from Terminal (`bun run dev`), macOS attributes the permission to Terminal, which may already have it.
>
> Reset the permission between runs: `tccutil reset ScreenCapture dev.glimpse.spike.captureexclusion`. The bundle id may get a channel suffix; check the `.app`'s `Info.plist` if the reset does nothing. Unsigned and ad-hoc builds may lose the grant after every rebuild. Note it if that happens (check M12).

---

## Manual checklist

Before each section, click **Popup back over green panel** and confirm the popup is visible on screen. "Glimpse's capture" means the in-app **Capture:** buttons. Write the result in the table at the end. Note anything surprising, even when the check passes.

### Windows

| # | Check | Expected |
|---|---|---|
| W1 | Launch. Read the Diagnostics pane. (The popup is created hidden, excluded, then shown, as the product would do.) | Windows build ≥ 19041. `HWND top-level=true`, `ownedByThisProcess=true`. `last exclusion call: SetWindowDisplayAffinity(0x11) -> TRUE, GetWindowDisplayAffinity -> 0x11`. The popup is visible, magenta, on top, over the green panel. |
| W2 | Click **Capture: GDI BitBlt, all monitors**, then open the PNG. | `PASS`. Green panel present, **no magenta**. Where the popup sits you see whatever is behind it (the green panel), not a black box. |
| W3 | Click **Capture: Electrobun Screen.captureRegion, popup area**. | `PASS`. No magenta. Note the time in ms (it uses `GetPixel` per pixel, so expect it to be slow; Glimpse can't use it for Live mode). |
| W4 | Click **Popup: WDA_NONE**, then **Run all captures**. | Both captures `PASS` with the popup **present** (magenta in the PNG). This proves the exclusion is what removed it. |
| W5 | Click **Popup: WDA_MONITOR**, then **Run all captures**. | The popup shows as a **black rectangle** in the PNGs (verdict `PASS`, magenta absent). That's the pre-2004 behaviour, which Glimpse must not rely on, because OCR would see a black box. |
| W6 | Back to **WDA_EXCLUDEFROMCAPTURE**. Win+Shift+S (Snipping Tool, rectangle and full-screen modes) and PrtScn. | Expected: the popup is **missing** from the snip. Note whether it's missing or black, and whether the Snipping Tool's own overlay hides it while you select. |
| W7 | ShareX: full-screen capture and region capture. If your ShareX version has a capture-method setting (GDI vs Windows.Graphics.Capture), try both. | Popup missing from all of them. |
| W8 | OBS: add **Display Capture** and switch its *Capture Method* between **DXGI Desktop Duplication** and **Windows 10 (1903 and up)** (= Windows.Graphics.Capture). Then add **Window Capture** targeting the popup window ("Glimpse popup (excluded)"), with methods *BitBlt* and *Windows 10 (1903 and up)*. | Display Capture (DXGI and WGC): popup missing, the content behind it shows. Window Capture of the popup itself: black or empty. Write down each method separately. |
| W9 | Screen sharing: share the **entire screen** in a video-call app (Teams / Zoom / Meet in Edge or Chrome / Discord). Look at what the other side sees, or the app's self-preview. Then share **only the window behind** the popup. | Popup missing from the shared screen. Name the app and its version. |
| W10 | Multiple monitors: click **Move popup to next display** (repeat for each display), then **Run all captures**. Try mixed DPI (100% + 150%) if you have it. Drag the popup across the boundary by moving the control window. | `PASS` on every display. The BitBlt PNG covers all monitors. Note any DPI offset or partial magenta. |
| W11 | Click **Recreate popup**, then capture. Also minimize and restore the control window, toggle the popup on and off with the buttons, and lock and unlock the session (Win+L), then capture again. | Exclusion survives every time (the affinity is kept on the HWND; recreate re-applies it). Note any case where the popup shows up. |
| W12 | Relaunch with `GLIM_POPUP_TRANSPARENT=1` (layered window) and repeat W1, W2 and W6. | Same as with the opaque popup. Note whether the transparent popup renders at all (that's a separate Electrobun question). |
| W13 | (If available) Windows 10 build < 19041 or a VM: launch and capture. | Diagnostics flag `build < 19041`. The popup shows as a **black box** in captures (Windows falls back to `WDA_MONITOR`). |
| W14 | (Optional) Remote Desktop into the machine, or project to a second screen with Win+P (Duplicate). | Note whether the popup appears on the remote / duplicated screen. This is the "excluded windows vanish from everything" surprise for users. |

### macOS

| # | Check | Expected |
|---|---|---|
| M1 | Launch (from `open`), grant Screen Recording, relaunch. Read the Diagnostics pane. | macOS version shown. `NSWindow windowNumber=<n>`, `sharingType=none`, `CGPreflightScreenCaptureAccess = true`. Popup visible and on top. |
| M2 | Click **Capture: SCK, exclude popup window**. | `PASS`. Green present, **no magenta**, one PNG per display. The log line `popupInShareableContent=true`; if it's `false`, that's important (the filter can't exclude a window SCK doesn't list). |
| M3 | Click **Capture: SCK, exclude own app**. | `PASS`. Both the popup **and the green control window** are missing (the whole app is excluded). |
| M4 | **The macOS 15+ question.** With `sharingType = none`, click **Capture: SCK, no exclusion**. | `OBSERVED`. Record whether the popup is **present** or **absent**. Reports say macOS 15+ ScreenCaptureKit **ignores** `sharingType`, so expect *present* on 15+ and *absent* on 14. |
| M5 | Click **Capture: Electrobun Screen.captureRegion (CGWindowListCreateImage)** with `sharingType = none`. | `OBSERVED`. Expected: popup **absent**, because the legacy CG API honours `sharingType`. Note whether it works at all on your macOS (the API is obsoleted in the macOS 15 SDK), whether it triggers any extra system prompt, and whether the image is upside down. |
| M6 | Click **Popup sharingType = readOnly** and **Run all captures**. | M2 and M3 still `PASS` (the filter doesn't depend on `sharingType`). "No exclusion" and the CG capture `PASS` with the popup **present**. This proves the toggles do something. |
| M7 | Back to `sharingType = none`. Cmd+Shift+3 (full screen), Cmd+Shift+4 (region), Cmd+Shift+5 (Screenshot app, also record a short video), and `screencapture ~/Desktop/t.png` in Terminal. | On 15+ the popup is expected to be **present** (these tools use ScreenCaptureKit). Record each tool separately. With `readOnly` it's always present. |
| M8 | OBS: **macOS Screen Capture** (ScreenCaptureKit) source in *Display* mode, then *Window* mode targeting the popup, then *Application* mode. | Write down per mode. Expected on 15+: visible in Display mode even with `sharingType = none`. |
| M9 | Screen sharing: share the **entire screen** in a video-call app (Zoom / Teams / Meet in Chrome or Safari / FaceTime SharePlay / Discord). | Write down per app. Expected on 15+: the popup is **visible** to others even with `sharingType = none`, unless the app has its own filtering. |
| M10 | Multiple monitors: **Move popup to next display** for each display, then **Run all captures**. Try a Retina + non-Retina pair. | M2 and M3 `PASS` on every display (one PNG per display). The popup is missing from the display it's on. |
| M11 | Spaces and full screen: put another app in full screen, move the popup over it if you can, and capture with **Run all in 5 s**. Also click **Recreate popup** and capture again. | Exclusion holds (the filter is rebuilt from fresh `SCShareableContent` on every capture). Note whether the popup is even visible over full-screen apps (that's a separate Electrobun window-level question for GLIM-15/overlay). |
| M12 | Rebuild (`bun --bun run build`) and relaunch without resetting TCC. | Note whether Screen Recording permission survived the rebuild (unsigned builds often lose it). Note any monthly "continue to allow" or "bypass the private window picker" prompts on macOS 15+. |
| M13 | Relaunch with `GLIM_POPUP_TRANSPARENT=1` and repeat M2–M4. | Same as with the opaque popup. |

---

## Results (fill in)

Use **pass**, **partial** or **fail**, plus notes: OS version and build, app and tool versions, and what you actually saw in the PNG.

**Windows** (version / build: ________ ; GPU: ________ ; monitors and DPI: ________ )

| # | Result | Notes |
|---|---|---|
| W1 | | |
| W2 | | |
| W3 | | |
| W4 | | |
| W5 | | |
| W6 | | |
| W7 | | |
| W8 | | |
| W9 | | |
| W10 | | |
| W11 | | |
| W12 | | |
| W13 | | |
| W14 | | |

**macOS** (version: ________ ; chip: ________ ; monitors: ________ )

| # | Result | Notes |
|---|---|---|
| M1 | | |
| M2 | | |
| M3 | | |
| M4 | | |
| M5 | | |
| M6 | | |
| M7 | | |
| M8 | | |
| M9 | | |
| M10 | | |
| M11 | | |
| M12 | | |
| M13 | | |

**Overall**

| OS | Glimpse's own capture excludes the popup | OS screenshot tools | Screen sharing | Multi-monitor | Verdict (pass / partial / fail) |
|---|---|---|---|---|---|
| Windows | | | | | |
| macOS 14 | | | | | |
| macOS 15+ | | | | | |
