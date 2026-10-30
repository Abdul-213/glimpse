# GLIM-19 window materials spike: manual test plan

This spike is throwaway code. It checks whether Electrobun can show Glimpse's Snip popup
as a **frameless, rounded, transparent window with a native material behind the webview**,
show it fast without a flash, and keep focus with the app underneath. The code was written,
unit-tested and bundled on headless Linux. **It has never run with a display**, so every
check below is still open.

Background and expected results are in [FINDINGS.md](FINDINGS.md). Electrobun is pinned to
**2.0.6-beta.2** in `hutch.config.ts`, for the same Windows transparency fix the GLIM-13
overlay spike needed.

**Please attach screenshots** for every check marked 📷, plus the log file
(`~/glimpse-materials-spike.log` / `%USERPROFILE%\glimpse-materials-spike.log`). Screenshots
of the popup over a busy, colourful background (a photo or a web page with images) show the
material best. A screen recording at 60 fps is the most useful evidence for the flash check
(#6).

## 1. Build and run

Electrobun 2.x projects are built with **Hutch**. Hutch downloads its own Bun, the prebuilt
Electrobun core and the SDK. Windows needs no C toolchain. macOS needs the Xcode Command
Line Tools for the small helper dylib.

### macOS (14 Sonoma or later; please test 15 and 26 if you can)

```bash
# 1. Xcode Command Line Tools (clang + SDK), once
xcode-select --install

# 2. Hutch (installs to ~/.hutch and adds ~/.hutch/bin to your shell rc)
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
export PATH="$HOME/.hutch/bin:$PATH"

# 3. Get the branch
git clone https://github.com/Abdul-213/glimpse.git && cd glimpse
git checkout glim-19-window-materials-spike
cd spikes/window-materials

# 4. Install, sync the devkit, build the helper dylib, run the unit tests
hutch run install
hutch electrobun sync
hutch run native:mac        # -> native/macos/build/libglimmaterial.dylib (must exist before step 5)
hutch run test

# 5. Build a dev bundle and launch it; logs stream to this terminal
hutch run start
```

If the control window says "dylib NOT loaded", step 4's `native:mac` didn't run before the
build. Run it, then `hutch run start` again.

### Windows 11 (and Windows 10 for check #11)

You need the WebView2 Runtime. Windows 11 ships with it. On Windows 10, install the
Evergreen runtime if the app shows nothing.

```powershell
# 1. Hutch
& ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))
# open a new terminal so hutch is on PATH

# 2. Get the branch
git clone https://github.com/Abdul-213/glimpse.git; cd glimpse
git checkout glim-19-window-materials-spike
cd spikes\window-materials

# 3. Install, sync, unit tests
hutch run install
hutch electrobun sync
hutch run test

# 4. Build a dev bundle and launch it
hutch run start
```

Please note your exact build (`winver`) in the results. Acrylic and Mica through
`DWMWA_SYSTEMBACKDROP_TYPE` need **22H2 (build 22621) or later**.

### What the app shows

- **Control window** (a normal titled window, top left) with buttons and drop-downs:
  - **Show / Hide / Toggle**, **Show in 3 s** (hides, waits 3 s, shows; use it for the
    focus checks), **Show with new content** (changes the popup text while hidden, then
    shows), **Latency test (20×)**.
  - **Show method**:
    - macOS: `orderFrontRegardless` (default, no activation), `alpha` (the window stays
      ordered in and only its alpha changes), `activate` (what Electrobun's `show()` does;
      expected to steal focus), `electrobun-showInactive`.
    - Windows: `electrobun-showInactive` (default), `ShowWindow-ffi` (the same Win32 calls
      made directly from Bun), `cloak` (DWM cloaking: the window stays shown and is only
      un-cloaked), `electrobun-show` (activates; expected to steal focus).
  - **Material**:
    - macOS: `popover` (DESIGN.md default), `hudWindow`, `menu`, `sidebar`,
      `windowBackground`, `underWindowBackground`, `sheet`, `glass` (`NSGlassEffectView`,
      macOS 26 only), `none`.
    - Windows: `acrylic` (DESIGN.md default, `DWMSBT_TRANSIENTWINDOW`), `mica`, `tabbed`,
      `auto`, `none`, and two undocumented `SetWindowCompositionAttribute` variants for
      Windows 10: `accent-acrylic` and `accent-blur`.
  - **Corners**:
    - macOS: `mask` (effect view `maskImage`, recommended) or `layer` (content-view layer
      `cornerRadius`).
    - Windows: DWM corner preference `round` (8 px), `roundsmall`, `donotround`, `default`.
  - **Reduce transparency**: Follow OS / Simulate on / Ignore OS.
  - **Appearance**: System / Light / Dark.
  - **Veil opacity**: 100 / **90 (DESIGN.md)** / 80 / 70 / 50 / 0 %. 0 % shows the bare
    material.
  - **DWM border** (Windows): None (the webview draws the hairline) / Default.
  - **Move to next display**, **Toggle size**, **Log diagnostics**.
  - Readouts: last show timing, latency test stats, focus check verdict, surface decision,
    OS reduce-transparency and dark-mode state, and the recent log.
- **Popup**: 400 × 240, near the top right of the primary display. It shows two mock
  Japanese → English blocks, a footer with the current material, veil and appearance, and a
  Copy button. It appears by itself about 1.5 s after launch.

### Launch options (environment variables)

Set them before `hutch run start` (bash: `GLIM_MAC_PANEL=0 hutch run start`; PowerShell:
`$env:GLIM_WIN_CHROME="hidden"; hutch run start`, and `Remove-Item Env:GLIM_WIN_CHROME`
afterwards). If one seems to have no effect, the dev launcher may not be passing it
through. Note that in your results.

| Variable | Default | Effect |
|---|---|---|
| `GLIM_MAC_PANEL` | `1` | `0` = keep Electrobun's `NSWindow`; don't re-class it to a non-activating `NSPanel` |
| `GLIM_MAC_LEVEL` | `101` | Popup window level (`3` floating, `25` status, `101` pop-up menu) |
| `GLIM_WIN_CHROME` | `hiddenInset` | `hidden` = bare `WS_POPUP` window (no DWM frame) for A/B |
| `GLIM_WIN_NOACTIVATE` | `1` | `0` = don't add `WS_EX_NOACTIVATE` |
| `GLIM_WIN_EXTEND` | `1` | `0` = skip `DwmExtendFrameIntoClientArea(-1)` |
| `GLIM_AUTOSHOW` | `1` | `0` = don't show the popup at launch |
| `GLIM_MATERIAL_DYLIB` | – | macOS: load the dylib from this path |

## 2. Manual checks

Do each check on every OS you have and record **pass / partial / fail** in section 3. Use the
defaults unless a step says otherwise (macOS: `popover`, `mask`, `orderFrontRegardless`;
Windows: `acrylic`, `round`, `electrobun-showInactive`; veil 90 %; reduce transparency
Follow OS; appearance System). After changing a drop-down, press **Hide**, then **Show**.

1. **Material visible behind content** 📷 — Put the popup over a colourful background (drag
   a photo or browser window under it). Set **Veil opacity 0 %**, then **90 %**.
   *Expected:* at 0 % the popup shows a blurred, tinted version of what's behind it (not a
   sharp see-through, not a flat colour, not black). At 90 % the text is crisp and a hint of
   the background colour comes through. Moving the window underneath updates the blur live.
   Try each material and note which looks right. On macOS 26 also try `glass`.
2. **Rounded corners** 📷 — Zoom into a corner (macOS: ⌘⇧4 screenshot and zoom in; Windows:
   Magnifier).
   *Expected:*
   - macOS: 12 px rounded corners. The blur, the veil and the shadow all follow the same
     curve, with no square blurred corner behind the rounded veil. Compare `mask` vs
     `layer`; `layer` may show square blur corners.
   - Windows 11: 8 px DWM rounded corners that match the webview's 8 px radius, with no
     light or dark wedges at the corners. Try `roundsmall` and `donotround`.
3. **Native shadow** 📷 — Over a light background.
   *Expected:* a soft system shadow around the whole popup, following the rounded shape.
   macOS: the panel shadow. Windows 11: the DWM shadow. No CSS shadow, no rectangular
   shadow behind rounded corners. Windows: also try `GLIM_WIN_CHROME=hidden` and note
   whether the shadow, corners or material disappear.
4. **Hairline** — Put the popup over a background of the same brightness (light popup on a
   white page, dark popup on a black page).
   *Expected:* the 1 px inner hairline separates the popup from the background. Windows:
   compare DWM border None vs Default; with Default there may be a double line.
5. **Show latency** — Press **Latency test (20×)** with the default show method, then with
   each other show method.
   *Expected:* the latency readout `webFrame.p50` is under 100 ms and `p95` is under 100 ms.
   This is the time from the show call until the webview has painted two frames, so it
   overstates real latency by about one RPC round trip. Also record `call` (the time the
   native show call takes) and, on macOS, `macNative.visibleUs` in "Last show" (when AppKit
   reported the window visible). Record the numbers for each method.
6. **No flash on show** 📷 / 🎥 — Record the screen at 60 fps. Press **Show with new
   content** about 10 times, on a dark background with the light appearance, then on a light
   background with the dark appearance.
   *Expected:* no white, black or grey frame before the popup appears, and **the old text
   never appears** before the new text. Step through the recording frame by frame. Also
   note whether the very first show after launch flashes. Windows: compare
   `electrobun-showInactive` with `cloak`.
7. **Focus not stolen on show** — Open TextEdit or Notepad and start typing. In the control
   window press **Show in 3 s**, click back into the editor and keep typing until the popup
   appears and after it appears.
   *Expected:* the typing continues in the editor without interruption. The focus readout
   says `PASS: focus stayed with the other app`. Repeat with the macOS `activate` / Windows
   `electrobun-show` method, which is expected to `FAIL`. That proves the check works.
   **Bonus:** repeat over a fullscreen app (macOS: a fullscreen Safari or TextEdit Space; Windows: a
   borderless-fullscreen game or a video in fullscreen). Does the popup appear over it?
8. **Focus not stolen on click** — While typing in the editor (after #7), click **Copy** in
   the popup, then keep typing.
   *Expected:* the button reacts ("Copied"). Typing still goes to the editor, or the log line
   `popup-clicked` shows `popupStoleFocus: false`. On macOS, check the menu bar: it should
   still show the editor's menus. Repeat on macOS with `GLIM_MAC_PANEL=0` (expected:
   clicking activates the spike app) and on Windows with `GLIM_WIN_NOACTIVATE=0`
   (expected: clicking activates the popup).
9. **Reduce transparency** 📷
   - macOS: System Settings › Accessibility › Display › **Reduce transparency**.
   - Windows: Settings › Personalization › Colors › **Transparency effects** off.

   Toggle it while the popup is visible.
   *Expected:* within about 1 s the popup switches to the solid surface (`#F5F5F7` light /
   `#262628` dark). No blur, rounded corners and shadow still correct. "OS state" in the
   control window says `reduce transparency ON`. Switch it back and the material returns.
   Then try **Simulate on** in the control window; it should look the same as the OS
   setting. Record whether the log's `popup-media` shows `prefersReducedTransparency`
   changing (that's the CSS media query; `null` means the engine doesn't support it).
10. **Dark / light switch** 📷 — While the popup is visible, change the OS appearance
   (macOS: System Settings › Appearance; Windows: Settings › Personalization › Colors ›
   Choose your mode, or app mode). Then use the control window's Light / Dark.
   *Expected:* the material (blur tint), the veil and the text colours all switch together
   within about 1 s, with no frame where a light material shows dark text or the other way
   round. No flash and no relayout.
11. **Windows 10 fallback** 📷 (Windows 10 only)
   *Expected:* the popup uses the solid surface (the surface readout says "material acrylic
   unavailable on this OS build"), square corners (radius 0), and a shadow or at least a
   clean edge. Then try `accent-acrylic` and `accent-blur` and note: does a blur appear?
   Is moving or resizing the window laggy? Does the popup behave differently on a second
   monitor?
12. **Multiple monitors / mixed DPI** 📷 — With two displays (ideally with different
   scaling, e.g. 100 % and 150 % on Windows, or Retina and non-Retina on macOS) press
   **Move to next display**, then Show.
   *Expected:* on each display the material, corners, shadow and crisp text are all intact
   and the size is right for that display's scale. Windows: check the corner radius at
   150 %. The `move-display` log line shows the DPI.
13. **Resize** — Press **Toggle size** (do it on the primary display; Electrobun has a known
   Y-flip bug on secondary macOS displays).
   *Expected:* the material, rounded corners and shadow follow the new size, with no
   square or stretched corners.
14. **Not in the taskbar or Dock / window switcher** — Look at the taskbar, Alt+Tab, Mission
   Control and ⌘-Tab.
   *Expected:* the popup isn't listed as its own window. The control window is.

## 3. Results

Fill in **pass / partial / fail** and notes, and attach the log and screenshots. Please
include OS version and build, the hardware (Apple Silicon / Intel; GPU on Windows) and the
display setup.

| # | Check | macOS (version: ___) | Windows 11 (build: ___) | Windows 10 (build: ___) |
|---|---|---|---|---|
| 1 | Material visible behind content | | | |
| 2 | Rounded corners | | | |
| 3 | Native shadow | | | |
| 4 | Hairline | | | |
| 5 | Show latency < 100 ms (p50 / p95 per method) | | | |
| 6 | No flash on show | | | |
| 7 | Focus not stolen on show | | | |
| 8 | Focus not stolen on click | | | |
| 9 | Reduce transparency → solid | | | |
| 10 | Dark / light switch live | | | |
| 11 | Windows 10 fallback | n/a | n/a | |
| 12 | Multiple monitors / mixed DPI | | | |
| 13 | Resize | | | |
| 14 | Not in taskbar / Dock / switcher | | | |

Material preference (which material looked best, and whether 90 % leaves enough material
visible; this answers DESIGN.md open question 4):

-

macOS 26 only: does `glass` (`NSGlassEffectView`) look right at 12 px, or does it need a
larger radius (DESIGN.md open question 11)?

-
