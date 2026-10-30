# GLIM-15 capture spike: manual test plan

Throwaway spike. It answers three questions before the shell decision:

1. Can an Electrobun app grab an arbitrary screen rectangle into a raw RGBA buffer fast enough for Snip and for Live mode (2–4 fps), with correct pixels on mixed-DPI multi-monitor setups?
2. Which OS API should Glimpse use for this on each OS?
3. On macOS, how does the Screen Recording permission behave for an **unsigned / ad-hoc-signed** build, and does a grant survive a rebuild or update?

Background and the expected answers are in [FINDINGS.md](FINDINGS.md). This file covers how to run the spike and what to record.

Everything writes to a results folder: `~/GlimpseCaptureSpike/` on macOS and `%USERPROFILE%\GlimpseCaptureSpike\` on Windows. That folder holds the PNGs, `results-*.json` / `.md`, `app-log.txt` and `permission-state.json`. Set `GLIM_CAPTURE_OUT` to use a different folder.

## Backends

| name | OS | what it is |
|---|---|---|
| `gdi` | Windows | `BitBlt(SRCCOPY \| CAPTUREBLT)` from the screen DC into a DIB section. Baseline. |
| `dxgi` | Windows | DXGI Desktop Duplication (`IDXGIOutput1::DuplicateOutput`). One persistent session per monitor; the last frame is kept on the GPU and the region is read back. |
| `wgc` | Windows | Windows.Graphics.Capture. One persistent monitor session (free-threaded frame pool). Cursor off; border configurable. |
| `sck-shot` | macOS 14+ | ScreenCaptureKit `SCScreenshotManager.captureSampleBuffer`, one call per capture. |
| `sck-stream` | macOS 12.3+ | ScreenCaptureKit `SCStream`, persistent per display at `minimumFrameInterval` = 1/4 s. Returns the latest frame. |
| `electrobun` | both | Electrobun 2.0.5's built-in `Screen.captureRegion()`. macOS uses `CGWindowListCreateImage` at nominal (1x) resolution. Windows calls `GetPixel` once per pixel, so large regions are skipped. |

Coordinates you type are **global points** on macOS (0,0 is the top-left of the main display; output pixels = points × that display's scale). On Windows they are **physical pixels** of the virtual desktop (per-monitor-DPI-aware; a monitor to the left of the primary has negative x).

---

## Windows: build and run

Prerequisites (one time, PowerShell, no admin needed):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"   # Bun, into %USERPROFILE%\.bun
winget install -e --id zig.zig                 # C++ compiler for the DLL (or use VS Build Tools: see below)
git clone https://github.com/Abdul-213/glimpse.git; cd glimpse; git checkout glim-15-capture-spike
cd spikes\capture
```

Build and check:

```powershell
bun install
bunx electrobun prepare           # downloads the Electrobun 2.0.5 devkit into .hutch/
bun run native:win                # -> native\windows\build\glimcapture.dll (zig, or MSVC cl.exe if zig is absent)
bun run typecheck
bun test                          # unit tests (the FFI test is skipped on Windows)
```

If you use MSVC instead of zig, run `bun run native:win` from a "Developer PowerShell for VS". The script picks `cl.exe` when zig isn't on PATH.

Run, either way:

```powershell
# A. CLI (plain Bun, no window): quickest way to get numbers
bun src/cli.ts displays
bun src/cli.ts suite                         # all backends: PNGs, latency, 30 s loop at 4 fps
bun src/cli.ts capture --backend wgc --rect 100,100,400,120

# B. The Electrobun app (what Glimpse would ship)
bun run dev                                  # builds and launches the spike window
```

## macOS: build and run

Prerequisites: Xcode Command Line Tools (`xcode-select --install`) and Bun (`curl -fsSL https://bun.sh/install | bash`).

```sh
git clone https://github.com/Abdul-213/glimpse.git && cd glimpse && git checkout glim-15-capture-spike
cd spikes/capture
bun install
bunx electrobun prepare
bun run native:mac          # -> native/macos/build/libglimcapture.dylib (host arch; ARCHS="arm64 x86_64" for universal)
bun run typecheck
bun test
bun run build               # -> build/dev-macos-<arch>/<name>.app (ad-hoc signed)
scripts/mac-sign.sh show    # prints bundle id, cdhash, signature and designated requirement
```

**Always launch the .app with `open` (or from Finder) for permission tests:**

```sh
open "$(ls -td build/*/*.app | head -n 1)"
```

macOS attributes Screen Recording to the *responsible process*. If you launch from Terminal (`bun src/cli.ts …`, or a binary inside the bundle run directly), Terminal/iTerm is the app that needs and holds the grant, not the spike. The CLI is fine for capture numbers once your terminal has Screen Recording. It tells you nothing about Glimpse's permission behaviour. Check P11 confirms this.

The bundle id printed by `scripts/mac-sign.sh show` is the `<bundle id>` used below. It should be `dev.glimpse.spike.capture`; dev builds may add a suffix, so use the printed value.

---

## Checklist

Record results in the table at the end. For every capture check, open the saved PNG (path is in the log) and compare it with the screen.

### Capture: both OSes

| # | Check | How | Expected |
|---|---|---|---|
| 1 | Displays agree | App: **Displays**. CLI: `displays` | One line per monitor from the native library and from Electrobun. macOS: identical ids and bounds (points); `pixelScale` 2 on Retina. Windows: native bounds are physical px and Electrobun's are logical; ids (HMONITOR) match, and logical width × scaleFactor ≈ physical width. |
| 2 | Small region, every backend | Preset **small 400x120**, then **Capture once** with each backend | The PNG shows exactly the area under the box. macOS Retina: 800x240 px (Electrobun backend: 400x120, visibly blurrier). Windows: 400x120. No black or wallpaper-only image. |
| 3 | Large region | Preset **large 1920x1080** | Correct full-screen content. Windows `electrobun` is skipped (GetPixel). |
| 4 | Retina output pixels (macOS) | Preset **1920x1080 output px** (960x540 pt on a 2x display) | 1920x1080 px PNG, sharp text. |
| 5 | Region spanning two monitors | Preset **span** (needs 2 monitors sharing an edge; ideally different scales, e.g. Retina + 1x external, or 150 % + 100 % on Windows) | One PNG with both halves, aligned, no seam, gap or duplicated strip at the edge. macOS: the 1x half is upscaled to the higher scale. Windows: physical px 1:1 on both (text on the 150 % monitor looks bigger, which is correct). |
| 6 | Region partly off-screen | Rect half beyond the last monitor's edge | The on-screen part is correct, the rest opaque black, no error. |
| 7 | Latency p50/p95 | **Run full suite** (or CLI `suite`). Note the small and large `p50`/`p95` per backend | Logged as `n=50 p50=… p95=…`. Also note the `cold` time (first capture after **Reset sessions**). Targets: small p95 < 30 ms warm (Live), cold < 150 ms (Snip). |
| 8 | 4 fps for 30 s | Part of the suite. Put a playing video or a scrolling page under the *small* region first | `captured=120/120 dropped=0 failures=0`. `unchanged` should be well below 120 while content moves. Write down `cpu=` (bun process only) and also watch Task Manager / Activity Monitor for dwm.exe / WindowServer. |
| 9 | Cursor excluded | Hover the mouse inside the region and capture with "include cursor" off, then on | Off: no cursor in the PNG (GDI never captures it). On: cursor visible for wgc / sck-* / dxgi (DXGI never draws it). |
| 10 | Own window | Drag the spike window into the region and capture | The window appears in the PNG. Excluding it is GLIM-16's job; this records the baseline. |
| 11 | RGBA hand-off | Suite log line `ONNX hand-off: RGBA WxH -> float32 CHW in … ms` | Present, a few ms for 1080p. |

### Windows only

| # | Check | How | Expected |
|---|---|---|---|
| W1 | Mixed DPI is physical | Set the monitors to different scales (e.g. 150 % and 100 %); repeat 2 and 5 | Captures land on the right pixels on both monitors. Log line `dpi:` says the thread runs as PMv2. |
| W2 | WGC border, default | `wgc`, **WGC border required** ticked, run a 30 s loop and watch the screen | A yellow (Win10) / coloured (Win11) border appears around the **whole monitor** being captured, while the session is alive. Note the colour and whether it covers the whole monitor. |
| W3 | WGC border off | Untick **WGC border required**, **Reset sessions**, loop again. Then **Request WGC borderless access**, **Reset sessions**, loop again | Record whether the border disappears without asking, only after the request (note the returned status, e.g. `Allowed` / `NotDeclaredByApp`), or never. `native stats` shows `put_IsBorderRequired(0) … reads back …`. Microsoft documents a prompt plus a package-manifest capability, so for an unpackaged app "border stays" or "error" is plausible. |
| W4 | DXGI has no border | `dxgi` loop | No border or indicator anywhere. |
| W5 | Survive display changes | Run a 30 s `dxgi` loop and a 30 s `wgc` loop; during each, change resolution or scale, then press Win+L and log back in (or trigger a UAC prompt) | DXGI: some failures during the change, then recovery (`accessLost`/`recreated` > 0 in native stats). WGC: frames continue or the session errors. Record which. |
| W6 | Fullscreen content | Start a borderless-fullscreen game or a fullscreen video (and, if you have one, an exclusive-fullscreen game); capture a region over it with each backend | Correct content, not black. Record black frames per backend. |
| W7 | GDI side effects | Run a 30 s `gdi` loop while moving the mouse; repeat with CLI `--no-captureblt` | Note any cursor flicker (a known CAPTUREBLT side effect) and whether layered/transparent windows are missing without CAPTUREBLT. |
| W8 | Electrobun built-in | `electrobun` backend, small region | Record the latency (expected: very slow, roughly 0.1–1 s or worse for 400x120). |

### macOS: capture

| # | Check | How | Expected |
|---|---|---|---|
| M1 | SCK shot vs stream | Suite numbers for `sck-shot` and `sck-stream` | Stream: low warm latency, since it copies the latest frame. Shot: tens of ms per call. |
| M2 | Built-in on this macOS | `electrobun` backend, small region; note the macOS version | macOS 14/15: works at 1x. macOS 26+: may return null or a blank image (`CGWindowListCreateImage` is unsupported there). |
| M3 | Stream stats | `native stats` after a loop | `complete` frames > 0. `idle` grows when the screen is static. |
| M4 | Main-thread deadlock check | Any `sck-*` capture inside the **app** (not the CLI) | Returns within the 3 s timeout. A "timed out" error would mean SCK callbacks need the main thread that Bun blocks. Note it if seen. |

### macOS: Screen Recording permission (unsigned / ad-hoc builds)

Run these in order. Before each step, quit the app. Launch with `open …app` and press **Check (preflight)** first; it logs `preflight`, the state, the cdhash and the designated requirement. Each run is also recorded in `permission-state.json`. Optional evidence: give Terminal Full Disk Access and run `scripts/mac-tcc-dump.sh <bundle id>` after each step to see TCC's stored `auth_value` and code requirement.

Reset to a clean state before P1:

```sh
tccutil reset ScreenCapture <bundle id>
```

Then press **Forget "asked before" flag** in the app.

| # | Step | Expected |
|---|---|---|
| P1 | Fresh: launch, **Check** | `preflight=false`, state `not-determined`. Signature `adhoc`; designated requirement is `cdhash H"…"`. |
| P2 | **Request** | A system prompt names the app ("… would like to record this computer's screen and audio", with **Open System Settings** / **Deny**). The call returns `false` straight away. The app appears in System Settings › Privacy & Security › Screen & System Audio Recording, switched off. |
| P3 | Grant: switch it on in System Settings | macOS offers **Quit & Reopen**. Before relaunching, press **Check** in the still-running app: `preflight` probably stays `false` (cached per process). Record it. |
| P4 | Relaunch (**Quit & reopen**, or `open` again) | `preflight=true`, `granted`. Small capture with `sck-shot` and `sck-stream` shows real window content. |
| P5 | Relaunch again, no rebuild | Still `granted`. Grants survive restarts. |
| P6 | **Rebuild, ad-hoc**: `echo 'export const BUILD_TAG = "rebuild-1";' > src/bun/build-tag.ts && bun run build && scripts/mac-sign.sh adhoc`, then `open` | The cdhash differs from P1. **Expected `preflight=false`** (the grant belonged to the old cdhash), although System Settings may still show the toggle **on**. Record: state, toggle state, whether a new prompt appears on **Request**, and whether a second entry appears. |
| P7 | Recover the ad-hoc grant | Try in order, relaunching after each, until `granted`: (a) toggle off then on; (b) select the entry, press **−**, then **Request** again or add it with **+**. Record which one worked. This is what an unsigned-release user would have to do after every update. |
| P8 | **Stable self-signed identity.** Once: Keychain Access › Certificate Assistant › Create a Certificate… with Name `Glimpse Spike Self-Signed`, Identity Type *Self-Signed Root*, Certificate Type *Code Signing*. Then: `tccutil reset ScreenCapture <bundle id>`, `scripts/mac-sign.sh "Glimpse Spike Self-Signed"`, `open`, Request, grant, relaunch | `granted`. `mac-sign.sh show` shows `Authority=Glimpse Spike Self-Signed` and a requirement of the form `identifier "…" and certificate leaf = H"…"` (no cdhash). |
| P9 | **Rebuild with the same self-signed identity**: change `BUILD_TAG` to `rebuild-2`, `bun run build && scripts/mac-sign.sh "Glimpse Spike Self-Signed"`, `open` | cdhash differs, designated requirement unchanged. **Expected: still `granted`, no prompt.** This is the key result: a free, stable signing key could make grants survive updates without a paid Developer ID. |
| P10 | Path change ("update" by replacing the app): copy the P9 app to `/Applications`, `open` it there (and quit the build copy) | Still `granted` (TCC keys on bundle id + requirement, not on path). Record. |
| P11 | Terminal attribution: `bun src/cli.ts perm`, then `bun src/cli.ts capture --backend sck-shot --rect 0,0,400,120` from Terminal | The report warns "Not running from a .app bundle". The grant in use is the terminal app's (it is prompted for / listed instead). |
| P12 | **Revoke while running**: app granted, start a 30 s `sck-stream` loop, switch the toggle off during it | Record what happens: stream stops (`stopError` in stats; failures in the loop), `sck-shot` errors with -3801, **Check** may still say `preflight=true` (cached) while **Check + probe** says `granted-but-capture-failing`. macOS may also offer Quit & Reopen. |
| P13 | **Deny**: `tccutil reset ScreenCapture <bundle id>`, **Forget**, relaunch, **Request**, click **Deny** in the prompt | `false`. **Check** shows `denied-or-restart-needed`. A second **Request** shows **no** prompt. **Check + probe** gives -3801 (user declined). The `electrobun` backend returns null. **Open System Settings pane** opens the right pane. |
| P14 | Monthly re-confirmation (macOS 15+) | Note whether, and when, macOS shows "*… is requesting to bypass the system private window picker and directly access your screen*" (with *Allow For One Month*). It may appear on the first capture after a grant. Optional and intrusive: set the clock forward 32 days, relaunch, capture, then restore the clock. Record whether it appears. |
| P15 | Quarantined download (optional, Gatekeeper interaction) | Zip the app, `xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" Glimpse.zip`, unzip in ~/Downloads, open it | Gatekeeper blocks it ("Apple could not verify…"). On macOS 15+ allow it via System Settings › Privacy & Security › **Open Anyway**. Note the app path the log reports (App Translocation gives a random path) and whether an existing grant still applies. |

---

## Results (fill in)

Use **pass / partial / fail** and paste numbers from `results-*.md`. Machine column: model, OS version, monitors with their scales.

### Windows

Machine: ______________________ Windows version/build: __________ Monitors/scales: ______________________

| Item | gdi | dxgi | wgc | electrobun | Notes |
|---|---|---|---|---|---|
| 2 small capture correct | | | | | |
| 3 large capture correct | | | | n/a | |
| 5 span correct (mixed DPI) | | | | | |
| 6 off-screen part black | | | | | |
| 7 small cold / p50 / p95 (ms) | | | | | |
| 7 large cold / p50 / p95 (ms) | | | | n/a | |
| 8 loop 4 fps 30 s: captured / dropped / CPU % | | | | | |
| 9 cursor excluded / included on request | | | | | |
| W1 mixed DPI physical | | | | | |
| W2 border visible by default | n/a | n/a | | n/a | |
| W3 border removable (how) | n/a | n/a | | n/a | |
| W5 survives mode change / lock | | | | | |
| W6 fullscreen video / game | | | | | |
| W7 GDI flicker | | n/a | n/a | n/a | |
| **Overall** | | | | | |

### macOS

Machine: ______________________ macOS version: __________ Displays/scales: ______________________

| Item | sck-shot | sck-stream | electrobun | Notes |
|---|---|---|---|---|
| 2 small capture correct (px size) | | | | |
| 3/4 large and 1920x1080-px capture correct | | | | |
| 5 span Retina + 1x correct | | | | |
| 6 off-screen part black | | | | |
| 7 small cold / p50 / p95 (ms) | | | | |
| 7 large cold / p50 / p95 (ms) | | | | |
| 8 loop 4 fps 30 s: captured / dropped / CPU % | | | | |
| 9 cursor excluded / included on request | | | | |
| M2 built-in works on this macOS | n/a | n/a | | |
| M4 no main-thread timeout in the app | | | n/a | |

| Permission step | Result (state, prompt?, toggle?) | cdhash / requirement | Notes |
|---|---|---|---|
| P1 fresh | | | |
| P2 request prompt | | | |
| P3 granted, before relaunch | | | |
| P4 after relaunch | | | |
| P5 relaunch again | | | |
| P6 ad-hoc rebuild | | | |
| P7 recovery that worked | | | |
| P8 self-signed grant | | | |
| P9 self-signed rebuild | | | |
| P10 moved to /Applications | | | |
| P11 terminal attribution | | | |
| P12 revoke while running | | | |
| P13 deny | | | |
| P14 monthly prompt | | | |
| P15 quarantined download | | | |
| **Overall** | | | |
