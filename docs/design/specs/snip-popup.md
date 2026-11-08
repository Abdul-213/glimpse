# Snip popup: spec (GLIM-30)

Status: **agent draft, awaiting owner approval** (2026-11-01). Implemented by GLIM-65 (popup near the snip), GLIM-71 (auto-copy), GLIM-72 (placement and dismissal), GLIM-73 (loading and error states), GLIM-74 (show original), GLIM-80 (cloud indicator), GLIM-82 (skipped blocks). GLIM-152 (owner feedback on 0.0.1, comics) added numbered markers (§2.2, §2.3, §5) and overlay mode (§2.5). Mockup: [`mockups/snip-popup.html`](mockups/snip-popup.html), screenshots in [`mockups/screenshots/`](mockups/screenshots/).

Inputs: `PRODUCT.md`, `DESIGN.md` (token names are its frontmatter keys), `.impeccable/design.json`, `docs/design/flows/snip.html` (S5–S8b, D1–D7, E1–E4), decisions GLIM-20 (cache, Private), GLIM-21 (block classes), GLIM-22 (cloud indicator copy), GLIM-23 (keys), GLIM-85 (language packs), and `spikes/window-materials/FINDINGS.md`. The picker and the on-screen results layer are in [`region-picker.md`](region-picker.md).

Units are logical px (points / DIPs) in global top-left-origin coordinates. "Inline-start/end" follow the **UI language** direction. Block text follows its own detected direction.

## 1. Job

The user has just dragged a box over text they can't read. Within a tenth of a second something must appear beside the box, then the original text, then the translation, which also lands on the clipboard. They read it, maybe press `Ctrl+C` or look at the original, and press `Esc`. The popup is a margin note: small, flat, next to its source, gone in one keystroke.

## 2. Anatomy

### 2.1 Window and container

| Element | Tokens / values |
|---|---|
| Window | Real OS window with the native material: macOS `NSVisualEffectView` `.popover`, `.behindWindow`, state `.active`; Windows 11 Acrylic `DWMSBT_TRANSIENTWINDOW`. Windows 10, "Reduce transparency" or "Transparency effects" off: no material, `surface-popup-solid`. Native window shadow and corner (macOS window server; Windows `DWMWCP_ROUND`). |
| Veil (webview root `.popup`) | Background `surface-popup` (90%), or `surface-popup-solid`. Radius `rounded.popup` (12px macOS, 8px Windows 11, **0 on Windows 10**: spike §8). Padding `spacing.3` (12px). Edge: inset 1px `border-hairline`; dark appearance adds the 0.5px outer `#000000A6` line (shadow `popup-outline-dark`). Windows 11: `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` so the DWM border and the hairline don't double up. |
| Layout | Column: **block list** (scrolls), then the **footer** (pinned). No header, title or logo. |
| Width | See §3. Text measure is capped by the 480px maximum (≈ 60ch at 15px). |

### 2.2 Block list

| Element | Tokens / values |
|---|---|
| Block list | `role="list"`. Gap `spacing.2` (8px) between blocks. Overflow-y auto; scrollbar `scrollbar-width: thin`, thumb `overlay-pressed`, track transparent. When the list overflows, a 1px `divider` rule appears above the footer; otherwise none. |
| Block (container) | Component `block-translation`: padding 4px 8px, `rounded.control`. Hover or focus: `overlay-hover` background (`duration-fast`, `ease-standard`), and the linked box lights on screen. Focus ring per DESIGN.md §Focus. Hovering its box on screen gives the same `overlay-hover` (GLIM-152). |
| Block number (GLIM-152) | Component `block-number`: every block that has a box on screen (translate, target-language and skipped blocks; not neutral ones) carries the number of its badge on screen (§2.3), so the reader can match a translation to its bubble. A 16px pill (`rounded.pill`, min-width 16px, 2px inline padding) in `numeric` type, `overlay-pressed` background, `text-secondary`, in a 24px gutter at the block's inline-start (the block pads 24px at inline-start, so text never shifts), centred on the first line. Linked (hover, focus, or its box hovered on screen) or **picked** (its box clicked on screen): `accent` background, `on-accent` digits. Numbers are given in reading order at recognition and never change for the request ("Translate these" keeps a skipped block's number). Digits are formatted for the UI locale. Error states that list the original plainly (E2, E3) show no numbers. |
| Picked block (GLIM-152) | A block whose box or badge was clicked on screen: the list scrolls it into view (no animation), focuses it, and holds it with `overlay-selected` until another block is picked. A picked skipped block expands the skipped list first. |
| Translation | Typography `translation` (15px / 400 / 1.5), `text-primary`. Per-script size and leading from DESIGN.md's script table via `:lang()`, on the **target** language tag. |
| Source line | Typography `source` (13px, 14px on Windows; 1.5), `text-secondary`, `margin-block-start` `spacing.1` (4px). Shown under each translation only when "Show original under translation" is on (Settings; off by default). `lang` = detected source language. |
| Pending source | Before its translation arrives, a translate-class block shows its OCR text in `source` style in the translation's slot. |
| Skeleton bar | Before OCR text exists: a static bar, 10px tall, `overlay-pressed`, `rounded.box`, vertically centred in a 22px line (the translation line height), so the block keeps its height when text replaces it. Width: the detected box's width as a share of the region's width, clamped to 30–100%. No shimmer, no animation. `aria-hidden`. |
| Language tag | A trailing inline span after the block's text: `label` type (12px / 500), `text-secondary`, `margin-inline-start` 6px, `unicode-bidi: isolate`, in the UI language. Shown on translate-class blocks only when the region holds **two or more source languages**, or Settings › "Always show languages" is on. |
| Neutral block | GLIM-21 rule 1 (numbers, `OK`, `F5`, versions): its text as-is in `source` style. No tag, never counted as skipped, never translated. |
| Target-language block | Already in the target language: its text as-is in `translation` style with the tag "Already in {target}". Not counted as skipped. |
| Failed block | Source text in `source` style, then a row in `label` type: a 16px alert icon and "Not translated" in `danger`, plus a text button "Retry" (`label`, `link` colour). |
| Pack-missing block | Source text in `source` style. One **pack row** per missing language at the **top** of the list (not per block): `body` type, `text-secondary`, "{language} isn't downloaded yet." plus a `button-secondary` "Download ({size})". While downloading: `progress-track` / `progress-fill` (linear) and a `numeric` line "{done} of {total}". When it finishes, those blocks translate in place, and the row disappears. A language served by the long-tail model (SMaLL-100, GLIM-100) says so instead: "{language} needs the More languages model." **Large downloads** (over 200 MB, `LARGE_DOWNLOAD_BYTES`; GLIM-138) ask once: pressing Download replaces the row's text with the question (`body`, `text-primary`: what it is, its size, what it's for) and two buttons 8px apart, `button-primary` "Download ({size})" (focused, `aria-describedby` the question) and `button-secondary` "Not now" (back to the row, focus on its Download). Bergamot packs (20–60 MB) never ask. |
| Skipped line | Component `skipped-line` as the **last item of the list** (not in the footer: §14 decision 2). 24px, `label`, `text-secondary`, `rounded.control`, a 12px chevron at inline-start (points inline-end; rotates 90° when expanded, `duration-fast`). Text "{n} blocks skipped · {languages}". It is a `<button aria-expanded>`. Hover `overlay-hover`. Never a warning colour. |
| Skipped expansion | Under the line: each skipped block in `source` style with its language tag (always shown here), then a row with two text buttons in `label` type and `link` colour: "Translate these" (one-off, does not change settings) and "Edit source languages…" (opens Settings › Languages). |

### 2.3 Detection boxes (on screen)

Drawn by the picker's overlay windows in their results phase (`region-picker.md` §2 row L), from the moment OCR detection returns until the popup closes.

| Block class | Box |
|---|---|
| Translate, target-language | 1px `picker-stroke` + 1px `picker-halo`, `rounded.box`, no fill. |
| Skipped | Same stroke, dashed 3px / 3px, at 60% opacity. |
| Neutral | No box. |
| Linked (the block hovered or focused in the popup, or the box under the pointer on screen) | Fill `box-linked-fill`, stroke as its class. Only one at a time; the popup's hover or focus wins over the screen's. GLIM-152 made it work in both directions: the results layer hit-tests its own boxes (§5). |
| Badge (GLIM-152) | Component `box-badge`, on every box with a number (§2.2), centred on the box's top inline-start corner (UI direction) so it covers as little of the text as possible, clamped onto the display. A 20px pill (min-width 20px, 6px inline padding), `numeric` type in `picker-hud-text` on `picker-hud`, ringed 1px `picker-stroke` with the HUD shadow: the picker's dark-core, white-edge language, readable on any content. Skipped boxes' badges at 60% like their dashed box. Linked or picked: `accent` with `on-accent` digits, matching the popup number. Badges appear with the classes (at recognition) and stay until the popup closes, in overlay mode too. |

The selection edge stays drawn around the region (1px stroke + halo).

### 2.5 Overlay mode (on screen, GLIM-152)

For comics and busy layouts, where matching numbers is still work: the results layer paints each translation **over** its box. This is the one place Glimpse covers the source, so it is opt-in (Settings › General › "Show translations on screen", off by default, or the footer toggle per Snip) and the source is always one key away.

| Element | Tokens / values |
|---|---|
| Toggle | A footer `button-icon` before Show original (§2.4), speech-bubble-with-lines icon, `aria-pressed`, tooltip "Show translations on screen" / "Back to the list only" with `Ctrl+Shift+T` / `⌘⇧T`. Disabled until a translate-class block exists, and in error states. The popup itself stays as it is (list, footer, keys); the overlay is an addition. The ticket asked for a header toggle; the popup has no header (§14 decision 3), so it joins the footer's icon buttons. |
| Card | One per translate-class block with a final translation (pending, failed and waiting blocks keep their plain box and badge until there is something to paint). Opaque: `surface-popup-solid` background, `text-primary`, 1px `border-hairline` edge, the **Tooltip** shadow, `rounded.control`, 4px 6px padding, following the OS appearance (light or dark). Text in `translation` weight with the target language's script stack, size step and leading (`:lang()`), centred, `dir` of the target language (RTL targets right-to-left). The card sits on the box's top edge. |
| Fitting | Pure `fitText` (core): the largest size from 15px (the popup's `translation` size, × the script's size step) down to 11px in 0.5px steps at which the wrapped text fits the box, never breaking inside a word above the floor. At 11px, if it still doesn't fit, the card grows **downward**. A card is at least 72px wide, and widens around the box's centre (up to 240px) to fit its longest word, so a tall, narrow manga column doesn't get one letter per line. Lines wrap at spaces, and between words in scripts without spaces (CJK, Thai; `Intl.Segmenter`), punctuation staying with its word. The card is clamped onto the display. |
| Linked / picked | A 2px `accent` ring (the card hides the box fill). |
| Peek | Hold `Shift` in the popup (alone, no other modifier): every card goes transparent (`duration-fast` opacity; instant with reduced motion) and the source shows; releasing Shift, any other key or the popup losing key brings them back. Hovering a card on screen peeks at that card only. Original view (Ctrl/⌘⇧O) peeks at every card while it is on. The badges stay. Footer status while the overlay is on and the run is done: "Hold Shift to peek" ("Hold ⇧ to peek" on macOS). |
| Leaving | The toggle, `Ctrl/⌘⇧T`, or `Esc` (the first Esc leaves overlay mode; the next closes the popup). |
| Forced colours | Cards and badges: `Canvas` / `CanvasText` with a 1px `CanvasText` border; linked or picked: `Highlight` / `HighlightText`. |
| Capture | Cards and badges are drawn by the picker's overlay windows, which are excluded from Glimpse's own capture like the rest of the results layer (`region-picker.md` §9; GLIM-98): a new Snip over the same text never reads its own cards. |
| Accessibility | The marks are `aria-hidden`: the popup is the accessible surface for the same text, with the same numbers in its list. |

Screenshots (regenerate with `bun app/scripts/results-shots.ts` and `bun app/scripts/popup-shots.ts --shots docs/design/screens/snip-popup`): the manga fixture with badges, `docs/design/screens/results-layer/comic-badges-macos-light.png`; overlay mode, `comic-overlay-macos-light.png`, `comic-overlay-windows-dark.png` and `comic-overlay-peek-macos-light.png`; the popup for the same page, `docs/design/screens/snip-popup/s18-comic-markers-*.png` (bubble 3 picked on screen) and `s19-overlay-on-*.png`.

Live (the same overlay over a pinned region, updating in place) is a follow-up, GLIM-154: it waits for GLIM-151's movable Live popup.

### 2.4 Footer

One 24px row, `margin-block-start` `spacing.2` (8px), `padding-inline` 8px (aligned with block text). Items in order, inline-start to end:

| Item | Tokens / values |
|---|---|
| Provider indicator | Local: `local-indicator` (chip icon + "On device", `label`, `text-secondary`). Cloud: `egress-indicator` (pill, `egress-tint`, cloud icon, "Sent to {provider}", `egress`); cached cloud result adds " (remembered)" (GLIM-22). Never hidden or dismissable. |
| Private mark | When Private is on (GLIM-20): eye-off icon + "Private", `label`, `text-secondary`, `margin-inline-start` 8px. |
| Spacer | flex 1. |
| Status | `label`, `text-secondary`, `aria-live` (see §10). "Reading text" → "Translating {done} of {total}" → "Copied" (with a 16px check icon) for 2 s → empty. Errors: "Clipboard not changed". |
| Show original toggle | `button-icon` (24px), icon "text/original", `aria-pressed`. Pressed: `overlay-selected` background, icon `text-primary`. |
| Copy | `button-icon`, copy icon. |
| Close | `button-icon`, × icon. |

Icon buttons are 4px apart (`spacing.1`) and each has a tooltip (shadow **Tooltip**, `label` type) naming the action and its key (§11).

**Cloud footer wrap.** The egress pill is never truncated mid-name. If the footer can't fit it on one row, the pill moves to its own row above the status row (both 24px, 4px apart). If even the pill alone doesn't fit the popup width, it uses the provider registry's short name ("Sent to Google") and keeps the full text in its tooltip and `aria-label`.

**Drag region.** The footer's empty background is a window drag region (Electrobun's `electrobun-webkit-app-region-drag`). Controls inside it are `no-drag`. A dragged popup stays where it is dropped.

## 3. Sizing and placement

Pure function `placeSnipPopup(region, display, uiDir) → { side, frame, maxHeight, growth }`, unit-tested on Linux.

| Constant | Value |
|---|---|
| `GAP` (popup to region) | 8 |
| `MARGIN` (popup to work-area edge) | 8 |
| Width `W` | `clamp(region.width, 280, 480)`, and ≤ `workArea.width − 2·MARGIN` |
| `COMFORT_H` | 200 (about three blocks plus footer) |
| `MIN_H` | 96 (one block plus footer) |
| `MAX_H` | `min(0.6 × workArea.height, space on the chosen side)` |

**Display.** The display whose **work area** (excludes taskbar, menu bar, Dock) overlaps the region most; on a tie, the one under the pointer at confirm. The popup never spans displays.

**Side, first that fits** (spaces measured from the region edge to the work-area edge, minus `GAP + MARGIN`):

1. **Below** if space below ≥ `COMFORT_H`.
2. **Above** if space above ≥ `COMFORT_H`.
3. **Inline-end** side if the space there ≥ 280 (width becomes `min(W, space)`).
4. **Inline-start** side, same test.
5. **Below or above**, whichever has more space, if it is ≥ `MIN_H`.
6. **Inside** (the only case that may cover the region): inside the region's bottom inline-end corner, inset 8px, with `MAX_H` = 60% of the region height (at least `MIN_H`). This only happens when the region fills nearly the whole display, and the popup can then be dragged away.

This follows DESIGN.md (below, above, inline-end, inline-start). The low-fidelity flows drew right → left → below → above; see owner question 1.

**Cross-axis alignment.** Below/above: the popup's inline-start edge lines up with the region's inline-start edge, then it is clamped into `[workArea + MARGIN]`. Sides: the popup's top lines up with the region's top, clamped the same way.

**Growth.** Height follows content up to `MAX_H`; past that the list scrolls and the footer stays pinned. The edge facing the region is anchored: below → the top edge is fixed and the popup grows down; above → the bottom edge (8px above the region) is fixed and it grows up; sides → the top is fixed, and the popup slides up only when its bottom would cross the work-area margin. Width is fixed at show time and never changes.

**DPI.** The frame is computed in logical px and its origin and size are rounded to the target display's device-pixel grid. Moving a hidden pre-created window to another display is done **before** showing it, so the webview re-rasterises at the new scale while hidden (Windows `WM_DPICHANGED`).

**Minimum content.** A single short word still gets the full `W` (≥ 280) so the footer fits. The height is whatever the content needs (about 12 + 30 + 8 + 24 + 12 = 86px for one line).

## 4. States

IDs match the mockup. "Reading order" is defined in §8.

| ID | State | What shows | Footer status | Clipboard |
|---|---|---|---|---|
| S0 | **Opened** (before OCR detection returns) | Two skeleton bars (70%, 45%). | "Reading text" | – |
| S1 | **Detected** | One skeleton bar per detected box, in reading order. Boxes appear on screen. | "Reading text" | – |
| S2 | **Recognised** (per block, as each arrives) | Translate-class: pending source. Neutral and target-language: final. Skipped: counted into the skipped line (it appears when the first skip is known). | "Translating 0 of {n}" | – |
| S3 | **Streaming / partial** | Translations replace pending source block by block (§8). Unfinished blocks keep their pending source. | "Translating {done} of {n}" | – |
| S4 | **Done** | All translations. | "Copied" ✓ for 2 s, then empty | Written (§6) |
| S4b | Done, auto-copy off | Same. | empty | not written |
| S5 | **Show original under translation** | Each translation with its source line beneath. | – | – |
| S6 | **Original view** (`Ctrl/⌘⇧O` or the toggle) | Every block shows its OCR text in `translation` type (it is now the content), with the block's own `lang` and direction. Neutral blocks unchanged. Toggle pressed. | "Showing original" | unchanged |
| S7 | **Skipped collapsed / expanded** | §2.2. | – | Skipped blocks are never copied unless translated with "Translate these". |
| S8 | **Mixed languages** | Language tags on translate-class blocks. | – | – |
| S9 | **RTL source** (Arabic, Hebrew…) | Translation view: target direction (LTR for English). Original view: each block `dir="auto"`, right-aligned for RTL, embedded Latin and numbers in correct bidi order (`unicode-bidi: plaintext`). Popup chrome stays in the UI direction. | – | – |
| S10 | **RTL target or RTL UI** | Target Arabic: translations right-aligned per block. RTL UI: chrome mirrors (footer order reverses, skipped chevron points left), placement uses the RTL inline-end (left). | – | – |
| S11 | **Mixed scripts in one region** | Each block takes its own script stack and leading (`:lang()`), so a CJK block doesn't change Latin lines' leading. | – | – |
| S12 | **Very long** (many blocks, or a long paragraph) | List scrolls inside `MAX_H`; footer pinned; divider shown. Blocks are never truncated or clamped. | "Translating 12 of 40" | – |
| S13 | **Very short** (one word) | One block, popup at minimum width. | – | – |
| S14 | **Cloud in use** | Egress pill in the footer (wraps per §2.4). Tooltip names what was sent: "Text sent to {provider} ({n} segments)" or "Image of the selected area sent to {ocrProvider}". | – | – |
| S14b | Cloud, remembered | "Sent to {provider} (remembered)". | – | – |
| S15 | **Private on** | Private mark in the footer. | – | – |
| S16 | **Partial failure** | Failed blocks per §2.2; others done. | "Translated {done} of {n}" | Written with the successful blocks; failed blocks contribute their source text. |
| E1 | **No text found** | Error body (§4.1). | "Clipboard not changed" | not written |
| E2 | **Language pack missing** (every translate-class block) | Error body with Download; original text listed below it in `source` style. Partial case: pack row at the top of the list instead (§2.2). | "Clipboard not changed" | not written |
| E3 | **Cloud provider error** | Error body; original listed below. Variants: rejected key, quota, timeout, offline. | "Clipboard not changed" | not written |
| E4 | **Screen access lost** (macOS) / **capture failed** (blank or all-black capture) | Error body. | "Clipboard not changed" | not written |
| E5 | **Nothing to translate** (every block skipped) | Error body; the skipped line is shown **expanded**. | "Clipboard not changed" | not written |
| E6 | **Only neutral or target-language blocks** | Not an error: the blocks as-is. | empty | not written |
| E7 | **Text recognition failed** (OCR engine error) | Error body. | "Clipboard not changed" | not written |

### 4.1 Error body

Replaces the block list's top. A heading line in `heading` (15px / 600, `text-primary`), one paragraph in `body` (`text-secondary`), then up to two buttons in a row (`spacing.2` apart): the first is `button-primary` only when it is the obvious recovery, otherwise both are `button-secondary`. A 16px status icon precedes the heading: `danger` for E3/E4/E7, `text-secondary` for E1/E2/E5. Keyboard focus moves to the first button. Exact copy is in §12.

## 5. Pointer behaviour

| Input | Result |
|---|---|
| Hover a block | `overlay-hover`, linked box lights on screen. Leaving clears it. |
| Hover a box, badge or card on screen (GLIM-152) | Its popup block lights (and its number); the box fills. A card under the pointer peeks (§2.5). |
| Click a box, badge or card on screen (GLIM-152) | **Picks** the block: the popup scrolls to it and highlights it (§2.2) and takes key back, so its keys keep working. Not a dismiss. |
| Click / drag in a block | Normal text selection (`user-select: text`), themed `::selection` = `overlay-selected`. |
| Click the skipped line | Expand / collapse. |
| Click outside the popup | **Dismiss.** The overlay windows stay on screen as a full-display hit-catcher during the popup's life, so the click lands on them and is consumed (not passed to the app below). Owner question 3. GLIM-152: the overlay view hit-tests the press itself (cards and badges by element, then the smallest box containing the point within 2px; badges count within 12px of their centre) and sends the block id with it; only a press on no box dismisses. The click takes key from the popup: for 400 ms after a pick, the popup's loss of key is its own and it re-activates instead of starting the app-switch grace (§7.5). |
| Drag the footer background | Moves the popup window. |
| Wheel / trackpad | Scrolls the list. |
| Right-click | The webview's default context menu is disabled; nothing happens in v1. |
| Hover an icon button | `button-icon-hover` (`overlay-hover`, `text-primary`), tooltip after 500 ms. |

## 6. Clipboard

- Written once, when every translate-class block has a final result (translated or failed), if at least one block was translated and Settings › "Copy translation after Snip" is on (default on).
- Content: blocks in reading order, one per line (`\n`; `\r\n` on Windows), as displayed in translation view: translations, neutral blocks, target-language blocks, and failed blocks' source text. Skipped blocks are left out unless "Translate these" translated them; then the clipboard is rewritten once with them included.
- Plain text only.
- Errors never touch the clipboard.
- `Ctrl/⌘C` (no text selection) copies the translation text again; `Ctrl/⌘⇧C` copies the original (all non-skipped blocks' OCR text, reading order). Each shows "Copied" for 2 s.

## 7. Focus rules

1. The picker was key; on confirm the **Snip popup is shown with activation** and becomes key (Glimpse is already the active app, so this never fails for focus-stealing reasons).
2. DOM focus goes to the block list container (`tabindex="-1"`, no focus ring on the container itself). The first `Tab` or arrow moves into the blocks.
3. In error states, focus goes to the first action button.
4. **Dismiss** (Esc, click outside, Close button, a new Snip or Live hotkey): hide the popup and the overlays, then `glim_focus_restore()` to the app saved at picker open (`region-picker.md` §7). A new hotkey dismisses without restoring (the new picker takes over).
5. **Popup loses key to another app** (`Cmd+Tab`, `Alt+Tab`, a notification): dismiss without restoring focus. Owner question 4.
6. Focus is trapped inside the popup while open: `Tab` wraps from the last control to the first block.

## 8. Timing and streaming order

`t0` = pointer release or Enter.

| Step | When | Notes |
|---|---|---|
| Region capture starts | t0 | Overlays stay up; our windows are excluded from capture. |
| Popup visible (S0) | ≤ t0 + 100 ms p95 (target, unmeasured) | Pre-created window: Bun sends `snip/open`, the view resets and reports `painted` after two `requestAnimationFrame`s, then Bun shows it. If `painted` takes more than 32 ms, show anyway. |
| S1 | When OCR detection returns | Skeleton bars and on-screen boxes in the same frame. |
| S2 | As recognition returns each block | Language detection runs per block (≈ 0.05 ms, GLIM-21) before rendering, so the class is known when text first appears. |
| S3 | As translations return | Cache hits render at once, possibly before earlier blocks; every block has a fixed slot, so out-of-order arrival never moves other blocks. |
| S4 | When the last translate-class block is final | Clipboard write, then "Copied". |
| Cloud timeout | 10 s per request | Then E3 (timeout), or per-block failure if other blocks succeeded. |

**Reading order** (`readingOrder(boxes, dir)`, pure). Group boxes into lines when their vertical overlap is ≥ 50% of the shorter box's height. Order lines top to bottom, and boxes inside a line left to right. At the first recognised batch, if ≥ 50% of the recognised letters so far are in an RTL script, re-order boxes within each line right to left. This happens once, before any translation is shown, with no animation. Multi-column layouts are out of scope for this function: OCR block grouping (GLIM-56) owns columns.

**Streaming granularity.** Bergamot and the first cloud provider return whole segments (sentences), not tokens. A block made of several segments fills segment by segment: translated segments, then the remaining segments' source text. If a provider streams tokens, tokens append to the block's text at most once per animation frame, with no per-token animation and no caret.

**Order of translation work.** Translate-class blocks are submitted in reading order (one batch per GLIM-85), so the first visible block is usually first to finish.

## 9. Motion

| Moment | Motion | Reduced motion |
|---|---|---|
| Popup enter | Opacity 0 → 1 and scale 0.98 → 1, `duration-base` (160 ms), `ease-out`, `transform-origin` on the edge facing the region (top for below, bottom for above, inline-start/end for sides). The window is shown at full size; only the content animates, and first paint is never delayed. | Opacity only, `duration-fast`. |
| Popup exit | Opacity → 0, `duration-exit` (80 ms), `ease-exit`. | Instant. |
| Skeleton → source text | None (text replaces the bar). | None. |
| Pending source → translation | Opacity crossfade, `duration-fast` (100 ms), `ease-standard`: the translation fades in over the outgoing source. | Instant swap. |
| Height growth | The window grows to the new content height in one frame. Content never slides. | Same. |
| Skipped expand / collapse | Height via the spring is **not** used (DESIGN.md reserves it for Live). Expansion appears at once; the chevron rotates in `duration-fast`. | Chevron jumps. |
| Hover / press | Background, `duration-fast`, `ease-standard`. | Same (opacity/colour only). |
| "Copied" | Text swap, no motion. | Same. |

No spinners and no shimmer anywhere.

## 10. Accessibility

- Root: `role="dialog"`, `aria-modal="true"`, `aria-label="Translation"` (copy `snip.a11y.dialog`), `lang` = UI language, `dir` = UI direction.
- Block list: `role="list"`, `aria-label` `snip.a11y.list`. Each block `role="listitem"` with roving `tabindex` (the focused one 0, others −1); `aria-busy="true"` while pending. Translation and source spans carry `lang`. Language tags are real text, not `aria-hidden`.
- Skeleton bars `aria-hidden="true"`.
- Status (footer status) `role="status"` (polite). It announces only: "Reading text", "Translating", the final "Translated {n} blocks. Copied to clipboard." (or "Translated {n} blocks."), and errors' heading. It does not announce each block.
- Error state: focus moves to the first action; the heading is the dialog's `aria-describedby`.
- Icon buttons have `aria-label` + tooltip; toggles use `aria-pressed`; the skipped line uses `aria-expanded` + `aria-controls`.
- Contrast on the 90% veil (computed over pure white / pure black, worst case): `text-primary` 12.4:1 light, 10.1:1 dark; `text-secondary` 5.45:1 / 5.53:1; `egress` on its tint 5.2:1 / 4.8:1; `danger` 4.85:1 / 4.55:1. **`accent` is never used as text** (4.25:1 on light over black fails).
- `forced-colors: active`: blocks use `Canvas`/`CanvasText`, hover and focus use `Highlight`; the egress pill gets a 1px `CanvasText` border so it doesn't rely on its tint.
- Text scaling: every size is in rem (DESIGN.md), so OS text scaling enlarges the popup; width limits scale with it.

## 11. Keyboard map

Never global. Windows / macOS.

| Key | Action |
|---|---|
| `Esc` | Close (always; one keystroke, even with the skipped list expanded). Overlay mode: the first Esc leaves it, the next closes (GLIM-152). |
| `Ctrl+C` / `⌘C` | Copy translation; if text is selected in the popup, copy the selection instead. |
| `Ctrl+Shift+C` / `⌘⇧C` | Copy original. |
| `Ctrl+Shift+O` / `⌘⇧O` | Toggle original view. |
| `Ctrl+Shift+T` / `⌘⇧T` | Toggle overlay mode (GLIM-152, §2.5). |
| `Shift` (held) | Overlay mode only: peek at the source under the cards. |
| `↑` / `↓` | Previous / next block (the skipped line and its expanded blocks are part of the sequence). |
| `Home` / `End` | First / last block. |
| `Enter` / `Space` on the skipped line | Expand / collapse. |
| `Tab` / `Shift+Tab` | Blocks (one stop) → footer buttons → (error) action buttons, wrapping. |
| `Ctrl+A` / `⌘A` | Select all popup text. |

## 12. Copy

`{…}` placeholders; plurals via `Intl.PluralRules`; language names via `Intl.DisplayNames` in the UI language; list joins via `Intl.ListFormat` (`type: "conjunction"`, style `narrow` or `short`, with ", " in English). Sizes via a byte formatter ("31 MB").

| ID | String |
|---|---|
| `snip.status.reading` | Reading text |
| `snip.status.translating` | Translating {done} of {total} |
| `snip.status.partial` | Translated {done} of {total} |
| `snip.status.copied` | Copied |
| `snip.status.original` | Showing original |
| `snip.status.clipboardUnchanged` | Clipboard not changed |
| `snip.local` | On device |
| `snip.local.tooltip` | Text was read and translated on this device. Nothing was sent. |
| `snip.egress` | Sent to {provider} |
| `snip.egress.remembered` | Sent to {provider} (remembered) |
| `snip.egress.tooltip.text` | Text sent to {provider} ({n} segments) |
| `snip.egress.tooltip.image` | Image of the selected area sent to {ocrProvider} |
| `snip.egress.tooltip.both` | Text read by {ocrProvider} · Translated by {translationProvider} |
| `snip.private` | Private |
| `snip.private.tooltip` | Private is on. Nothing from this Snip is remembered. |
| `snip.tag.already` | Already in {targetLanguage} |
| `snip.skipped` | {n} block skipped · {languages} / {n} blocks skipped · {languages} |
| `snip.skipped.translate` | Translate these |
| `snip.skipped.edit` | Edit source languages… |
| `snip.block.failed` | Not translated |
| `snip.block.retry` | Retry |
| `snip.pack.row` | {language} isn't downloaded yet. |
| `snip.pack.download` | Download ({size}) |
| `snip.pack.model` | {language} needs the More languages model. |
| `snip.pack.confirm.model` | Download the More languages model ({size})? It translates {language} and about 100 other languages on this device. It's slower than language packs and uses about 1 GB of memory while it translates. |
| `snip.pack.confirm.large` | Download {size} to translate {language}? This is a large download. |
| `snip.pack.confirm.cancel` | Not now |
| `snip.pack.progress.model` | Downloading the More languages model (progress bar name) |
| `snip.pack.progress` | {done} of {total} |
| `snip.btn.original` | Show original ({key}) |
| `snip.btn.originalOff` | Show translation ({key}) |
| `snip.btn.copy` | Copy translation ({key}) |
| `snip.btn.close` | Close (Esc) |
| `snip.e1.title` | No text found |
| `snip.e1.body` | Glimpse couldn't find any text in this area. Try a larger area, or zoom in so the text is bigger. |
| `snip.e1.primary` | Snip again |
| `snip.e1.secondary` | Close |
| `snip.e2.title` | {language} isn't downloaded yet |
| `snip.e2.titleMany` | {n} languages aren't downloaded yet |
| `snip.e2.body` | The text was read, but Glimpse needs the {language} language pack to translate it. The original text is below. |
| `snip.e2.primary` | Download {language} ({size}) |
| `snip.e2.model.body` | The text was read, but Glimpse needs the More languages model to translate {language}. The original text is below. |
| `snip.e2.model.primary` | Download ({size}): over 200 MB it first shows `snip.pack.confirm.*` in place of the buttons |
| `snip.e2.secondary` | Copy original |
| `snip.e3.key.title` | {provider} rejected the API key |
| `snip.e3.key.body` | Nothing was translated. Check the key in Settings. |
| `snip.e3.quota.title` | {provider}'s quota for this key is used up |
| `snip.e3.quota.body` | Nothing was translated. The quota resets on {provider}'s schedule, or you can translate on this device. |
| `snip.e3.timeout.title` | {provider} didn't answer within 10 seconds |
| `snip.e3.timeout.body` | The text may have reached {provider}, but no translation came back. |
| `snip.e3.offline.title` | You're offline |
| `snip.e3.offline.body` | Nothing was sent. Connect to the internet, or translate on this device. |
| `snip.e3.retry` | Retry |
| `snip.e3.local` | Translate on this device |
| `snip.e3.checkKey` | Check key… |
| `snip.e4.title` | Glimpse can't see your screen |
| `snip.e4.body` | Screen Recording permission is off, or was reset by an update. The capture came back blank. |
| `snip.e4.primary` | Open System Settings |
| `snip.e4.secondary` | Why does this happen? |
| `snip.e4w.title` | Glimpse couldn't capture this area |
| `snip.e4w.body` | The capture came back blank. Protected video and some fullscreen games block screen capture. |
| `snip.e5.title` | Nothing to translate |
| `snip.e5.body` | Every block is in a language outside your source languages. |
| `snip.e7.title` | Text recognition stopped |
| `snip.e7.body` | Glimpse's text recognition model failed to run. Snip again, and if it keeps happening, reinstall Glimpse. |
| `snip.e7.primary` | Snip again |
| `snip.btn.overlay` | Show translations on screen ({key}) |
| `snip.btn.overlayOff` | Back to the list only ({key}) |
| `snip.status.peek` | Hold {key} to peek |
| `settings.snip.showOnScreen` | Show translations on screen. Each translation covers the text it translates, for comics and busy layouts. |
| `snip.a11y.dialog` | Translation |
| `snip.a11y.list` | Translated text |
| `snip.a11y.done` | Translated {n} blocks. Copied to clipboard. |
| `snip.a11y.doneNoCopy` | Translated {n} blocks. |

"Translate on this device" appears only when the needed local packs are installed. E3's Retry is `button-primary` for timeout and offline; "Check key…" is primary for a rejected key.

## 13. Implementation notes

### 13.1 Window

| | macOS | Windows 11 | Windows 10 / reduced transparency |
|---|---|---|---|
| Creation | One Electrobun `BrowserWindow`, **pre-created hidden at launch**, `transparent: true`, `titleBarStyle: "hidden"`. Reused for every Snip. | Same, but `titleBarStyle: "hiddenInset"` to keep the DWM frame (shadow, corners, backdrop); spike §3. | Same as Windows 11, no backdrop. |
| Material | Helper inserts `NSVisualEffectView` (`.popover`, `.behindWindow`, `.active`) below the webview, `maskImage` rounded 12px; `hasShadow = YES` + `invalidateShadow` after each resize. | `DwmExtendFrameIntoClientArea(-1)`, `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_TRANSIENTWINDOW`, `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`, `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`. | Solid veil, radius 0. |
| Level | 101 (pop-up menu), above the lowered overlays (100). | `HWND_TOPMOST`, re-asserted after the overlays. | Same. |
| Activation | Shown with `show()` (key + active). Not a non-activating panel: Snip needs keys. | `show()`; `WS_EX_TOOLWINDOW` (no taskbar button). | Same. |
| Spaces | `CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle`, `FullScreenPrimary` removed. | – | – |
| Capture exclusion | SCK app-level exclusion; `sharingType = .none` on ≤ 14. | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. | Same. |
| Frame | `glim_window_set_frame` (global logical; avoids Electrobun's Y-flip bug). Size changes are a single native `setFrame:display:` call so the anchored edge doesn't jitter. | `SetWindowPos` with position and size together. | Same. |
| Hide | `orderOut`. | DWM cloak (`DWMWA_CLOAK = TRUE`), so the webview keeps rendering and the next show has no stale frame (spike §4). | Same. |
| Resizable edges | n/a | `hiddenInset` makes the window resizable by its edges; until a `WM_NCHITTEST` hook exists (native DLL), this is an accepted gap. | Same. |
| Appearance and prefs | Shell injects `data-os`, `--os-accent`, reduced motion and reduced transparency (polled ≤ 1 s until native notifications exist). | Same, from the registry. | Same. |

Height changes: the view measures content with a `ResizeObserver`, coalesces to one `snip/resize` per animation frame, and Bun computes the new frame from the anchored edge and `MAX_H`.

### 13.2 RPC (typed sketch)

Paths per `ARCHITECTURE.md`: controller `app/src/bun/windows/snip-popup.ts`, view `app/src/views/snip/`, pure logic (`placeSnipPopup`, `readingOrder`, `clipboardText`, view-state reducer) in `packages/core/src/popup/`, presentational blocks, skipped line and provider badge in `packages/ui/src/components/` (shared with Live, GLIM-42). Each union member below becomes a named message in `SnipRPC` (§5 naming): main → view events such as `opened`, `blocksDetected`, `blocksRecognised`, `blocksReordered`, `translationUpdated`, `packChanged`, `progressChanged`, `copied`, `providerChanged`, `failed`; view → main intents such as `painted`, `resized`, `blockHovered`, `copyRequested`, `originalToggled`, `translateSkipped`, `retryBlock`, `actionInvoked`, `dismissed`. The `t` discriminant is only shorthand for this sketch.

```ts
type BlockClass = "translate" | "skip" | "neutral" | "target";
import type { Rect } from "@glimpse/core";   // { x, y, width, height }

interface ProviderBadge {
  local: boolean;
  label: string;            // "On device" | "Sent to Google Cloud Translation"
  shortLabel?: string;      // "Sent to Google"
  tooltip: string;
  remembered?: boolean;
}

type SnipToView =
  | { t: "open"; requestId: string; os: "macos" | "windows"; uiLang: string; uiDir: "ltr" | "rtl";
      side: "below" | "above" | "inline-end" | "inline-start" | "inside"; width: number; maxHeight: number;
      targetLang: string; showOriginalUnder: boolean; autoCopy: boolean; private: boolean;
      provider: ProviderBadge; reducedMotion: boolean; keys: Record<string, string> }
  | { t: "detected"; requestId: string; blocks: Array<{ id: string; order: number; widthShare: number }> }
  | { t: "recognised"; requestId: string; blocks: Array<{ id: string; text: string; lang: string | null;
      langName: string | null; cls: BlockClass; needsPack?: { lang: string; size: number } }> }
  | { t: "reorder"; requestId: string; order: string[] }          // once, RTL re-order (§8)
  | { t: "translation"; requestId: string; id: string; text: string; final: boolean; failed?: boolean }
  | { t: "pack"; requestId: string; lang: string; langName: string; state: "missing" | "downloading" | "done";
      done?: number; total?: number }
  | { t: "progress"; requestId: string; done: number; total: number }
  | { t: "copied"; requestId: string; what: "translation" | "original" }
  | { t: "provider"; requestId: string; provider: ProviderBadge }  // e.g. "Translate on this device" switched it
  | { t: "error"; requestId: string; kind: "noText" | "packMissing" | "providerKey" | "providerQuota"
      | "providerTimeout" | "offline" | "screenAccess" | "captureBlank" | "nothingToTranslate" | "ocrFailed";
      params: Record<string, string>; actions: Array<"snipAgain" | "close" | "download" | "copyOriginal"
      | "retry" | "local" | "checkKey" | "openSettings" | "why"> };

type SnipFromView =
  | { t: "painted"; requestId: string }
  | { t: "resize"; requestId: string; contentHeight: number }
  | { t: "hoverBlock"; requestId: string; id: string | null }      // → overlay linked box
  | { t: "overlay"; requestId: string; on: boolean }               // GLIM-152 overlay mode (snipOverlay)
  | { t: "peek"; requestId: string; on: boolean }                  // GLIM-152 Shift held (snipPeek)
  | { t: "copy"; requestId: string; what: "translation" | "original" }
  | { t: "toggleOriginal"; requestId: string; on: boolean }
  | { t: "translateSkipped"; requestId: string }
  | { t: "retryBlock"; requestId: string; id: string }
  | { t: "action"; requestId: string; action: string; lang?: string }
  | { t: "dismiss"; requestId: string; reason: "esc" | "close" | "outside" | "blur" };

// To the overlay views (results layer, region-picker.md §9.4 `results`):
interface SnipBoxesState {          // ResultsLayerState in @glimpse/core
  requestId: string;
  region: Rect;
  boxes: Array<{ id: string; rect: Rect; cls: BlockClass; badge?: number }>;  // GLIM-152 numbers
  linkedId: string | null;
  selectedId?: string | null;                                     // GLIM-152 picked on screen
  overlay?: { cards: Array<{ id: string; text: string; lang: string | null; dir: "ltr" | "rtl" }>; peek: boolean } | null;
  uiDir?: "ltr" | "rtl";
}
// Overlay → main (picker pointer messages on the results layer) carry `blockId: string | null`,
// the view's own hit test; main turns a press into a pick or a dismiss, a move into screen hover.
```

Every message carries `requestId`; the view drops messages for an older request (a quick second Snip can't mix results).

The clipboard is written by Bun (Electrobun clipboard API), not the webview, so it works when the webview isn't focused.

### 13.3 Pure modules and tests (Linux)

`placeSnipPopup` (every side, edges, RTL UI, inside fallback, mixed-DPI rounding), GLIM-152's `blockNumbers`, `fitText` / `wrapText`, `hitResultsBox`, `overlayCards` and the reducer's `toggleOverlay` / `select` / `screenHover` / `peek`, `readingOrder` (lines, RTL re-order), `clipboardText` (classes, failed blocks, skipped rules), `footerLayout(width, badge)` (wrap and short-name rules), `skippedSummary` (plural and language lists), and the view's reducer from `SnipToView` messages to rendered state (slot stability: a late translation for block 1 never moves block 3).

## 14. Decisions made in this spec (to fold back into DESIGN.md, GLIM-93)

1. Placement follows DESIGN.md (below first), with numbers for "fits" (`COMFORT_H` 200, `MIN_H` 96) and an inside fallback.
2. **The skipped line is the last row of the block list**, not part of the footer: its expansion needs to live in the scrolling list, and the footer has no room at 280px.
3. Footer gets **Show original, Copy and Close** icon buttons; there is still no header.
4. **Language tags** only when the region is mixed (or by setting).
5. **Click outside dismisses and is consumed**, because the overlays act as the hit-catcher (no window-level click-through exists in Electrobun, spike §8).
6. Windows 10 popup radius is **0** (spike §8).
7. Missing packs show **one row per language** at the top of the list, not a row per block.
8. (GLIM-152) **Numbers, not lines:** blocks and their boxes share a number in reading order rather than leader lines drawn across the screen. Skipped blocks are numbered too, so numbers never change.
9. (GLIM-152) **Overlay mode covers the source**, against DESIGN.md's margin-note rule, because comic readers asked for it: opt-in, opaque, one key from the source, off by default.
10. (GLIM-152) The overlay toggle lives in the **footer**, not a new header.

## 15. Open questions for the owner

1. Placement order: below → above → sides (DESIGN.md, chosen) or right → left → below → above (flows)?
2. Should "Show original under translation" be on by default? (Chosen: off; language learners can turn it on.)
3. Click outside the popup dismisses it but the click doesn't reach the app underneath. Acceptable?
4. Dismiss the popup when the user switches apps (chosen), or keep it open until Esc so they can read it while typing elsewhere?
5. Per-block language tags: only for mixed regions (chosen), always, or hover-only? (flows question 6)
6. Low-confidence OCR (flows D7): flag unclear blocks, or not at all? Not specified here.
7. Does a cached cloud result need "(remembered)" in the footer, or only in the tooltip?

## 16. Acceptance checklist

- [ ] Popup visible ≤ 100 ms after release with skeleton bars; boxes and bars appear together when detection returns.
- [ ] Source text, then translations, fill fixed slots; nothing above a block moves when it fills.
- [ ] Placement picks below/above/sides/inside per §3 on every display edge, in LTR and RTL UI, and on mixed DPI.
- [ ] Clipboard holds translated + neutral + target-language blocks in reading order; skipped excluded; errors leave it alone.
- [ ] Original view, show-original-under, skipped expand, Translate these, mixed and RTL samples all render per §4.
- [ ] Cloud pill visible on every cloud result, wraps rather than truncating, names what was sent in its tooltip.
- [ ] Every error state has its exact copy and a keyboard-reachable recovery.
- [ ] Esc, click outside and Close dismiss and return focus to the previous app.
- [ ] Reduced motion: no scale, no crossfade longer than 100 ms.
- [ ] (GLIM-152) Every boxed block has a badge with the same number as its popup block; clicking a box or badge picks the block and keeps the popup open; clicking elsewhere dismisses.
- [ ] (GLIM-152) Overlay mode paints fitted cards over their boxes, Shift and hover peek, Esc and the toggle leave it, the setting opens Snips in it, and a new Snip never reads the cards.
