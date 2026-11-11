# Region picker: interaction spec (GLIM-29)

Status: **agent draft, awaiting owner approval** (2026-11-01). Implemented by GLIM-44 (pick a region), GLIM-54 (multi-monitor and HiDPI) and GLIM-55 (cancel and exit cleanly). Mockup: [`mockups/region-picker.html`](mockups/region-picker.html) (interactive), screenshots in [`mockups/screenshots/`](mockups/screenshots/).

Inputs: `PRODUCT.md`, `DESIGN.md` (tokens; names below are DESIGN.md frontmatter keys, emitted as `--color-<key>`, `--radius-<key>` etc.), `.impeccable/design.json` (motion, shadows, focus), `docs/design/flows/snip.html` and `live.html` (S2–S4, L1), `docs/decisions/GLIM-23-default-hotkeys.md`, `spikes/overlay/FINDINGS.md`, `spikes/window-materials/FINDINGS.md`, `spikes/capture-exclusion/FINDINGS.md`.

All numbers are logical pixels (macOS points, Windows DIPs) in Electrobun's global, top-left-origin coordinate space unless marked "device px". "Inline-end" means right in a left-to-right UI language and left in a right-to-left one. Inside the picker, screen-space directions (left, right, up, down) are physical and never mirror: the screen does not flip for an RTL UI.

## 1. What the picker is for

The picker is the first thing the user sees after the Snip or Live hotkey, usually over a game, a video or a chat. It has one job: let them mark an area in about a second, then disappear. It should feel like CleanShot X or Shottr: instant, precise, dark HUD chips, no chrome. It is the same surface for both modes; only the hint copy and what happens on confirm differ.

## 2. Anatomy

One transparent, borderless overlay window per display (section 9.1). Each draws only the parts that fall on its display.

| # | Element | Drawn when | Tokens and values |
|---|---|---|---|
| A | **Scrim** | Always while picking. Cut out ("hole") inside the selection or the snap candidate. | `picker-scrim` (#00000073) over the whole display. |
| B | **Crosshair guides** | Idle and dragging, on the display under the pointer only. Hidden while adjusting and while the pointer is over the hint bar or a handle. | Two 1px lines in `picker-stroke`, each with a 1px `picker-halo` line on both sides. They span the display edge to edge and stop 10px short of the pointer hotspot on all four sides (a 20px gap), so the system crosshair cursor stays readable. |
| C | **Loupe** | Idle and dragging; also while dragging a handle (it follows the handle). Never while keyboard-adjusting. | 120 × 120 CSS px square, `rounded.popup` (12px; 8px on Windows), shadow **Loupe** (`0 4px 16px #00000059, 0 0 0 1px #FFFFFF, 0 0 0 2px #00000099`). Shows 15 × 15 **device px** around the hotspot, each scaled to 8 × 8 CSS px with nearest-neighbour sampling (`image-rendering: pixelated`). Grid: 1px lines in `picker-halo` at 25% opacity between cells. Centre cell outlined 1px `picker-stroke` with a 1px `picker-halo` outside it. No caption. Pixels outside the desktop paint #000000. |
| D | **Selection** | Dragging, adjusting, confirmed. | No fill (the scrim hole shows the content). Edge: 1px `picker-stroke` inside the rect, plus 1px `picker-halo` outside it. Identical in Snip and Live. |
| E | **Handles** | Adjusting only. | 8 handles (4 corners, 4 edge midpoints). Visual: 8 × 8 px square, fill `picker-stroke`, 1px `picker-halo` ring, `rounded.box` (3px). Hit area 20 × 20 centred on the handle. Edge-midpoint handles are hidden when that edge is shorter than 48px; corners always show. |
| F | **Size readout** | Dragging, adjusting, snap candidate. | Component `picker-readout`: `picker-hud` background, `picker-hud-text`, `numeric` type (12px/500, tabular figures), `rounded.kbd`, padding 2px 6px, height 20px, shadow **HUD**. Text in section 11. |
| G | **Snap candidate** | Idle, when the pointer is over a window (or the bare desktop). | Scrim hole cut at the candidate rect. Edge: the selection stroke (D) at 60% opacity. Readout (F) shows the app name and size. |
| H | **Snap guide** | Dragging or handle-dragging, when an edge is snapped. | 1px `picker-stroke` at 60% opacity with 1px `picker-halo`, drawn along the full length of the edge it snapped to (the target window's edge, or the display edge). |
| I | **Hint bar** | Always while picking, on the display under the pointer. | A HUD chip row: `picker-hud` background, `rounded.control` (6px; 4px on Windows), padding 4px 8px, height 28px, shadow **HUD**. Contents, inline-start to end: the **mode switch** (two segments, "Snip" and "Live", each 20px tall, `label` type; the current mode has a `picker-hud-text` fill at 16% opacity and `picker-hud-text` text, the other `picker-hud-text-secondary`), then the hint text (`label`, `picker-hud-text`), then key chips (`kbd` component recoloured for the HUD: background #FFFFFF1F, text `picker-hud-text`), each followed by its action in `picker-hud-text-secondary`. Copy in section 11. |
| J | **Egress notice** | In the hint bar, when the mode's pipeline will use a cloud provider. | `egress-indicator` shape (pill, 20px, cloud icon) with the dark-appearance values on the HUD: text `egress-dark` (#C4B0FF), fill `egress-tint-dark` (#C4B0FF1A). |
| K | **Live replace notice** | In the hint bar in Live mode, when a Live session already exists. | Plain hint text, `picker-hud-text-secondary`. |
| L | **Results layer** (Snip only, after confirm) | From confirm until the Snip popup closes. | Scrim removed. Selection edge (D) stays. Detection boxes per DESIGN.md: 1px `picker-stroke` + `picker-halo`, `rounded.box`, no fill; linked box `box-linked-fill`; skipped blocks dashed (3px dash, 3px gap) at 60% opacity; neutral blocks no box. GLIM-152: a numbered badge on each box, and in overlay mode opaque translation cards over the boxes (DOM over the canvas). The view hit-tests presses and hovers on its cards, badges and boxes and sends the block id with the pointer message: a press on a box picks its popup block, a press elsewhere dismisses. Specified with the popup in `snip-popup.md` §2.3, §2.5, §5. |

Icons (cloud, chip) come from the single outlined 16px / 1.5px-stroke family DESIGN.md asks for (not yet chosen, DESIGN.md open question 13).

The cursor is the system crosshair (`cursor: crosshair`) in idle and dragging; `move` inside the selection while adjusting; the matching resize cursor over each handle (`nwse-resize`, `ns-resize`, ...); `default` over the hint bar.

## 3. Phases

```
hidden ──hotkey/tray──▶ idle ──press+move ≥4px──▶ dragging ──release──▶ confirmed
                         │  ▲                        │  (Shift held at release)
                         │  └──── selection too small┘──────────▶ adjusting ──Enter / double-click──▶ confirmed
                         ├──click on snap candidate──▶ confirmed  (Shift held: adjusting)
                         ├──arrow key──────────────▶ adjusting
                         └──Esc / right-click / focus loss / display change──▶ cancelled
```

| Phase | Shows | Notes |
|---|---|---|
| `idle` | Scrim, crosshair, loupe, snap candidate (G) with readout, hint bar. | The default on open. |
| `dragging` | Scrim with hole, selection, crosshair at the moving corner, loupe, readout, snap guides, hint bar. | Anchor fixed, moving corner follows the pointer. |
| `adjusting` | Scrim with hole, selection, handles, readout, hint bar. No crosshair, no loupe. | Entered by keyboard, Shift-release, Re-pin (Live) and Snip again (Snip errors). |
| `confirmed` | Snip: results layer (L). Live: overlay hides; the pinned frame appears (`live-popup.md` §2.4). | Emits `picker/confirmed` (section 9.4). |
| `cancelled` | Everything fades out (section 8). | Emits `picker/cancelled`. Focus returns to the previous app. |

There is no "selection made, waiting" phase in the default path: **release confirms**. This keeps Snip to one gesture. Holding **Shift** at release (or turning off Settings › "Translate as soon as I release the mouse") lands in `adjusting` instead.

## 4. Sizing and placement rules

| Item | Rule |
|---|---|
| Drag threshold | A press becomes a drag once the pointer moves ≥ 4px from the press point. Below that, release counts as a click. |
| Minimum selection | 8 × 8. A release with either side below 8 returns to `idle` and shows the "too small" hint for 2 s. Enter in `adjusting` is ignored below 8 × 8. |
| Maximum selection | The union of all display bounds (Snip). Live: the bounds of one display (below). |
| Clamping | Every point is clamped to the union of display bounds (`clampToDesktop`, spike). Gaps between displays of different sizes are not selectable; a corner dragged into a gap sticks to the nearest display edge. |
| Device-pixel snap | The emitted rect is snapped to the device-pixel grid of the display containing its top-left corner (spike `snapToDevicePixels`). The on-screen outline uses the same snapped rect, so what you see is what is captured. |
| Live: one display | A Live selection must lie on one display. While dragging in Live mode, the moving corner is clamped to the display that contains the anchor, and the hint text changes to "Live areas stay on one screen" while the pointer is on another display. Snap candidates in Live mode are clipped to the display under the pointer. |
| Snap distance | 6px. During a drag, the moving corner's x snaps to the nearest snap edge within 6px, and its y likewise (independently). The anchor snaps the same way at press time. Holding **Ctrl** (Windows) or **⌘** (macOS) during the drag disables snapping. |
| Snap edges | For x: the left and right edges of every listed window whose vertical extent contains the pointer's y, plus every display's left and right bounds and work-area edges. For y: symmetric. Windows are those from the window list (section 9.3), front to back; edges hidden behind a nearer window are still eligible (cheap, and matches what users expect from CleanShot). |
| Snap candidate | In `idle`, the frontmost listed window whose rect contains the pointer. Over bare desktop (no window): the whole display. Candidate rects are clipped to the desktop union (Snip) or the pointer's display (Live). Windows smaller than 40 × 40 are skipped. |
| Readout position | 8px outside the selection's bottom-right corner (bottom-left for an RTL UI), measured from the selection edge to the chip edge. If the chip would leave the display, flip to the other side on that axis; if it still does not fit (selection fills the display), place it inside the selection, 8px in from the same corner. Drawn on the display that contains the chosen corner. |
| Loupe position | 24px right and 24px below the hotspot (screen space, not mirrored). Flips to the left if its right edge would be within 8px of the display's right edge, and above if its bottom would be within 8px of the bottom edge. Never straddles displays: it is drawn only on the display under the pointer. |
| Hint bar position | Centred horizontally on the work area of the display under the pointer, 16px below the work area's top edge. If the pointer or any part of the selection comes within 48px of the bar's rect, it moves to 16px above the work area's bottom edge (and back the same way). It never animates position: it jumps. Max width: work area width − 32; if the long copy overflows, use the short copy (section 11), and if that overflows, drop the key chips. |
| Keyboard default box | 240 × 120, centred on the pointer, clamped to the pointer's display. |
| Keyboard steps | 1px, or 10px with Shift, in logical px. |

### 4.1 Multi-monitor

- One overlay window per display, each exactly `display.bounds` (spike §4). No spanning window: macOS gives a window one scale factor and one Space per display, and Windows would rasterise the whole window at one DPI.
- **Scrim** on every display. **Crosshair, loupe and hint bar** only on the display under the pointer. **Readout** on the display holding its anchor corner. The selection and snap candidate are drawn by every display they touch, each its own intersection.
- **Pointer focus:** the overlay under the pointer at open becomes the key window. A drag that starts on display A and moves onto display B keeps pointer capture on A; Bun replaces out-of-view points with `Screen.getCursorScreenPoint()` and detects release by polling `Screen.getMouseButtons()` if no `up` arrives within 120 ms (spike §4). Bun also polls the cursor at 60 Hz while the picker is visible, so the crosshair and loupe follow the pointer on non-key overlays where WebKit may not deliver mouse-moved events (spike §3, risk 3).
- **Snip selections may span displays**, including mixed-DPI ones. `picker/confirmed` carries one piece per display, and capture works per piece (spike §5, `spansMixedScale`).
- **The size readout shows logical px** of the global rect, also across mixed DPI. Owner question 3.

### 4.2 DPI

- Each overlay renders at its own display's scale (`devicePixelRatio`). Strokes are 1 CSS px, so 2 device px on a 2× display. That matches how macOS draws its own hairlines.
- The loupe samples device pixels, so on a 2× display it covers 7.5 × 7.5 logical px; on 1×, 15 × 15.
- On Windows, logical-to-physical conversion uses the per-monitor mapping from the spike (`Display.id` is the `HMONITOR`; physical rects from `GetMonitorInfoW`), never one global scale.

## 5. Pointer behaviour

| Input | Phase | Result |
|---|---|---|
| Move | idle | Crosshair and loupe follow; snap candidate updates instantly (no tween). |
| Press, move ≥ 4px | idle | `dragging`; anchor = press point (snapped). |
| Press and release < 4px (click) | idle | If there is a snap candidate: select its rect and confirm (Shift held: `adjusting`). Otherwise nothing. |
| Move | dragging | Moving corner follows, snapped (unless Ctrl/⌘ held); readout updates every frame. |
| Hold **Space** | dragging | The whole selection moves with the pointer while Space is held (macOS screenshot convention); release Space to go back to resizing. |
| Release | dragging | Valid size: confirm (Shift held: `adjusting`). Too small: `idle` + hint. |
| Press inside selection, drag | adjusting | Moves the selection (clamped). |
| Press on handle, drag | adjusting | Resizes from that handle; the opposite corner or edge stays fixed. Snapping applies. Crossing over flips the rect normally (no inversion state). |
| Press outside selection, drag | adjusting | Starts a new selection (`dragging`). |
| Click outside on a snap candidate | adjusting | Selects that window's rect, stays in `adjusting`. |
| Double-click inside selection | adjusting | Confirm. |
| Right-click | any | Cancel. |
| Wheel | any | Ignored. |
| Click on a hint-bar mode segment | any | Switches mode (same as Tab). |

## 6. Keyboard map

Keys apply only while the picker is the key window; none are registered globally (GLIM-23). Glyphs follow the OS: Windows shows `Enter`, `Alt`, `Ctrl`; macOS shows `Return`, `⌥`, `⌘`.

| Key (Windows / macOS) | Phase | Action |
|---|---|---|
| `Esc` | any | Cancel the picker. One keystroke, from any phase. |
| `Enter` / `Return` | adjusting | Confirm (if ≥ 8 × 8). |
| `Enter` / `Return` | idle with a snap candidate | Select the candidate and confirm. |
| `Arrows` | idle | Create the 240 × 120 default box around the pointer; go to `adjusting`. |
| `Arrows` / `Shift+Arrows` | adjusting | Move the selection 1px / 10px. |
| `Alt+Arrows` / `⌥+Arrows`, add `Shift` for 10px | adjusting | Resize: Right/Down grow width/height, Left/Up shrink them. The top-left corner stays fixed. Never below 8 × 8. |
| `Tab` or `Shift+Tab` | any | Switch Snip ↔ Live. The selection and phase are kept. |
| The other mode's global hotkey | any | Switch to that mode (GLIM-23). |
| The current mode's global hotkey | any | Cancel (the hotkey toggles the picker). |
| `Space` (hold) | dragging | Move instead of resize (section 5). |
| `Shift` (held at release) | dragging, click | Land in `adjusting` instead of confirming. |
| `Ctrl` / `⌘` (hold) | dragging | Snapping off. |

## 7. Focus rules

1. **At hotkey time, before showing anything**, Bun records the foreground target: Windows `GetForegroundWindow()`; macOS `NSWorkspace.sharedWorkspace.frontmostApplication` (pid). Native helper `glim_focus_save()`.
2. The overlay under the pointer is shown **with activation** and becomes key, so `Esc` works. On Windows the open comes from `WM_HOTKEY` (user input), so `SetForegroundWindow` is permitted. From the tray item it is permitted too, because the click activated Glimpse. Other overlays are shown without activation.
3. If the key overlay does not report focus within 150 ms (spike risk: refused foreground), the picker still works with the pointer, and right-click cancels. `Esc` is never registered as a global hotkey to compensate (GLIM-23).
4. **Cancel:** hide all overlays, then restore the saved target (`glim_focus_restore()`: Windows `SetForegroundWindow(saved)`; macOS `[app activateWithOptions:0]`). If the saved target no longer exists, do nothing.
5. **Confirm, Snip:** the Snip popup becomes key (`snip-popup.md` §7); the overlays stay visible as the results layer but are lowered below the popup (section 9.1) and are not key.
6. **Confirm, Live:** overlays hide, the Live popup shows **without** activation, and the saved target is restored at once, so a game gets its focus back in the same frame budget.
7. **Focus loss while picking** (the user Alt+Tabs, a notification is clicked, another app activates): cancel, without restoring focus (the user chose where focus goes).
8. **Display configuration change while picking** (Bun detects it when `Screen.getAllDisplays()` differs on the 60 Hz cursor poll, at most once per second): cancel and restore focus.

## 8. Timing and motion

| Moment | Target | Motion | Reduced motion |
|---|---|---|---|
| Hotkey → scrim visible on all displays | ≤ 100 ms p95 (target, unmeasured) | Scrim opacity 0 → 1, `duration-fast` (100 ms), `ease-out`. HUD chips appear at full opacity at once. | Scrim appears at once. |
| Window list ready (snap candidates live) | ≤ 50 ms after open | none | none |
| First loupe pixels | ≤ 100 ms after open; then ≤ 33 ms old | none (pixels swap in place) | none |
| Pointer move → crosshair, selection and readout repainted | Within the next frame (≤ 16.7 ms at 60 Hz) on the pointer's display | none: geometry never tweens | none |
| Snap candidate change | Next frame | none (a tween would lag the pointer) | none |
| Hint bar top ↔ bottom jump | Next frame | none | none |
| Confirm, Snip | Scrim gone ≤ 80 ms | Scrim opacity → 0, `duration-exit` (80 ms), `ease-exit`. Selection edge stays. | Scrim removed at once. |
| Confirm, Live | Overlays gone ≤ 80 ms | Overlay opacity → 0, `duration-exit`, `ease-exit`. Frame ticks appear at once. | Instant. |
| Cancel | Gone ≤ 80 ms | Everything opacity → 0, `duration-exit`, `ease-exit`. | Instant. |
| "Too small" hint | Shown 2 s | Text swaps, no motion. | Same. |

Reduced motion means the OS setting (macOS "Reduce motion", Windows "Animation effects" off) or Glimpse's own motion preference set to Reduced (`:root[data-motion="reduced"]`).

The picker never shows a spinner. If the window list or loupe pixels are late, the picker works without them (no candidate, an empty loupe grid) until they arrive.

## 9. Implementation notes

Paths follow `ARCHITECTURE.md` (GLIM-28). Pure logic goes in `packages/core/src/picker/` (reducer, snapping, HUD layout) with `bun test` coverage on Linux; the window controller is `app/src/bun/windows/picker.ts` (one controller owning one overlay window per display); the view is `app/src/views/picker/`; native calls go only through `app/src/bun/native/macos.ts` / `windows.ts`. OS calls sit behind ports with fakes in `packages/core/src/testing/`.

### 9.1 Windows

| | macOS | Windows |
|---|---|---|
| Window | Electrobun `BrowserWindow`, `transparent: true`, `titleBarStyle: "hidden"`, frame = `display.bounds`. **Pre-created hidden at launch, one per display**, and recreated only when the display set changes (a recreated overlay may miss the 100 ms target once). | Same. |
| Level / z-order | Helper sets level **1000** (`NSScreenSaverWindowLevel`) while picking; lowered to **100** on Snip confirm, so the Snip popup (level 101) sits above the results layer. | `HWND_TOPMOST` via `setAlwaysOnTop(true)`. On Snip confirm, the popup is shown after the overlays and re-asserted with `SetWindowPos(popup, HWND_TOPMOST, …, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` so it is above them. |
| Spaces / fullscreen | Collection behaviour `(current & ~(FullScreenPrimary|MoveToActiveSpace|Managed)) | CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary` (spike). Accessory activation policy. If real-machine checks (GLIM-87) show it cannot cover another app's fullscreen Space, the overlay becomes a non-activating `NSPanel` subclass in the helper dylib. | n/a. Exclusive-fullscreen D3D games cannot be covered by any window (section 10). |
| Taskbar / switcher | `IgnoresCycle`. | Replace `WS_EX_APPWINDOW` with `WS_EX_TOOLWINDOW`. |
| Capture exclusion | Capture uses an SCK filter that excludes the whole Glimpse app (macOS 15+ ignores `sharingType`; GLIM-16). Also set `sharingType = .none` for macOS ≤ 14. | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (0x11); Windows build ≥ 19041 required. |
| Other | `acceptsMouseMovedEvents = YES`, `hidesOnDeactivate = NO`, `movable = NO`, `hasShadow = NO`. | WebView2 transparent background set before first show (`WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0`, spike). |

Because Glimpse windows are excluded from capture at the OS level, the Snip capture runs at confirm time **with the overlays still on screen**; nothing has to be hidden first.

### 9.2 Native helper calls (proposed, GLIM-91)

Proposed names for `libglimpse.dylib` (macOS) and `glimpse.dll` / plain `bun:ffi` (Windows). All AppKit work hops to the main thread inside the helper.

All follow ARCHITECTURE.md §6: C ABI, `glim_` prefix, integer status return (0 = ok), out-params, caller-owned buffers; the TypeScript binding degrades to "unavailable" if a symbol is missing.

```c
// Window setup per role; sets level, collection behaviour, ex-styles, capture exclusion.
int  glim_window_configure(void *win, int role /* 0 overlay, 1 snip popup, 2 live popup */);
int  glim_window_set_level(void *win, int level);            // macOS only; no-op on Windows
int  glim_window_set_frame(void *win, double x, double y, double w, double h); // global logical, top-left origin
                                                              // (works around Electrobun's macOS Y-flip bug)
// Focus
int  glim_focus_save(void);     // remembers the foreground window / app
int  glim_focus_restore(void);  // returns focus to it, if it still exists
// Window list for snapping (section 9.3).
int  glim_list_windows(GlimWindowInfo *out, int cap, int *outCount);
// Loupe: 15x15 device px centred on a global logical point, RGBA8, from the display under the point.
int  glim_sample_pixels(double x, double y, int size, uint8_t *outRGBA);
```

```c
typedef struct {
  double x, y, w, h;      // global logical, top-left origin, frame bounds without shadow
  int32_t pid;
  int32_t z;              // 0 = frontmost
  char app_name[64];      // UTF-8, for the readout; never the window title
} GlimWindowInfo;
```

### 9.3 Window rects per OS

Fetched **once per picker open**, asynchronously, and sent to Bun (not to the views; Bun does snapping). Expected cost 5–20 ms (unmeasured).

- **macOS:** `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)`. This metadata call is not deprecated (only `CGWindowListCreateImage` is). Keep entries with `kCGWindowLayer == 0` (normal windows) or `== 3` (floating panels); drop the menu bar, Dock and status items (layers ≥ 20). Drop our own pid, `kCGWindowAlpha == 0`, and rects under 40 × 40. Bounds: `kCGWindowBounds` (points, global, top-left origin of the menu-bar screen; the same space as Electrobun's displays). App name: `kCGWindowOwnerName`. The list is already front to back. `kCGWindowName` (the title) is not read.
- **Windows:** `EnumWindows` (top-level windows in Z order, front first). Keep a window if `IsWindowVisible`, not `IsIconic`, `DwmGetWindowAttribute(DWMWA_CLOAKED)` is 0 (excludes other virtual desktops and suspended UWP frames), it isn't ours (`GetWindowThreadProcessId`), and its class isn't `Progman`, `WorkerW`, `Shell_TrayWnd` or `Shell_SecondaryTrayWnd`. Rect: `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`. That is in physical px and excludes the invisible resize border that `GetWindowRect` includes. Convert to global logical with the spike's per-monitor mapping. App name: the executable's `FileDescription` version resource (`QueryFullProcessImageNameW` with `PROCESS_QUERY_LIMITED_INFORMATION`, then `GetFileVersionInfoW`), falling back to the exe base name. Do this in `glimpse.dll`, so `EnumWindows`' callback runs natively rather than through a `JSCallback`.
- **Element-level snapping** (buttons and panes inside a window, as CleanShot does through Accessibility) is out of scope for v1 (owner question 7).

### 9.4 RPC (typed sketch)

**Mapping to ARCHITECTURE.md §5.** The schema below becomes `{Surface}RPC` in `app/src/shared/rpc.ts` (or `shared/rpc/{surface}.ts`). Main → view state pushes are `webview.messages` named as events (`stateChanged`, `loupeUpdated`, `resultsChanged`, `reset`, `hidden`); view → main input is `bun.messages` named as intents (`pointerMoved`, `keyChanged`, `focusChanged`, `modeClicked`); `hello` is a `bun.requests` verb (`getPickerInit`). Main owns all state (rule 1); payloads are plain JSON with epoch-ms times (rule 2). The loupe's 900-byte pixel patch is the one deliberate exception to "no image bytes": it is tiny, transient and only exists while the picker is open.

Extends the spike's `OverlayRPC` (`spikes/overlay/src/shared/rpc.ts`). **Bun owns the picker state** (one reducer instance) and broadcasts it; views send raw input. If measurement shows pointer → paint above 16 ms, the view under the pointer may run the same pure reducer locally for its own display and treat Bun's broadcast as authoritative. The reducer is shared code, so the two can't drift.

```ts
type Mode = "snip" | "live";
type Phase = "hidden" | "idle" | "dragging" | "adjusting" | "confirmed" | "cancelled";
import type { Rect } from "@glimpse/core";   // { x, y, width, height }; global logical here
type HintKey = "idle" | "dragging" | "adjusting" | "tooSmall" | "liveOneScreen";

interface PickerViewInit {            // bun → view, once per open (response to hello)
  displayId: number;
  origin: { x: number; y: number };   // display origin, global logical
  scaleFactor: number;
  os: "macos" | "windows";
  uiDir: "ltr" | "rtl";
  reducedMotion: boolean;
  showLoupe: boolean;                 // Settings › Show magnifier
}

interface PickerState {               // bun → every view, on every change (coalesced per frame)
  seq: number;
  mode: Mode;
  phase: Phase;
  selection: Rect | null;
  candidate: { rect: Rect; label: string } | null;   // snap candidate (idle)
  guides: Array<{ x1: number; y1: number; x2: number; y2: number }>; // snap guides
  cursor: { x: number; y: number } | null;
  pointerDisplayId: number | null;    // draws crosshair, loupe, hint bar
  readout: { text: string; at: { x: number; y: number }; displayId: number } | null; // chip top-left
  hint: { key: HintKey; placement: "top" | "bottom"; egress: string | null; replacesLive: boolean };
  handles: boolean;
}

interface LoupePixels {               // bun → pointer view, ≤ 30 Hz, latest wins
  seq: number;
  centre: { x: number; y: number };   // global logical
  size: 15;
  rgba: string;                       // base64 of 15*15*4 bytes
}

interface PickerConfirmed {           // bun-internal event → Snip or Live controller
  mode: Mode;
  rect: Rect;                         // device-pixel snapped
  pieces: Array<{ displayId: number; local: Rect; physical: Rect; scale: number }>;
  source: "drag" | "window" | "keyboard" | "repin" | "snipAgain";
  window: { appName: string; pid: number } | null;
}

type PickerRPC = {
  bun: RPCSchema<{
    requests: { hello: { params: { displayId: number; devicePixelRatio: number }; response: PickerViewInit } };
    messages: {
      pointer: { displayId: number; phase: "down" | "move" | "up" | "leave"; x: number; y: number;
                 buttons: number; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean; detail: number; t: number };
      key: { displayId: number; key: string; code: string; down: boolean;
             shift: boolean; alt: boolean; ctrl: boolean; meta: boolean; repeat: boolean };
      focus: { displayId: number; focused: boolean };
      modeClick: { mode: Mode };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<never, never>;
    messages: {
      state: PickerState;
      loupe: LoupePixels;
      results: SnipBoxesState;        // results layer, see snip-popup.md §13.2
      reset: { mode: Mode; preset: Rect | null };   // preset = re-pin / snip-again rect (adjusting)
      hide: { animate: boolean };
    };
  }>;
};
```

`key` sends both down and up (needed for Space-to-move and Ctrl/⌘-to-unsnap). `detail` carries the click count for double-click.

### 9.5 Pure modules and tests (Linux)

- `picker.ts`: the reducer, extended from the spike with `mode`, the drag threshold, click-to-snap, Space-move, Shift-release, handles, the 8 × 8 minimum, and the Live one-display clamp.
- `snap.ts`: `snapEdges(windows, displays, cursor)` and `snapPoint(p, edges, 6)`; `candidateAt(windows, displays, p)`.
- `hud-layout.ts`: `readoutPosition`, `loupePosition`, `hintPlacement`, with flip cases at every display edge and on mixed-DPI fixtures from the spike.
- Fixtures: Retina + 1×, Windows 150% + 100%, a monitor at negative x, a selection spanning a seam, windows overlapping in Z.

## 10. States and edge cases

| Case | Behaviour |
|---|---|
| macOS Screen Recording not granted | The picker does **not** open. The hotkey opens onboarding's screen-access step (GLIM-45) instead, because the loupe and capture would only return blank pixels. Checked with `CGPreflightScreenCaptureAccess()` at each hotkey press. |
| Window list unavailable or slow | No snap candidates or window snap edges; display edges still snap. No error shown. |
| Loupe pixels unavailable | The loupe shows its empty grid. No error shown. |
| Cloud provider active for this mode | Egress notice (J) in the hint bar (copy in section 11). |
| Live session already running, picker in Live mode | Replace notice (K). Confirming stops the old session and pins the new area. |
| Snip hotkey while a Snip popup is open | The popup closes (no focus restore) and the picker opens. |
| Exclusive-fullscreen game (Windows) | The overlay can't appear above it, and stealing focus may minimise the game. This can't be detected reliably. Settings' and README's help text says to use borderless/windowed fullscreen (owner question 6). |
| Another app's fullscreen Space (macOS) | Covered by the collection behaviour above; unverified (GLIM-87). |
| Pointer hidden by a game (pointer lock) | The key overlay sets the cursor once it is key; nothing else is needed. |
| Display change or sleep while open | Cancel (section 7). |
| Windows High Contrast (`forced-colors: active`) | Strokes, handles and the selection edge use `CanvasText` with a `Canvas` halo; the scrim stays (it is a dim, not a colour); HUD chips use `Canvas` / `CanvasText` with a 1px `CanvasText` border. |

## 11. Copy

Exact strings. `{…}` are placeholders; plural forms go through `Intl.PluralRules`; numbers through `Intl.NumberFormat`. Key chips show OS glyphs: Windows `Enter`, `Alt`, `Ctrl`, `Esc`, `Tab`, `Space`; macOS `Return`, `⌥`, `⌘`, `esc`, `tab`, `space`, matching each OS's own key labels.

| ID | String |
|---|---|
| `picker.mode.snip` | Snip |
| `picker.mode.live` | Live |
| `picker.hint.idle.snip` | Drag to select, or click a window · `Tab` Switch to Live · `Esc` Cancel |
| `picker.hint.idle.live` | Drag over the text to watch, or click a window · `Tab` Switch to Snip · `Esc` Cancel |
| `picker.hint.idle.short` | Drag to select · `Esc` Cancel |
| `picker.hint.dragging.snip` | Release to translate · `Space` Move · `Shift` Adjust first |
| `picker.hint.dragging.live` | Release to pin · `Space` Move · `Shift` Adjust first |
| `picker.hint.adjusting.snip` | `Enter` Translate · Arrows Move · `Alt` Arrows Resize · `Esc` Cancel |
| `picker.hint.adjusting.live` | `Enter` Pin · Arrows Move · `Alt` Arrows Resize · `Esc` Cancel |
| `picker.hint.tooSmall` | Too small. Drag a larger area. |
| `picker.hint.liveOneScreen` | Live areas stay on one screen |
| `picker.hint.replacesLive` | Replaces the current Live area |
| `picker.egress.snip.image` | Image will be sent to {ocrProvider} |
| `picker.egress.snip.text` | Text will be sent to {translationProvider} |
| `picker.egress.snip.both` | Image and text will be sent to {company} |
| `picker.egress.live` | Live will send text to {translationProvider} |
| `picker.readout.size` | {w} × {h} |
| `picker.readout.window` | {appName} · {w} × {h} |
| `picker.readout.screen` | Screen · {w} × {h} |
| `picker.a11y.label.snip` | Select an area to translate |
| `picker.a11y.label.live` | Select an area to watch |
| `picker.a11y.open` | Area picker. Drag to select, or press an arrow key to draw a box with the keyboard. Escape cancels. |
| `picker.a11y.box` | Selection {w} by {h}, at {x}, {y} |
| `picker.a11y.mode` | {mode} mode |

`{ocrProvider}` and `{translationProvider}` are the service names from the provider registry ("Google Cloud Vision", "Google Cloud Translation"; GLIM-22). `{company}` is used when both stages go to one company ("Google").

## 12. Accessibility

- Overlay root: `role="application"`, `aria-roledescription="area picker"`, `aria-label` = `picker.a11y.label.*`. The key overlay's root holds DOM focus.
- A visually hidden `role="status"` (polite) region announces `picker.a11y.open` on open, `picker.a11y.mode` on mode switch, and `picker.a11y.box` after keyboard moves or resizes (debounced 500 ms, so holding an arrow announces once).
- The whole picker works from the keyboard (section 6); the pointer is never required.
- Colour is never the only signal: the mode is shown by the selected segment's fill *and* the hint text; the egress notice has an icon and words.
- HUD text contrast (computed for the 88%-opaque HUD over pure white and over pure black, worst case first): `picker-hud-text` 10.8:1 / 16.2:1; `picker-hud-text-secondary` 6.0:1 / 8.9:1; `egress-dark` on its tint on the HUD 5.0:1 / 7.6:1. All pass 4.5:1.
- Picker focus style (DESIGN.md §Focus) applies to the mode segments when they are focused: 2px `picker-stroke` with a 1px `picker-halo` outside.

## 13. Decisions made in this spec (to fold back into DESIGN.md, GLIM-93)

1. **Release confirms**; Shift-release, keyboard, Re-pin and Snip again go through `adjusting`. Owner question 1.
2. **Loupe** is a 120px rounded square (not a circle) so the pixel grid reads cleanly; **no loupe caption** (DESIGN.md mentions one; nothing needs it).
3. **Snap candidate** cuts a scrim hole as well as drawing the 60% stroke, so the candidate is obvious over dark content.
4. **Live selections stay on one display**: simpler capture and docking.
5. **The live overlay is not frozen**: the screen keeps updating under the picker. Freezing (CleanShot's option) would mean a full-display capture at open, transferring it to the webview and keeping it in memory. Owner question 2.
6. **Hint bar** at the top centre, jumping to the bottom when the pointer nears it, plus an egress notice for cloud pipelines.
7. **Right-click cancels**, as in CleanShot, as a pointer-only escape when the overlay didn't get key focus.

## 14. Open questions for the owner

1. Release confirms at once (chosen), or always stop in `adjusting` so handles can be used before translating?
2. Freeze the screen while selecting (CleanShot option)? Not in v1 as specified; it costs a full-display capture per open.
3. Size readout in logical px (chosen) or physical px on mixed-DPI setups? (flows open question 13)
4. Hint bar at the top centre, or bottom centre like the flows drew it? Bottom is where subtitles live.
5. Should the picker show the window's app name in the readout ("Safari · 1280 × 800")? It's local-only, but visible in screen shares (our windows are excluded from capture, so it is not).
6. Exclusive-fullscreen games: accept "use borderless" as the documented answer, or investigate a capture-first, screenshot-backed picker later?
7. Element-level snapping inside windows (via Accessibility / UI Automation), as CleanShot does: v2, or never?

## 15. Acceptance checklist

- [ ] Hotkey → scrim on every display; crosshair, loupe and hint bar on the pointer's display only.
- [ ] Hover shows a window candidate with hole, 60% stroke and "App · W × H"; click selects and confirms it; Shift-click lands in `adjusting`.
- [ ] Drag ≥ 4px draws a selection; edges snap within 6px to window and display edges, with guides; Ctrl/⌘ disables snapping; Space moves.
- [ ] Release confirms; < 8 × 8 returns to idle with the "too small" hint.
- [ ] Readout and loupe flip at every display edge; the hint bar jumps away from the pointer.
- [ ] Keyboard-only: arrows create, move and resize the box; Enter confirms; Esc cancels from any phase; Tab switches mode.
- [ ] Cancel restores focus to the previous app; Live confirm restores it immediately; Snip confirm hands focus to the popup.
- [ ] Mixed-DPI spanning selection reports per-display pieces; Live selection clamps to one display.
- [ ] Reduced motion: no fades.
- [ ] Our windows never appear in captures (GLIM-16).
