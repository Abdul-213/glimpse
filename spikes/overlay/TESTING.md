# GLIM-13 overlay spike: manual test plan

This spike is throwaway code. It checks whether Electrobun can show a transparent,
always-on-top, borderless region-picker overlay on every monitor, on Windows and
macOS, including mixed-DPI setups. The code was written and unit-tested on headless
Linux. **It has never been run with a display**, so every check below is still open.

Background is in [FINDINGS.md](FINDINGS.md). Electrobun is pinned to **2.0.6-beta.2**
in `hutch.config.ts`; the reason is in FINDINGS.md section 2.

## 1. Build and run

Electrobun 2.x projects are built with **Hutch**, Electrobun's own CLI. Hutch
downloads the matching Bun, the prebuilt Electrobun core and the SDK, so you don't
need a C/C++ toolchain.

### macOS (Apple Silicon or Intel, macOS 13+)

```bash
# 1. Install Hutch (installs to ~/.hutch; it adds ~/.hutch/bin to your shell rc)
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
export PATH="$HOME/.hutch/bin:$PATH"

# 2. Get the branch
git clone https://github.com/Abdul-213/glimpse.git && cd glimpse
git checkout glim-13-overlay-spike
cd spikes/overlay

# 3. Install, sync the Electrobun devkit, run the unit tests
hutch run install
hutch electrobun sync
hutch run test

# 4. Build a dev bundle and launch it; logs stream to this terminal
hutch run start
```

### Windows 10/11 (x64)

You need the WebView2 Runtime. Windows 11 ships with it; on Windows 10, install the
Evergreen runtime if `hutch run start` complains.

```powershell
# 1. Install Hutch
& ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))
# restart the terminal so hutch is on PATH

# 2. Get the branch
git clone https://github.com/Abdul-213/glimpse.git; cd glimpse
git checkout glim-13-overlay-spike
cd spikes\overlay

# 3. Install, sync, unit tests
hutch run install
hutch electrobun sync
hutch run test

# 4. Build a dev bundle and launch it
hutch run start
```

### What the app does

- About 1 s after launch it opens the overlay on **every** display (autostart).
- It adds a tray / menu-bar item called **"Glimpse spike"**. On Windows it uses the
  default application icon and may sit in the tray overflow (^). Menu items:
  - **Pick region**: open now.
  - **Pick region in 3 s**: gives you 3 s to switch to a fullscreen app or another Space.
  - **Pick region in 3 s (Electrobun only, no native shims)**: the same overlay using
    only Electrobun's public API, for A/B comparison (see FINDINGS.md section 3).
  - **Log displays**, **Cancel open overlay**, **Quit**.
- Every event is printed to the terminal between `===== GLIMPSE_OVERLAY <type> =====`
  banners, and appended as one JSON line to **`~/glimpse-overlay-spike.log`**
  (`%USERPROFILE%\glimpse-overlay-spike.log` on Windows). **Attach this file to your
  results.**

Event types in the log: `startup`, `overlay-open` (displays and native info),
`window` (per-overlay frame, level, styles, coverage check), `overlay-ready`
(latency, webview size and devicePixelRatio per display), `foreground` (Windows),
`focus`, `selection`, `cancelled`.

### What the overlay looks like

- The screen is dimmed (35 % black). Any un-dimmed strip means the overlay is not
  covering that area.
- A thin **blue frame** runs just inside every edge of every display. All four edges
  should be visible on every monitor.
- A small dark **banner** at the top centre of each display reads:
  `display <id> · <w>×<h> @<dpr>x (expected @<scale>x) · … · RPC rtt <n> ms`.
- Crosshair lines through the cursor. While you drag, the selection shows undimmed
  with a white outline, and a size label follows the cursor
  (e.g. `300 × 200 pt · 600 × 400 px @2x`).
- When you release the mouse, the overlay closes and a `selection` record is printed.
  Esc cancels.

### Optional environment switches

Set these before `hutch run start` (bash: `OVERLAY_DELAY_MS=5000 hutch run start`;
PowerShell: `$env:OVERLAY_DELAY_MS=5000; hutch run start`). If an env var seems to
have no effect, the dev launcher may not be passing it through. Use the tray items
instead and note it in your results.

| Variable | Default | Effect |
|---|---|---|
| `OVERLAY_AUTOSTART` | `1` | `0` = only open from the tray |
| `OVERLAY_DELAY_MS` | `1000` | Delay before the autostart overlay |
| `OVERLAY_NATIVE` | `1` | `0` = no FFI shims anywhere (pure Electrobun) |
| `OVERLAY_MAC_LEVEL` | `1000` | NSWindow level (try `25` status, `101` pop-up menu, `3` floating) |
| `OVERLAY_MAC_ACCESSORY` | `1` | Run as an accessory app (no Dock icon) |
| `OVERLAY_MAC_FSAUX` | `1` | Add `FullScreenAuxiliary` to the collection behaviour |
| `OVERLAY_WIN_TOOLWINDOW` | `1` | Hide overlays from the taskbar and Alt+Tab |
| `OVERLAY_CONFIRM_ON_RELEASE` | `1` | `0` = release leaves an adjustable box; arrows move it, Alt/⌥+arrows resize, Enter confirms |
| `OVERLAY_DIM` | `0.35` | Dim alpha |
| `OVERLAY_EXIT_AFTER` | `0` | `1` = quit after the first result |

## 2. Manual checks

Run every check on each OS you have. Record **pass / partial / fail** in section 3,
and attach `glimpse-overlay-spike.log`. The setup each check needs is in brackets.

### A. Single monitor

1. **Launch** [1 display]. Within about 1 s the whole screen dims, and the blue frame
   and banner appear. *Expected:* no title bar, no window shadow, no white or black
   flash. On macOS the banner at y=0 sits **over the menu bar**. On Windows the
   overlay covers the **taskbar**.
   Log: `overlay-ready.views[].coversDisplay == true` and `dprMatchesScale == true`.
   Windows: `window.coversMonitorPhysically == true`.
2. **Transparency.** Put a colourful window or video behind it. *Expected:* the
   content shows through, dimmed, everywhere outside the selection and at full
   brightness inside it. A solid grey or black overlay is a **fail**.
3. **Crosshair and live size readout.** Move the mouse without clicking. *Expected:*
   the crosshair follows smoothly; the size label appears once you start dragging.
   Note the `RPC rtt` value in the banner while dragging. Above about 16 ms the lag
   will be visible.
4. **Drag, release, print.** Drag from top-left to bottom-right over a known object,
   e.g. a window whose position you know. *Expected:* the overlay closes on release
   and the terminal prints `selection`. Check:
   - `globalLogical` matches what you dragged, in points (macOS) / DIPs (Windows).
   - `pieces[0].localPhysical` = logical × scale.
   - Windows: `cursorCheck.delta` is within ±2 px (`dx`, `dy`) if you didn't move the
     mouse after releasing.
   - `releaseBy` is `view`.
5. **Reverse drag.** Drag bottom-right to top-left. *Expected:* same kind of output
   with a positive width and height.
6. **Click without drag.** *Expected:* nothing happens and the overlay stays open.
   Then press Esc.
7. **Esc cancels** [the overlay must be the key/foreground window]. Open from the tray
   and press Esc **without clicking first**. *Expected:* the overlay closes and the
   log shows `cancelled` with `by: "key:Escape"`. If Esc does nothing until you have
   clicked the overlay, record **partial** and note it. That means the overlay did
   not take keyboard focus (on Windows also see `foreground.overlayIsForeground`).
8. **Esc mid-drag.** Start a drag, press Esc while still holding the button.
   *Expected:* the overlay cancels.
9. **Keyboard adjust** (optional; `OVERLAY_CONFIRM_ON_RELEASE=0`). Drag and release.
   The box stays. Arrows move it 1 px (Shift: 10), Alt/⌥+arrows resize, Enter
   confirms. *Expected:* `releaseBy: "key:Enter"` and the adjusted rect.
10. **Not in the taskbar / Dock / app switcher.** While the overlay is open, check the
    Windows taskbar and Alt+Tab, or the macOS Dock and Cmd+Tab. *Expected:* no overlay
    entries. On macOS there should be no Dock icon at all (accessory app).
11. **Repeat opens.** Use "Pick region" five times in a row. *Expected:* it works every
    time, `openToAllReadyMs` stays roughly constant (note the values), and no windows
    are left behind.

### B. Multi-monitor and mixed DPI

12. **Every monitor covered** [2+ displays]. *Expected:* every display dims, with the
    blue frame on all four edges. Banner `@dpr` equals `expected @scale` on each
    display. Log: one `window` record per display, all with `coversDisplay` true.
13. **Mixed DPI**. macOS: Retina laptop + 1x external. Windows: 150 % + 100 %, or
    125 % + 100 %. Do checks 1 to 4 on **each** display separately. *Expected:* on
    each display, `localPhysical` = `localLogical × that display's scaleFactor`.
    Windows: `globalPhysical` matches the monitor's position in Settings › Display.
    For example, a 100 % monitor to the right of a 4K 150 % primary starts at
    physical x = 3840 but at logical x = 2560.
14. **Drag across the seam** [2 displays, ideally mixed DPI]. Start on display A, drag
    onto display B, release on B. *Expected:*
    - The selection is drawn on **both** displays while dragging, without a jump at
      the seam.
    - `selection.pieces` has two entries and `spansMixedScale` is true when the scales
      differ.
    - Note `releaseBy` (`view`, `foreign-view` or `poll`) and the `stats` counters.
      `polledMoves` / `outsideOriginReplaced` > 0 means the webview stopped
      delivering moves outside its own window and Bun's cursor polling took over.
      That is fine for this spike; just record it.
    - Repeat dragging B → A.
15. **Displays at offsets.** Arrange the second display above, left of, or offset
    vertically from the primary (System Settings › Displays / Windows Settings ›
    Display › arrange). Reopen. *Expected:* every display is still fully covered and
    the coordinates in `selection` follow the arrangement (negative x/y for displays
    left of / above the primary).
16. **Change scale while running** (Windows: change one monitor 100 % → 125 %; macOS:
    change "Larger text / More space"). Reopen from the tray. *Expected:* the new
    scale is reflected in `overlay-open.displays` and the overlay still fits exactly.
17. **macOS scaled mode check.** On a Retina display set to "More Space", compare
    `overlay-open.displays[].coreGraphics` (`modePixelWidth` vs `modeWidth`) with the
    `selection` piece. This only tells us how capture resolution relates to
    `scaleFactor` for later spikes. Just record the numbers.

### C. Fullscreen apps underneath

18. **macOS native fullscreen app.** Put Safari or a video in native fullscreen
    (green button) so it has its own Space. Open the menu bar (move to the top) and
    choose **Pick region in 3 s**, then wait. *Expected:* the overlay appears **over
    the fullscreen app, on that Space**. macOS does **not** switch you back to the
    desktop Space. The selection works and Esc works.
19. **Same with "Electrobun only, no native shims"** [as 18]. Record what happens. The
    expected result is that it either fails to appear over the fullscreen Space or
    switches Spaces. This A/B check shows how much the native shim matters.
20. **macOS level sweep** (optional) [as 18]. Relaunch with `OVERLAY_MAC_LEVEL=25` and
    with `101`. Note which levels cover the menu bar and the fullscreen app.
21. **Windows borderless-fullscreen game or video** (e.g. a browser video in F11, or a
    game in "borderless windowed"). Use **Pick region in 3 s** from the tray, then
    switch to the app. *Expected:* the overlay covers it and the selection works.
    Note whether the game minimises or loses focus.
22. **Windows exclusive-fullscreen game** (optional; any DirectX game set to
    "Fullscreen", not borderless). *Expected:* likely **fail**. The game minimises,
    or the overlay is invisible. Record which.
23. **Windows: Esc after delayed open** [as 21]. Without clicking, press Esc.
    *Expected:* it cancels. Windows foreground-lock rules may stop a delayed window
    from taking focus. If so, `foreground.overlayIsForeground` is false and Esc only
    works after a click. Record **partial**.

### D. macOS Spaces

24. **Second desktop Space.** Create Desktop 2 (Mission Control), switch to it, use
    **Pick region in 3 s**. *Expected:* the overlay appears on Desktop 2 and you are
    not moved to Desktop 1.
25. **"Displays have separate Spaces"** (System Settings › Desktop & Dock; the default
    is on). With 2 displays, put display B on its own second Space and open the
    overlay. *Expected:* both displays are covered, each on its current Space. Then
    turn the setting off (needs a log-out), repeat, and record the result.
26. **Mission Control / Cmd+Tab while open.** Open the overlay, press Cmd+Tab or swipe
    Spaces. Record what happens. A good result is that the overlay stays put or can
    still be cancelled with Esc or the tray's "Cancel open overlay". A stuck overlay
    is a **fail**.

### E. Odds and ends

27. **Dark and light mode.** The overlay should look the same in both (it does not
    follow the theme).
28. **Unsigned-build friction.** Note any Gatekeeper or SmartScreen prompt you had to
    get past for `hutch run start` (dev builds are unsigned).
29. **Quit.** Tray › Quit. *Expected:* the process exits and nothing is left in the
    tray or menu bar.

## 3. Results

Fill in **pass / partial / fail** plus short notes, and attach the log file for each
OS. Give the hardware and displays used (model, resolutions, scale) in the header rows.

| | macOS | Windows |
|---|---|---|
| OS version / hardware | | |
| Displays (res @ scale, arrangement) | | |
| Electrobun / Hutch version printed at startup | | |

| # | Check | macOS | Notes (macOS) | Windows | Notes (Windows) |
|---|---|---|---|---|---|
| 1 | Launch, covers screen, menu bar / taskbar | | | | |
| 2 | Transparency | | | | |
| 3 | Crosshair + live size, RPC rtt | | | | |
| 4 | Drag, release, printed coordinates correct | | | | |
| 5 | Reverse drag | | | | |
| 6 | Click without drag | | | | |
| 7 | Esc cancels without clicking first | | | | |
| 8 | Esc mid-drag | | | | |
| 9 | Keyboard adjust (optional) | | | | |
| 10 | Not in taskbar / Dock / switcher | | | | |
| 11 | Repeat opens, latency | | | | |
| 12 | Every monitor covered | | | | |
| 13 | Mixed DPI per display | | | | |
| 14 | Drag across seam | | | | |
| 15 | Displays at offsets / negative coords | | | | |
| 16 | Scale change while running | | | | |
| 17 | macOS scaled-mode numbers | | | n/a | |
| 18 | macOS fullscreen app (with shims) | | | n/a | |
| 19 | macOS fullscreen app (Electrobun only) | | | n/a | |
| 20 | macOS level sweep (optional) | | | n/a | |
| 21 | Windows borderless fullscreen | n/a | | | |
| 22 | Windows exclusive fullscreen (optional) | n/a | | | |
| 23 | Windows Esc after delayed open | n/a | | | |
| 24 | macOS second Space | | | n/a | |
| 25 | macOS separate Spaces per display | | | n/a | |
| 26 | Mission Control / Cmd+Tab while open | | | n/a | |
| 27 | Dark / light mode | | | | |
| 28 | Unsigned-build friction | | | | |
| 29 | Quit | | | | |
| | **Overall** | | | | |
