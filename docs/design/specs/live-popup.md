# Live popup: spec (GLIM-31)

Status: **agent draft, awaiting owner approval** (2026-11-01). Implemented by GLIM-59 (pin a region), GLIM-79 (docked popup updated in place), GLIM-81 (pause / resume / unpin), GLIM-67 (skip unchanged blocks), GLIM-80 (cloud indicator), GLIM-82 (skipped blocks), GLIM-83 (accessibility). Mockup: [`mockups/live-popup.html`](mockups/live-popup.html), screenshots in [`mockups/screenshots/`](mockups/screenshots/).

Inputs: `PRODUCT.md`, `DESIGN.md` (token names are frontmatter keys), `.impeccable/design.json`, `docs/design/flows/live.html` (L1–L9, C1–C3), decisions GLIM-20 (cache, **Private**), GLIM-21 (classes, hysteresis), GLIM-22 (cloud indicator), GLIM-23 (keys), GLIM-85 (packs), spikes `overlay`, `window-materials` and `capture-exclusion`. Shared pieces (block anatomy, skipped line, provider badge, error copy) are defined in [`snip-popup.md`](snip-popup.md) and referenced, not repeated. The picker is [`region-picker.md`](region-picker.md).

Numbered markers and the on-screen overlay (Snip's GLIM-152, `snip-popup.md` §2.2, §2.3, §2.5) came to Live in GLIM-154: §2.6.

Units are logical px, global top-left-origin. Inline-start/end follow the UI language.

## 1. Job

A pinned region (game dialogue box, subtitle strip, chat pane) is watched for minutes or hours. The popup sits beside it and quietly keeps the translation current. The user's attention is on the game or video; Glimpse must never take focus, never cover the region, and only draw the eye when a line actually changed. Principle 3: show change, not churn.

## 2. Anatomy

### 2.1 Window and container

Same window recipe as the Snip popup (`snip-popup.md` §2.1: material, veil, radius, hairline), with these differences:

| Element | Tokens / values |
|---|---|
| Veil padding | Component `popup-live`: 8px 12px 12px. |
| Layout | Column: **control strip** → (cloud row) → (state row) → **block list** (scrolls). No footer. |
| Activation | Never activated by show or update (§7). |

### 2.2 Control strip (28px)

Inline-start to end:

| Element | Tokens / values |
|---|---|
| Grip (GLIM-151) | 12px six-dot `grip` icon, `text-secondary` at 55% opacity, full while the strip is hovered or dragged; decorative (`aria-hidden`). Says "this bar moves the popup". |
| Status dot | 8px circle. Running / updating: `accent` fill. Paused: hollow 1.5px ring in `text-secondary`. Error: `danger` fill. Consent pending: hollow ring. **Never pulses.** |
| Status label | `label` (12px / 500), `text-secondary`, 6px after the dot. Text per state (§4, copy §11). " · Private" is appended when Private is on and the popup is ≥ 300px wide. |
| Local indicator | `local-indicator` (chip icon, `text-secondary`). Icon + "On device" at ≥ 360px wide; icon only below that, with `aria-label` and tooltip. 8px after the label. Hidden when cloud is in use (the cloud row replaces it). |
| Spacer | flex 1. |
| Private toggle | `button-icon` 24px, eye-off icon, `aria-pressed`. On: `overlay-selected` background, icon `text-primary`. |
| Pause / Resume | `button-icon`, pause icon ↔ play icon. |
| Re-pin | `button-icon`, "select area" icon. |
| Overlay (GLIM-154) | `button-icon` toggle, `on-screen` (speech bubble) icon, `aria-pressed`, tooltip "Show translations on screen" / "Back to the list only" with `Ctrl+Shift+T` / `⌘⇧T`. Only when the frame can draw marks out of capture (§2.6). On: `overlay-selected` background. |
| Dock (GLIM-151) | `button-icon`, magnet icon, "Dock next to the area". **Only while moved** (§3.3). |
| Pin (GLIM-151) | `button-icon` toggle, `aria-pressed`, "Keep on top of other windows". On (default): pin icon, `overlay-selected` background. Off: struck-through pin icon, no background. |
| Stop | `button-icon`, stop (square) icon. Stops and unpins. |

Icon buttons are 4px apart. GLIM-154: with the Overlay button a regular strip has no room for " · Private" either; the label adds it only on wide strips then (the pressed Private toggle still says it), so regular strips still never wrap. Width budget at the 240px minimum: 216px of content = grip 12 + dot 8 + 6 + "Paused" ≈ 40 + 8 + local icon 16 + flex + 5 × 24 + 4 × 4 = 136 (6 buttons and 160 once moved) ⇒ more than 216, so a **compact strip wraps**: the buttons drop to a second line at inline-end (4px row gap) instead of squeezing the status label. Regular and wide strips never wrap. Hence the three widths: **compact** < 300 (icon-only local indicator, no " · Private" in the label), **regular** 300–359, **wide** ≥ 360 (full "On device").

There is no Hide button in the strip; hiding is a tray item and an optional global key (§6, owner question 5).

### 2.3 Rows under the strip

| Row | When | Tokens / values |
|---|---|---|
| **Cloud row** | A cloud provider is in use for this session | 24px row, `margin-block-start` 4px: `egress-indicator` pill "Sent to {provider}" (short name if it doesn't fit, as in `snip-popup.md` §2.4). Present for the whole session, including while paused. Tooltip: "Changes in this area are sent to {provider} as text". |
| **State row** | Paused, error, empty, consent, pack missing | Below the strip (and cloud row), `margin-block-start` 4px, padding-inline 8px. Paused / stale: one line in `body`, `text-secondary` (copy §11). Errors and consent: a `heading` line (15px / 600, `text-primary`) with a 16px status icon, a `body` paragraph in `text-secondary`, then buttons (`button-secondary`; the recovery is `button-primary`) 8px apart. Pack missing: `snip-popup.md`'s pack row. |

### 2.4 Pinned-region frame (on screen)

Drawn by a native click-through window (§12.2), not a webview.

| Element | Tokens / values |
|---|---|
| Corner ticks | Four L-shaped ticks, each arm 12px long, 2px `accent` over a 1px `picker-halo` outline, drawn **outside** the region: the ticks' inner edge sits 1px outside the region rect, so they never cover a pixel of it. No full rectangle. |
| Paused / error | Ticks turn `picker-stroke` at 60% opacity (halo unchanged). |
| Linked block | When a popup block is hovered or focused (or its badge or card is under the pointer on screen, GLIM-154): a `box-linked-fill` rect, `rounded.box`, with 1px `picker-stroke` + `picker-halo`, at that block's detected box. |
| Badges and cards (GLIM-154) | Painted by the same window, above the ticks: §2.6. |
| Region tag | **Only when the popup is hidden.** A HUD chip (`picker-readout` shape: `picker-hud`, `label` type, `picker-hud-text`, 20px, `rounded.kbd`) 4px above the top-left tick (below the bottom-left tick if there's no room above). Text "Live", "Live · Paused", or, with cloud, a cloud icon and "Live · {company}" in `egress-dark`. With cloud, sending is never invisible (flows C3). |

### 2.5 Block list

Blocks reuse the Snip anatomy (`snip-popup.md` §2.2: translation, source line, language tag, neutral and target-language blocks, failed block, skipped line and expansion), with these Live rules:

| Element | Tokens / values |
|---|---|
| Block padding | 4px 8px 4px **20px** (inline-start). The extra inline-start room is where the change mark sits, so text never shifts when the mark appears. All Live blocks use it, changed or not. |
| Changed block | Component `block-changed`: background `change-flash` **at once**, decaying linearly to `change-rest` (`block-changed-rest`) over `duration-settle` (1600 ms). Plus the **change mark**: 6px circle, `change-mark`, at inline-start 8px, vertically centred on the first line (`top = 4px + 0.5 × first-line height − 3px`). |
| Previous change set | When a new change set lands, the previous set's tint and marks are removed at once. Only the latest set is marked. |
| Pending in a changed block | Old translation held, or new source in `source` style (§8). Secondary text on `change-flash` stays ≥ 4.53:1 (computed worst case). |
| Gap | 8px between blocks, as in Snip. |
| Skipped line | As Snip, last row. Count and language list update silently (no highlight; filtering isn't change). Its expanded/collapsed state persists for the session. |
| Neutral blocks | Update their text silently; **never** marked as changed (a ticking HP counter is not news). |
| Scrollbar | As Snip. |

### 2.6 Numbered markers and overlay (GLIM-154)

Snip's markers and overlay (`snip-popup.md` §2.2, §2.3, §2.5: same tokens, same `fitText`), over the pinned region and kept current as Live updates. Owner ask: tell which translation belongs to which speech bubble when reading comics. Screenshots: `screens/live-popup/l25-comic-markers-macos-light.png` (bubble 3 picked on screen) and `l26-comic-overlay-*` (bubble 2 changed in the latest update).

| Element | Tokens / values |
|---|---|
| Numbers | Every block with a box (translate, target-language and skipped; not neutral) has a number, shown as its badge on screen and as Snip's `block-number` chip beside its popup block (skipped blocks too, inside the skipped line). **Stable**: a block that stays keeps its number across updates; new blocks take the smallest free numbers in reading order, so once every block has been replaced (a page turn) numbering starts again at 1 (core `liveBlockNumbers`). |
| When | Only with **two or more** numbered blocks: a single subtitle line needs no matching, and a "1" on every subtitle would be churn over the video. Cards don't need numbers and show with one block too. Never during consent (L10) or the empty state (L7). |
| Popup gutter | A numbered Live block pads 32px at inline-start: number 4–20px, change mark 23–29px, text from 32px, so neither ever shifts the text. |
| Badge | Snip's `box-badge` on the box's top inline-start corner, kept inside the frame window (region + 16px). Skipped blocks' badges at 60%. Linked (popup hover/focus, pointer on it) or picked: `accent` with `on-accent` digits. |
| Card | Snip's card (opaque `surface-popup-solid`, `text-primary`, hairline edge, Tooltip shadow, `rounded.control`, fitted text in the target's script stack, 2px `accent` ring when linked or picked). It shows **what the popup shows**: the old translation while a changed block is held (600 ms, §8); nothing while its new source is pending (the new source on screen shows through); the new translation once it lands. Failed, waiting-for-pack, skipped, neutral and target-language blocks: no card (badge only). Clamped into the frame window. |
| Change | Cards in the latest change set get the resting change tint (`change-rest` over the card) and a 6px `change-mark` dot inset 5px from the card's top inline-end corner. No flash on screen: the frame never animates (§9). Older marks clear with the next change set, as in the popup. Neutral updates are never marked. |
| In place | The view draws each badge and card once into a bitmap keyed by its look (text, box size, lit, changed, scale, theme); an update re-renders only marks whose look changed, and moves the rest. |
| Paused / stale / error | Badges and cards stay, at 60% like the ticks. |
| Pointer | The frame stays click-through **except over badges and cards** (the game keeps the rest of the region). Hover a badge or card: its popup block lights (and its box fills); a card under the pointer peeks (8% opacity, the source shows). Click: **picks** the block: the popup scrolls it into view and holds it with `overlay-selected` (and its number lit) until another pick or the block leaves; the popup never takes focus for it. |
| Peek | Original view (`Ctrl/⌘⇧O`, popup focused) peeks every card. Holding Shift (Snip's peek) isn't available: the game has the keyboard. |
| Toggle | Strip button (§2.2) or `Ctrl/⌘⇧T` in the focused popup, for this session. Settings › General › "Show translations on screen" (`snip.showOnScreen`, shared with Snip) opens every session with the overlay on. |
| Capture | The marks are drawn by the frame window, which is always excluded from capture whatever "Hide Glimpse from screenshots" says (it is a `surface`, GLIM-98): Windows `WDA_EXCLUDEFROMCAPTURE`, macOS the SCK filter that leaves out the whole app (plus its window id). Live only draws marks after confirming it: on Windows the frame's display affinity is read back and must be `WDA_EXCLUDEFROMCAPTURE` (it isn't before Windows 10 2004, where marks and the toggle are off); without a native frame (Linux) there are none. Masking (GLIM-98's fallback for un-flagged popups) is never used for marks: painting over the cards would paint over the source text under them. Tested headless in `app/test/live-marks-capture.test.ts`. |
| Accessibility | The marks are not accessible objects (the native window has none); the popup is the accessible surface with the same numbers. |
| Forced colours | Not followed on screen yet (the bitmaps use the theme's tokens); the popup follows them. Follow-up GLIM-155. |

## 3. Sizing and docking

Pure function `placeLivePopup(region, display, uiDir) → { side, frame, maxHeight }`, computed **once at pin time**; the side is kept for the session (DESIGN.md). Re-pin recomputes it.

| Constant | Value |
|---|---|
| `GAP` | 8 (popup to region) |
| `MARGIN` | 8 (popup to work-area edge) |
| Width, below/above | `clamp(region.width, 240, 640)`, ≤ work-area width − 16 |
| Width, sides | `clamp(space, 240, 400)` where `space` is the side's free width after `GAP + MARGIN` |
| `LIVE_COMFORT_H` | 160 |
| `LIVE_MIN_H` | 80 (strip + one line) |
| Max height, below/above | `min(0.4 × workArea.height, space on that side)` |
| Max height, sides | `0.8 × workArea.height` |

**Display:** the region's display (Live regions are on one display, `region-picker.md` §4).

**Side, first that fits:** below if space ≥ 160; above if ≥ 160; inline-end if side space ≥ 240; inline-start if ≥ 240; below/above with more space if ≥ 80; otherwise **inside** the region's top inline-end corner, inset 8px. The inside case covers part of the region on screen, but not in capture (our windows are excluded), so OCR is unaffected; it's the last resort for a full-screen region.

**Alignment:** below/above: **centred** on the region's horizontal centre, then clamped into the work area. (Snip aligns to the inline-start edge; Live centres because subtitles and dialogue boxes are centred, and a 640px popup under a 1600px subtitle strip should sit under the text.) Sides: top aligned with the region's top, clamped.

**Anchored edge:** the edge facing the region never moves. Below → top fixed; above → bottom fixed at 8px above the region; sides → top fixed, sliding up only to stay inside the work area.

**Height:** content height between `LIVE_MIN_H` and the max; then the list scrolls. **Empty-state shrink:** when the region has been empty for 5 s, the popup shrinks to the strip plus the empty row (§4, L-empty); it never closes by itself.

**Display change:** if the region's display disappears or changes resolution, the session pauses with error L-gone; the popup moves to the primary display's work area, top inline-end corner, inset 8px.

### 3.3 Moving, Dock and Pin (GLIM-151)

Owner feedback on 0.0.1: the popup must move and pin / unpin. (This replaces "not draggable in v1", owner question 4.)

- **Drag:** the whole strip is the handle (cursor `grab` / `grabbing`; the buttons keep theirs). A press that travels 3px becomes a drag; less stays a click. The window follows the OS cursor (main reads it, at most one move per animation frame) and is clamped `MARGIN` inside the work area of the display it is mostly on, with its current height visible. It moves without activating (§7): no focus change, no raise.
- **Moved = stays put:** for the rest of the session the popup is never re-docked. It is anchored at its **top-left**: content grows down, and its height limit becomes `max(docked limit, 0.4 × work-area height)` capped by the room below it, so growing never moves it or pushes it off screen. Re-pin starts a new session (next bullet).
- **Remembered:** on release (and after each keyboard step) the offset of the popup's top-left from the region's top-left is saved in settings `live.popupOffsets`, keyed by the region's display (bounds + scale; at most 8 displays). The next session on that display starts at region + offset (clamped as above), already "moved". Other displays dock as usual.
- **Dock:** the Dock button, or a **double-click on the strip**, puts the popup back with `placeLivePopup` for the current region (keeping its content height) and forgets that display's offset. The Dock button only shows while moved; double-click while docked does nothing.
- **Keyboard:** with the popup focused, `Alt+arrows` (`Option+arrows` on macOS) move it 10px, with `Shift` 50px (physical directions, not mirrored in RTL). Announced in the polite status region: "Popup moved", or "Popup at the left edge of the screen" when it stopped at an edge; Dock says "Popup docked next to the area". The popup's description tells screen-reader users how to move it.
- **Pin:** on (default) = above other windows (macOS level 101; Windows `HWND_TOPMOST`), today's behaviour. Off = a normal window level (macOS level 0; Windows `HWND_NOTOPMOST`), so other apps, and a focused fullscreen game, can cover it; it stays non-activating. The choice applies to the next sessions too, until Glimpse quits (not saved: a forgotten "off" would look like a missing popup next launch).

Pure logic in `@glimpse/core` (`live-move.ts`): `moveLivePopup`, `liveMoveStep`, `displayKey`, `offsetFor` / `rememberOffset` / `forgetOffset`.

## 4. States

| ID | State | Strip (dot · label) | Rows / blocks |
|---|---|---|---|
| L0 | **Pinned, first capture** | accent · "Live" | Skeleton bars per detected box, then pending source, then translations: the Snip sequence S0–S3, without a footer. No change marks for the first fill. |
| L1 | **Running, fresh** | accent · "Live" | Blocks. Latest change set marked. |
| L2 | **Settling** (pixels changing, not yet stable for ~300 ms) | unchanged | Unchanged. Nothing greys out (flows L3 greyed the old line; that is churn). |
| L3 | **Updating** (settled change being processed > 1000 ms) | accent · "Updating" | Unchanged until results arrive. The label returns to "Live" when done. |
| L4 | **Changed** | accent · "Live" | Changed blocks flash → rest + mark (§2.5). |
| L5 | **Paused** | hollow · "Paused" | State row "Showing text from {age}". Blocks in `text-secondary` (translations too). Frame ticks at 60% white. |
| L6 | **Resumed** | accent · "Live" | Capture runs at once; blocks that differ from what was shown are marked as one change set. Text seen while paused is never replayed. |
| L7 | **Empty** (no text for ≥ 5 s) | accent · "Live" | Blocks replaced by the state row "No text in this area right now. Watching for changes." Shorter gaps (between subtitle lines) keep the last blocks unchanged. |
| L8 | **Private on** | "Live · Private" (≥ 300px) | Toggle pressed. Nothing else changes. |
| L9 | **Cloud in use** | accent · "Live" | Cloud row under the strip for the whole session. |
| L10 | **Cloud consent** (first cloud Live session, flows C1) | hollow · "Live" | State row: heading, body, buttons "Pin with {provider}" (primary), "Use on-device", "Cancel", plus a checkbox "Don't ask again for Live". With a cloud OCR provider (asked every session, no checkbox) "Use on-device" reads with the on-device OCR instead and is offered only when one is installed (GLIM-122). No capture runs until answered. The popup is **activated** for this state only (§7). |
| L11 | **Skipped blocks** | – | Skipped line, as Snip. |
| L12 | **Pack missing** | accent · "Live" | Pack row at the top of the list; those blocks show source text; the rest translate. The session keeps running. The long-tail model's row and the confirm step for downloads over 200 MB are Snip's (`snip-popup.md` §2.2, GLIM-138). |
| L13 | **Cloud transient error** (timeout, 5xx, offline) | accent · "Can't reach {company}" / "Offline" | Changed blocks show new source text pending. Retries after 2 s, 5 s, 10 s. After 3 failures in a row or 30 s: L14 with `timeout`/`offline` copy. |
| L14 | **Error, paused** (key rejected, quota, repeated timeout, offline for 30 s) | danger · "Paused" | State row with heading, body and actions (copy §11). Blocks dimmed as in L5. |
| L15 | **Screen access lost** (macOS) / capture blank | danger · "Paused" | State row (copy §11). |
| L-gone | **Area no longer on screen** | danger · "Paused" | State row: "The Live area is no longer on a screen" [Re-pin] [Stop]. |
| L16 | **OCR engine stopped** | danger · "Paused" | State row: [Resume] [Stop]. |
| L17 | **Screen locked / system asleep** | hollow · "Paused" | Auto-paused; auto-resumes on unlock or wake (owner question 7). |
| L18 | **Re-pinning** | hollow · "Paused" | The picker is open in Live mode with the current region pre-drawn (`adjusting`). Esc returns to the previous session as it was (paused sessions stay paused). |
| L19 | **Hidden** | – | Popup hidden (tray or key). Session keeps running; the frame shows the region tag. |
| L20 | **RTL / mixed scripts / long / short** | – | Same rules as Snip S9–S13. A long chat pane scrolls; a changed block outside the visible scroll area is scrolled into view (`block: "nearest"`) unless the pointer is over the popup or it has keyboard focus. |
| L21 | **Compact width** (< 300) | label without " · Private" | Local indicator icon-only. |

**Staleness.** The popup is stale whenever it isn't capturing (L5, L14–L18). Stale means: hollow or danger dot, blocks in `text-secondary`, and the state row naming how old the text is. `{age}` is from the capture time of the shown content: "just now" (< 60 s), "{n} min ago" (< 60 min), "over an hour ago". It updates every 30 s. While running, the text is never labelled stale; L3 covers slow processing.

## 5. Block identity and diffing

Pure function `diffLiveBlocks(prev, next) → { upserts, removes, order, changeSet }`, unit-tested.

1. Match each new block to a previous one by bbox IoU ≥ 0.5; else by equal normalised text (GLIM-20 normaliser); else it's new.
2. Matched + same normalised text → **unchanged**: keep the DOM node, no re-render, no mark (even if its bbox jittered).
3. Matched + different text → **changed** (unless neutral or skip class: update silently).
4. New → **added** (counts as changed).
5. Unmatched previous → **removed**: its height collapses (§9), no mark.
6. Order: new blocks are inserted at their reading-order position; the relative order of surviving blocks never changes (no jumping).
7. GLIM-21 hysteresis keeps a block's language stable across frames, so class flips (translate ↔ skip) are rare. If one happens, the block moves between the list and the skipped line without a mark.

The change set is all changed and added blocks from one settled capture.

## 6. Controls and keyboard

### 6.1 Pointer

| Input | Result |
|---|---|
| Click Pause / Resume, Re-pin, Stop, Private, Pin, Dock | Acts on the **first click**, without activating Glimpse or taking focus from the game (§7). |
| Drag the strip | Moves the popup (§3.3), without activating. |
| Double-click the strip | Dock (§3.3), while moved. |
| Hover a block | `overlay-hover`; linked box on the frame (and its badge lit). |
| Hover a badge or card on the region (GLIM-154) | Its popup block lights; a card peeks (§2.6). |
| Click a badge or card on the region (GLIM-154) | Picks the block: the popup scrolls to it and holds it; no focus change. Every other click on the region reaches the app below. |
| Hover anywhere on the popup | Pauses auto-scroll (§4 L20). |
| Wheel | Scrolls the list. |
| Click in text | Places nothing (no activation). Text selection needs keyboard focus (§7). |

Stop never asks for confirmation; it ends the session and drops its caches (GLIM-20). Re-pin opens the picker (L18).

### 6.2 Keyboard (popup focused)

| Key (Windows / macOS) | Action |
|---|---|
| `Esc` | Return focus to the previous app; Live keeps running. |
| `Ctrl+Shift+P` / `⌘⇧P` | Pause / resume. |
| `Ctrl+W` / `⌘W` | Stop (unpin). |
| `Ctrl+C` / `⌘C` | Copy translation (manual only; Live never writes the clipboard by itself). Selection if any. |
| `Ctrl+Shift+C` / `⌘⇧C` | Copy original. |
| `Ctrl+Shift+O` / `⌘⇧O` | Toggle original view (cards on the region peek while it is on, GLIM-154). |
| `Ctrl+Shift+T` / `⌘⇧T` | Overlay on / off (GLIM-154). |
| `↑` / `↓`, `Home` / `End` | Move between blocks. |
| `Alt+arrows` / `⌥+arrows` (+ `Shift`) | Move the popup 10px (50px) (§3.3). Taken before the toolbar and list see the arrows. |
| `Tab` / `Shift+Tab` | Strip buttons → state-row buttons → blocks, wrapping. |
| `Enter` / `Space` | Activate the focused button; toggle the skipped line. |

### 6.3 Global (GLIM-23)

| Key | Action |
|---|---|
| Live hotkey (`Alt+Shift+L` / `⌃⇧L`) | When pinned: stop. When not: open the picker in Live mode. |
| Unbound by default (user can assign) | Pause/resume Live; Show/hide Live popup; **Focus Live popup** (new, proposed here, owner question 6). |

Tray items mirror them: Pause/Resume, Hide/Show popup, Focus Live popup, Private, Stop Live.

## 7. Focus rules

1. **Show, update, resize: never activate.** macOS: the popup is a non-activating panel (`GlimPanel : NSPanel`, `NSWindowStyleMaskNonactivatingPanel`, `becomesKeyOnlyIfNeeded`), shown with `orderFrontRegardless`. Windows: `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`, shown with `SW_SHOWNOACTIVATE`.
2. **Clicks on controls must not activate.** This is the riskiest item (window-materials spike check 8): WebView2's child HWND may take focus, and WKWebView may swallow the first click on a non-key panel (`acceptsFirstMouse`). Requirement for GLIM-81: if a click does activate Glimpse, Bun restores the previous foreground target immediately after handling the click (`glim_focus_restore`). Exclusive-fullscreen games may still minimise; borderless games won't.
3. **Keyboard focus is only taken on purpose:** the "Focus Live popup" action (tray or global key), or the consent state (L10). Before activating, Bun saves the foreground target (`glim_focus_save`). `Esc`, or finishing consent, restores it.
4. When focused, the popup shows focus rings on its controls (`:focus-visible`). Focus starts on the Pause/Resume button.
5. The popup losing focus to any app is normal; nothing happens.
6. While the picker is open for Re-pin, the picker owns focus (`region-picker.md` §7); confirming or cancelling restores the saved target.

## 8. Timing

| Step | Value |
|---|---|
| Popup visible after pin confirm | ≤ 100 ms p95 (target): pre-created hidden window, Bun sets the frame, sends `live/open`, view reports `painted`, then show-inactive. |
| Capture cadence | 2–4 fps (PRODUCT.md); 1 fps on battery if Settings says so. |
| Settle | Re-OCR only after the pixel diff passes the threshold and the region has been stable ~300 ms (GLIM-58). |
| Hold before swapping | When a block changes, its old translation stays up to **600 ms** waiting for the new translation, then swaps and flashes once. If it isn't ready by 600 ms, the new source text appears in `source` style and flashes then; the translation later crossfades in (`duration-fast`) **without a second flash**. |
| "Updating" label | After 1000 ms of processing a settled change. |
| Flash → rest | `duration-settle` 1600 ms, linear. Mark stays until the next change set. |
| Empty hold | 5 s with no text before showing L7. |
| Stale age refresh | Every 30 s. |
| Cloud retry | 2 s, 5 s, 10 s; then pause (L14). |
| Screen-reader announcement | Coalesce change sets within 1500 ms; at most one announcement per 1500 ms (§10). |
| Latest wins | If a newer settled capture arrives while an older one is still being processed, the older result is dropped (single-flight per GLIM-20 still reuses shared requests). |

## 9. Motion

| Moment | Motion | Reduced motion |
|---|---|---|
| Popup enter (pin) | Opacity 0 → 1, scale 0.98 → 1, `duration-base`, `ease-out`, origin on the edge facing the region. | Opacity only, ≤ `duration-fast`. |
| Popup exit (stop, hide) | Opacity → 0, `duration-exit`, `ease-exit`. | Instant. |
| Change flash | `change-flash` at once (no fade-in), linear decay to `change-rest` over `duration-settle`. | `change-rest` + mark at once, no decay. |
| Changed / added block height | Spring `spring-dock` (stiffness 520, damping 44, mass 1; CSS fallback `duration-base` + `ease-out`). Only that block and the blocks after it move, to make room. | Instant. |
| Removed block | Height → 0 with the spring, content opacity → 0 in `duration-exit`. | Instant removal. |
| Window resize | Growing: the window resizes to the final height at once, then content animates inside it. Shrinking: the window resizes after the content animation ends (~220 ms). The anchored edge never moves. | Instant in both directions. |
| Pending source → translation | Crossfade `duration-fast`. | Instant. |
| Auto-scroll to a changed block | `scrollIntoView({ block: "nearest", behavior: "smooth" })`. | `behavior: "auto"`. |
| Status dot, label, frame ticks | Colour swaps instantly. Never pulse, never blink. | Same. |
| Whole popup on update | **Never animates.** Unchanged blocks are not touched. | Same. |

## 10. Accessibility

- Root: `role="region"`, `aria-label` `live.a11y.region` ("Live translation"), `lang`/`dir` of the UI.
- Strip buttons: `aria-label` + tooltip with the key; Private and Pause use `aria-pressed`.
- Block list: `role="list"`; blocks `role="listitem"`, roving tabindex, `lang` on text. A changed block gets `aria-description` "Changed" (`live.a11y.changed`) so the mark isn't the only signal; removed with its mark.
- **Announcements (PRODUCT.md open item; proposed approach):**
  1. A visually hidden `role="log"` (`aria-live="polite"`, `aria-relevant="additions"`) inside the popup. For each coalesced change set, Glimpse appends one entry: the new translations in reading order joined by ". ", truncated to 300 characters with "…". The log keeps its last 5 entries. This works whenever the popup has focus.
  2. Because the popup is usually **not** focused (a game is), Bun also posts a native announcement with the same text through the helper: macOS `NSAccessibilityPostNotificationWithUserInfo(NSApp, NSAccessibilityAnnouncementRequestedNotification, { announcement, priority: NSAccessibilityPriorityMedium })`; Windows UIA `UiaRaiseNotificationEvent(…, NotificationKind_Other, NotificationProcessing_MostRecent, text, L"glimpse.live")` from a minimal UIA provider in `glimpse.dll` (whether Narrator speaks it for a non-foreground window is unverified).
  3. Tracked in GLIM-92. Setting "Read Live changes aloud" (Settings › Accessibility). Default: on when a screen reader is running at session start (macOS `NSWorkspace.isVoiceOverEnabled`; Windows `SystemParametersInfo(SPI_GETSCREENREADER)`), otherwise off. Owner question 8.
  4. Status changes (paused, error, resumed) are announced once through a `role="status"` region and the same native path.
- **As built (GLIM-92).** `app/src/bun/windows/live-announcements.ts` over core `LiveAnnouncer` (`packages/core/src/popup/live-announcer.ts`): the latest change set's translations as they appear (`revealedTranslations`, after the 600 ms hold), gathered for 700 ms so one change set is one announcement, at most one per 1500 ms, ≤ 300 characters. Status changes ("Live paused", "Live resumed") are announced once, at once. Setting: Settings › General › Live › "Read changes aloud" (`live.announceChanges`: `auto` = with a screen reader, the default; `on`; `off`). The screen reader is detected at session start (`glim_screen_reader_active`). Each announcement goes to the view's `role="log"` (or `role="status"`), and, while the popup is not focused, to `glim_announce` (`app/src/bun/native/announce.ts`, loaded separately so an older helper only disables this).
- **What works where, popup not focused** (expected behaviour, from the platform docs; unverified on hardware, GLIM-87):

  | | Popup focused | Popup not focused (a game has focus) |
  |---|---|---|
  | **WKWebView (macOS) + VoiceOver** | The polite `role="log"` is read. | Web live regions are **not** read for a background app. `NSAccessibilityAnnouncementRequestedNotification` posted on `NSApp` is queued and spoken by VoiceOver from a background app (medium priority for changes, high for status). |
  | **WebView2 (Windows) + Narrator** | The `role="log"` is read (WebView2 maps it to UIA LiveRegionChanged). | LiveRegionChanged is only spoken for the foreground window. `UiaRaiseNotificationEvent` on the popup's HWND (host provider from `UiaHostProviderFromHwnd`, `NotificationProcessing_MostRecent`, activity `glimpse.live`) is the only path. Whether Narrator speaks it for a non-foreground window is **unverified** (owner question 8). NVDA speaks UIA notifications from any window by default; JAWS may not. |
  | **Native call fails or helper missing** | – | The view's log is updated anyway; nothing is spoken until the popup is focused ("Focus Live popup"). |

  Native announcements are skipped while the popup has focus, so nothing is read twice.
- Contrast: as Snip (`snip-popup.md` §10). `text-primary` on `change-flash` over the veil: ≥ 8.3:1 worst case; `text-secondary` on it: 4.53:1 (just passes; don't lighten either token).
- `forced-colors: active`: changed blocks use a 1px `Highlight` outline instead of the tint (the tint disappears in forced colours), and the mark uses `Highlight`.
- Reduced motion keeps every signal (tint, mark, text, `aria-description`).

## 11. Copy

| ID | String |
|---|---|
| `live.status.live` | Live |
| `live.status.updating` | Updating |
| `live.status.paused` | Paused |
| `live.status.private` | {status} · Private |
| `live.status.retrying` | Can't reach {company} |
| `live.status.offline` | Offline |
| `live.local` | On device |
| `live.local.tooltip` | Text is read and translated on this device. Nothing is sent. |
| `live.pin` | Keep on top of other windows |
| `live.dock` | Dock next to the area |
| `live.move.hint` | Drag the top bar to move. {Alt\|Option}+arrow keys move it too, with Shift for bigger steps. |
| `live.move.moved` | Popup moved |
| `live.move.edge` | Popup at the {edges} edge of the screen |
| `live.move.docked` | Popup docked next to the area |
| `live.egress` | Sent to {provider} |
| `live.egress.tooltip` | Changes in this area are sent to {provider} as text |
| `live.stale` | Showing text from {age} |
| `live.age.now` | just now |
| `live.age.min` | {n} min ago |
| `live.age.hour` | over an hour ago |
| `live.empty` | No text in this area right now. Watching for changes. |
| `live.btn.pause` | Pause ({key}) |
| `live.btn.resume` | Resume ({key}) |
| `live.btn.repin` | Pick a new area |
| `live.btn.stop` | Stop Live ({key}) |
| `live.btn.privateOn` | Private is on. This session's translations are forgotten when it ends. |
| `live.btn.privateOff` | Turn on Private to forget this session's translations when it ends |
| `live.consent.title` | Live will send text to {provider} |
| `live.consent.body` | While this area is pinned, its text is sent to {provider} each time it changes, using your API key. |
| `live.consent.primary` | Pin with {provider} |
| `live.consent.local` | Use on-device |
| `live.consent.cancel` | Cancel |
| `live.consent.remember` | Don't ask again for Live |
| `live.e.key.title` | {provider} rejected the API key |
| `live.e.key.body` | Live is paused. Nothing more will be sent until you fix the key. |
| `live.e.quota.title` | {provider}'s quota for this key is used up |
| `live.e.quota.body` | Live is paused. You can keep watching with on-device translation. |
| `live.e.timeout.title` | {provider} isn't responding |
| `live.e.timeout.body` | Live is paused after 3 failed tries. |
| `live.e.offline.title` | You're offline |
| `live.e.offline.body` | Live is paused. Nothing is being sent. |
| `live.e.screen.title` | Glimpse can't see the screen |
| `live.e.screen.body` | Screen Recording permission is off, or was reset by an update. Live is paused. |
| `live.e.gone.title` | The Live area is no longer on a screen |
| `live.e.gone.body` | Its display was disconnected or changed resolution. |
| `live.e.ocr.title` | Text recognition stopped |
| `live.e.ocr.body` | Live is paused. Resume to try again. |
| `live.e.locked` | Paused while the screen was locked |
| `live.action.resume` | Resume |
| `live.action.local` | Use on-device |
| `live.action.checkKey` | Check key… |
| `live.action.settings` | Open System Settings |
| `live.action.repin` | Pick a new area |
| `live.action.stop` | Stop Live |
| `live.overlay.on` | Show translations on screen (GLIM-154, Snip's `snip.showOnScreen`) |
| `live.overlay.off` | Back to the list only |
| `live.tag` | Live |
| `live.tag.paused` | Live · Paused |
| `live.tag.cloud` | Live · {company} |
| `live.a11y.region` | Live translation |
| `live.a11y.changed` | Changed |
| `live.a11y.paused` | Live paused |
| `live.a11y.resumed` | Live resumed |

Pack-missing and skipped-line copy is shared with Snip (`snip.pack.*`, `snip.skipped*`).

## 12. Implementation notes

### 12.1 Popup window

| | macOS | Windows 11 | Windows 10 / reduced transparency |
|---|---|---|---|
| Creation | One `BrowserWindow`, **pre-created hidden at launch**, `transparent: true`, `titleBarStyle: "hidden"`. | `titleBarStyle: "hiddenInset"`. | Same, solid, radius 0. |
| Class / style | Re-classed to non-activating `GlimPanel : NSPanel` by the helper (`object_setClass`, spike §2.4); `floatingPanel`, `hidesOnDeactivate = NO`, `becomesKeyOnlyIfNeeded = YES`. `acceptsFirstMouse` = YES on the webview (helper swizzles or subclasses `WKWebView`). | Ex-style: replace `WS_EX_APPWINDOW` with `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`. | Same. |
| Level | 101, collection behaviour `CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle`, `FullScreenPrimary` removed, so it floats over fullscreen apps and follows Space switches. | `HWND_TOPMOST`. | Same. |
| Material | As Snip (`.popover` / Acrylic). | | |
| Show / hide | `orderFrontRegardless` / `orderOut`. | `SW_SHOWNOACTIVATE`; hide with DWM cloak. | Same. |
| Capture exclusion | SCK app exclusion (the Live capture stream's filter); `sharingType = .none` ≤ 14. | `WDA_EXCLUDEFROMCAPTURE`. | Same. |
| Frame | `glim_window_set_frame` (global logical). | `SetWindowPos(…, SWP_NOACTIVATE)`. | Same. |
| Drag (GLIM-151) | View pointer events → RPC → controller → `setFrame` on the panel. Electrobun's own `app-region: drag` (`startWindowMove`) isn't used: it moves the window behind our back (no clamping, no offset memory, no capture-exclusion bounds) and its Windows path rides on raw input. | Same path; Electrobun's `setWindowFrame` uses `SWP_NOACTIVATE`. | Same. |
| Pin off / on (GLIM-151) | `glim_window_set_level` 0 / 101 (Electrobun's `setAlwaysOnTop` only reaches `NSFloatingWindowLevel`). | `SetWindowPos(HWND_NOTOPMOST / HWND_TOPMOST, SWP_NOMOVE \| SWP_NOSIZE \| SWP_NOACTIVATE)` (Electrobun's lacks `SWP_NOACTIVATE`); the show path re-asserts `HWND_TOPMOST` only while pinned. | Same. |

### 12.2 Pinned frame: native click-through window (new helper code, GLIM-90)

Electrobun has no window-level click-through, and on Windows `WS_EX_TRANSPARENT` only works with `WS_EX_LAYERED`, which breaks transparent WebView2 (overlay spike §8). So the frame is drawn natively, without a webview:

- **Windows (`glimpse.dll`):** a plain Win32 popup window with `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST`, painted with `UpdateLayeredWindow` from a premultiplied 32-bit DIB (ticks, region tag, linked-box fill). Sized to the region plus a 16px margin (40px above when the tag shows). `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Its window procedure runs on a helper-owned UI thread.
- **macOS (`libglimpse.dylib`):** a borderless `NSPanel` with `ignoresMouseEvents = YES`, `opaque = NO`, clear background, level 101, the same collection behaviour, and a layer-backed view drawing the ticks with `CAShapeLayer`s.

```c
int   glim_frame_create(void **outFrame);
int   glim_frame_set_rect(void *f, double x, double y, double w, double h);   // region, global logical
int   glim_frame_set_style(void *f, int style /* 0 running, 1 paused/error */,
                           uint32_t accentRGBA, int tag /* 0 none, 1 live, 2 paused, 3 cloud */,
                           const char *tagText /* UTF-8 */);
int   glim_frame_set_highlight(void *f, int has, double x, double y, double w, double h);
int   glim_frame_show(void *f, int visible);
int   glim_frame_destroy(void *f);
```

Tag text is rendered by the helper with the system UI font at 12px/500 (CoreText / DirectWrite).

**Sprites (GLIM-154).** The badges and cards are bitmaps from the Live view (canvas, so the text is fitted and shaped exactly like Snip's DOM cards), sent to main once per look and handed over with:

```c
// geom f64[n*5] = x, y, w, h (frame space), opacity; meta i32[n*3] = px width, px height,
// flags (1 interactive, 2 peek); pixels = premultiplied RGBA back to back. n = 0 clears.
int glim_frame_set_sprites(uint64_t f, int32_t n, const double *geom, const int32_t *meta,
                           const uint8_t *pixels, int64_t bytes, double peekOpacity);
// out[0] = interactive sprite under the pointer (-1), out[1] = sprite clicked since last call (-1).
int glim_frame_pointer(uint64_t f, int32_t *out);
```

macOS: one `CALayer` per sprite above the ticks; while there are interactive sprites a 30 Hz timer reads `NSEvent.mouseLocation` and sets `ignoresMouseEvents = NO` only while the pointer is over one (the panel stays non-activating; `acceptsFirstMouse`). Windows: sprites composited into the layered DIB; a 33 ms `WM_TIMER` reads `GetCursorPos` and drops `WS_EX_TRANSPARENT` (and answers `HTCLIENT`) only over one; `WM_MOUSEACTIVATE` returns `MA_NOACTIVATE`. Main polls `glim_frame_pointer` every 50 ms while marks are up. ABI 9.

### 12.3 Other helper calls

`glim_focus_save` / `glim_focus_restore` (as the picker), `glim_announce(const char *utf8, int priority)`, `glim_screen_reader_active()`, plus the preference queries the shell already needs (accent colour, reduced motion, reduced transparency).

### 12.4 RPC (typed sketch)

Paths per `ARCHITECTURE.md`: controller `app/src/bun/windows/live-popup.ts`, frame binding in `app/src/bun/native/`, view `app/src/views/live/`, pure logic (`placeLivePopup`, `diffLiveBlocks`, `stripLayout`, `staleLabel`, `announcementText`) in `packages/core/src/popup/` next to the Live loop in `packages/core/src/pipeline/`. As for Snip, each union member becomes a named `LiveRPC` message (`opened`, `frameUpdated`, `translationUpdated`, `statusChanged`, ... and intents `pauseRequested`, `resumeRequested`, `repinRequested`, `stopRequested`, `privateToggled`, `consentAnswered`, `blockHovered`, `copyRequested`, `announced`, `blurred`).

```ts
type BlockClass = "translate" | "skip" | "neutral" | "target";
type LiveStatus = "consent" | "live" | "updating" | "retrying" | "offline" | "paused" | "error" | "empty";

interface LiveBlock {
  id: string;                 // stable for the session (§5)
  order: number;              // reading order
  cls: BlockClass;
  lang: string | null; langName: string | null;
  source: string;
  translation: string | null; // null = pending
  failed?: boolean;
}

type LiveToView =
  | { t: "open"; sessionId: string; os: "macos" | "windows"; uiLang: string; uiDir: "ltr" | "rtl";
      side: "below" | "above" | "inline-end" | "inline-start" | "inside"; width: number; maxHeight: number;
      targetLang: string; showOriginalUnder: boolean; private: boolean; provider: ProviderBadge; // snip-popup.md §13.2
      reducedMotion: boolean; announce: boolean; keys: Record<string, string> }
  | { t: "frame"; sessionId: string; frameSeq: number;            // one settled capture
      upserts: LiveBlock[]; removes: string[]; order: string[];
      changeSet: string[];                                        // ids to mark; [] = keep current marks
      capturedAt: number }                                         // epoch ms, for staleness
  | { t: "translation"; sessionId: string; frameSeq: number; id: string; text: string; final: boolean; failed?: boolean }
  | { t: "status"; sessionId: string; status: LiveStatus; capturedAt: number;
      error?: { kind: "providerKey" | "providerQuota" | "providerTimeout" | "offline" | "screenAccess"
                 | "areaGone" | "ocrFailed" | "locked"; params: Record<string, string> } }
  | { t: "pack"; sessionId: string; lang: string; langName: string; state: "missing" | "downloading" | "done";
      size?: number; done?: number; total?: number }
  | { t: "private"; sessionId: string; on: boolean }
  | { t: "provider"; sessionId: string; provider: ProviderBadge }
  | { t: "focus"; sessionId: string }                              // Focus Live popup: move DOM focus to Pause
  | { t: "close"; sessionId: string; animate: boolean };

type LiveFromView =
  | { t: "painted"; sessionId: string }
  | { t: "resize"; sessionId: string; contentHeight: number; phase: "grow" | "shrinkAfterAnimation" }
  | { t: "pause" | "resume" | "repin" | "stop"; sessionId: string }
  | { t: "setPrivate"; sessionId: string; on: boolean }
  | { t: "consent"; sessionId: string; answer: "cloud" | "local" | "cancel"; remember: boolean }
  | { t: "hoverBlock"; sessionId: string; id: string | null }      // → glim_frame_set_highlight
  | { t: "copy"; sessionId: string; what: "translation" | "original" }
  | { t: "action"; sessionId: string; action: string; lang?: string }
  | { t: "announce"; sessionId: string; text: string }             // view-built text → glim_announce (§10)
  | { t: "blur"; sessionId: string };                              // Esc → glim_focus_restore
```

`frame` messages only ever contain changed blocks in `upserts` (GLIM-67): unchanged blocks keep their DOM nodes. The view drops messages with an older `frameSeq` for the same block.

**Private toggle (GLIM-20 §Privacy 3).** One app-wide Private state; the popup toggle and the tray item are two views of it (owner question 3). Turning it on mid-session: the session stops reading and writing the app-wide cache and starts an isolated cache. Turning it off: the isolated cache is dropped and the session goes back to the shared cache. Neither change re-renders or marks blocks.

### 12.5 Pure modules and tests (Linux)

`placeLivePopup` (sides, centring, inside fallback), `moveLivePopup` and the offset memory (GLIM-151), `diffLiveBlocks` (IoU and text matching, neutral/skip silent updates, stable order, removal), `stripLayout(width, private, cloud)` (compact / regular / wide), `staleLabel(capturedAt, now)`, `announcementText(changeSet, max = 300)`, and a timing test for the 600 ms hold rule using a fake clock.

## 13. Decisions made in this spec (to fold back into DESIGN.md, GLIM-93)

1. **Cloud row** under the strip (a 28px strip can't hold "Sent to Google Cloud Translation" at 240px).
2. **Strip widths:** compact / regular / wide breakpoints at 300 and 360.
3. **No Hide button** in the strip; Hide is in the tray and an optional key.
4. **Live block inline-start padding 20px**, so the change mark never shifts text.
5. **Below/above docking is centred**, unlike Snip's inline-start alignment.
6. **No greying while settling** (the flows' L3 grey line is churn); "Updating" only after 1 s.
7. **Paused / stale** is shown by the dot, dimmed blocks and a `body` state row; DESIGN.md's `heading` type is used for error titles only.
8. **The pinned frame is drawn natively**, not by a webview, so it can be click-through on both OSes.
9. **Region tag** on the frame only while the popup is hidden (flows C3), including the cloud name.
10. **Live markers (GLIM-154):** badges only with two or more numbered blocks; numbers kept while a block stays and reused from the smallest free one; cards follow the popup's hold/pending rules; changed cards get the resting tint and mark without a flash; the frame is click-through except over badges and cards; no Shift peek (original view peeks instead); marks only when the frame is confirmed out of capture.

## 14. Open questions for the owner

1. Is 1.6 s right for the flash → rest decay with subtitles that change every 2–3 s? (DESIGN.md question 7)
2. Empty hold of 5 s before "No text in this area right now"? Shorter is more honest; longer is calmer between subtitle lines.
3. Private: one app-wide state shared by the tray and the popup (chosen), or per Live session? And is "Private" the name? (GLIM-20 question 2)
4. ~~Should the Live popup be draggable, or always docked to the side chosen at pin time?~~ Answered after 0.0.1 (GLIM-151): draggable, with Dock and Pin (§3.3).
5. Removing Hide from the strip (tray and optional key only): OK?
6. Add an unbound global action "Focus Live popup" (proposed) so keyboard and screen-reader users can reach the controls while a game has focus?
7. Screen lock and sleep: auto-pause and auto-resume (chosen), or stay paused until the user resumes? (GLIM-20 question 3)
8. Screen-reader announcements: default on when a screen reader is running (chosen)? And is the Windows UIA notification path worth the native code if Narrator ignores it for background windows?
9. First cloud Live session: in-popup consent (chosen, flows C1). Does "Don't ask again" apply to this provider only, or all cloud providers?
10. When cloud OCR is used in Live (expensive per GLIM-22), should consent be asked every session instead of once?

## 15. Acceptance checklist

- [ ] Pinning shows the popup on the chosen side within 100 ms, without taking focus; the game keeps keyboard focus throughout.
- [ ] The side never changes during a session; the anchored edge never moves as the popup grows or shrinks.
- [ ] Dragging the strip moves the popup without activating it (Windows and macOS); a moved popup stays put, grows from its top-left and stays on screen; the offset is reused next session on that display.
- [ ] Dock (button, double-click) snaps it back next to the region and forgets the offset.
- [ ] Pin off lets other windows cover it; Pin on keeps it above them; neither activates it.
- [ ] Alt/Option+arrows move it 10px (Shift 50px) and are announced politely.
- [ ] Only changed blocks re-render; they flash and decay over 1.6 s with a 6px mark that stays until the next change; neutral and skipped updates are silent.
- [ ] Pause dims the blocks, shows "Showing text from …", hollows the dot and greys the frame ticks; resume marks what changed while paused.
- [ ] Re-pin opens the picker pre-drawn; Esc returns to the old pin.
- [ ] Stop (button, `Ctrl/⌘W`, Live hotkey, tray) removes popup and frame and drops session caches.
- [ ] Private toggles in the popup and tray stay in sync and switch caches without re-rendering.
- [ ] Cloud row visible for the whole session; region tag names the company while the popup is hidden.
- [ ] Every error state pauses with its exact copy and a keyboard-reachable recovery.
- [ ] Frame ticks never cover the region and are click-through on both OSes; our windows never appear in captures.
- [ ] Reduced motion: no spring, no decay, no smooth scroll; tint, mark and text still update.
- [ ] Screen-reader announcements per §10 when enabled.
- [ ] (GLIM-154) With two or more blocks, every boxed block has a badge with the same number as its popup block; numbers stay put while blocks persist.
- [ ] (GLIM-154) Hovering a popup block lights its badge and box; hovering a badge or card lights the popup block; clicking one scrolls to and highlights it without taking focus; clicks elsewhere on the region reach the game.
- [ ] (GLIM-154) Overlay (strip toggle, `Ctrl/⌘⇧T`, Settings): cards over each bubble update in place, respect the 600 ms hold and pending state, carry the change mark, dim when paused, and never appear in Live's own capture (including with "Hide Glimpse from screenshots" off).
