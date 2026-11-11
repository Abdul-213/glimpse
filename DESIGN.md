---
name: Glimpse
description: Screen OCR translator that sits beside the text it explains and looks like part of the OS.
colors:
  # Every theme-aware colour has a light value (bare key) and a dark sibling (`-dark`).
  # Emit both as one CSS custom property with light-dark(); see "Token mapping" in Overview.
  surface-popup: "#F5F5F7E6"
  surface-popup-dark: "#262628E6"
  surface-popup-solid: "#F5F5F7"
  surface-popup-solid-dark: "#262628"
  surface-window: "#F2F2F4B8"
  surface-window-dark: "#1F1F21B8"
  surface-window-solid: "#F2F2F4"
  surface-window-solid-dark: "#1F1F21"
  surface-group: "#FFFFFFE6"
  surface-group-dark: "#2C2C2FE6"
  surface-group-solid: "#FFFFFF"
  surface-group-solid-dark: "#2C2C2F"
  surface-control: "#FFFFFF"
  surface-control-dark: "#3A3A3D"
  # The 0.5px dark line macOS draws outside dark panels; nothing in light appearance.
  popup-outline: "#00000000"
  popup-outline-dark: "#000000A6"
  # macOS switch knob (white in light, near-white in dark, as AppKit draws it).
  knob: "#FFFFFF"
  knob-dark: "#E6E6E9"
  overlay-hover: "#0000000F"
  overlay-hover-dark: "#FFFFFF14"
  overlay-pressed: "#0000001A"
  overlay-pressed-dark: "#FFFFFF24"
  overlay-selected: "#0A63C91F"
  overlay-selected-dark: "#6AAAFF29"
  text-primary: "#1D1D1F"
  text-primary-dark: "#F4F4F6"
  text-secondary: "#55555C"
  text-secondary-dark: "#B6B6BE"
  text-disabled: "#8E8E93"
  text-disabled-dark: "#6C6C72"
  border-hairline: "#0000001F"
  border-hairline-dark: "#FFFFFF1F"
  border-control: "#76767D"
  border-control-dark: "#8E8E96"
  divider: "#00000014"
  divider-dark: "#FFFFFF14"
  accent: "#0A63C9"
  accent-dark: "#2A6FD9"
  on-accent: "#FFFFFF"
  on-accent-dark: "#FFFFFF"
  link: "#0959BA"
  link-dark: "#6AAAFF"
  focus-ring: "#0A63C9"
  focus-ring-dark: "#6AAAFF"
  success: "#156A37"
  success-dark: "#5BC987"
  warning: "#8A4B00"
  warning-dark: "#F2A93B"
  danger: "#B42318"
  danger-dark: "#FF8073"
  egress: "#5E32AE"
  egress-dark: "#C4B0FF"
  egress-tint: "#5E32AE1A"
  egress-tint-dark: "#C4B0FF1A"
  change-flash: "#0A63C924"
  change-flash-dark: "#6AAAFF1F"
  change-rest: "#0A63C90F"
  change-rest-dark: "#6AAAFF0F"
  change-mark: "#0A63C9"
  change-mark-dark: "#6AAAFF"
  # Picker overlay colours are theme-independent: they sit on arbitrary screen content.
  picker-scrim: "#00000073"
  picker-stroke: "#FFFFFF"
  picker-halo: "#00000099"
  picker-hud: "#1C1C1EE0"
  picker-hud-text: "#F5F5F7"
  picker-hud-text-secondary: "#B8B8BF"
  box-linked-fill: "#0A63C93D"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "normal"
  translation:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  source:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "normal"
  numeric:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Noto Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "normal"
    fontFeature: "'tnum' 1"
rounded:
  box: "3px"
  kbd: "4px"
  control: "6px"
  control-win: "4px"
  popup: "12px"
  popup-win: "8px"
  # Windows 10 has no DWM corner rounding, so the window is square and the veil must match.
  popup-win10: "0px"
  pill: "999px"
spacing:
  "0": "0px"
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  popup-snip:
    backgroundColor: "{colors.surface-popup}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.popup}"
    padding: "12px"
    width: "min(480px, max(280px, var(--region-width)))"
  popup-live:
    backgroundColor: "{colors.surface-popup}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.popup}"
    padding: "8px 12px 12px"
    width: "clamp(240px, var(--region-width), 640px)"
  block-translation:
    textColor: "{colors.text-primary}"
    typography: "{typography.translation}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
  block-source:
    textColor: "{colors.text-secondary}"
    typography: "{typography.source}"
  block-changed:
    backgroundColor: "{colors.change-flash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
  block-changed-rest:
    backgroundColor: "{colors.change-rest}"
  skipped-line:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
    height: "24px"
  egress-indicator:
    backgroundColor: "{colors.egress-tint}"
    textColor: "{colors.egress}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
  local-indicator:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    height: "20px"
  block-live:
    textColor: "{colors.text-primary}"
    typography: "{typography.translation}"
    rounded: "{rounded.control}"
    padding: "4px 8px 4px 20px"
  change-mark:
    backgroundColor: "{colors.change-mark}"
    rounded: "{rounded.pill}"
    size: "6px"
  language-tag:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
  skeleton-bar:
    backgroundColor: "{colors.overlay-pressed}"
    rounded: "{rounded.box}"
    height: "10px"
  popup-footer:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    padding: "0 8px"
    height: "24px"
  live-strip:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    height: "28px"
  status-dot:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    size: "8px"
  cloud-row:
    height: "24px"
  tooltip:
    backgroundColor: "{colors.surface-popup-solid}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.kbd}"
    padding: "4px 8px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-secondary:
    backgroundColor: "{colors.surface-control}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "28px"
  button-icon:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
    size: "24px"
  button-icon-hover:
    backgroundColor: "{colors.overlay-hover}"
    textColor: "{colors.text-primary}"
  button-toggle:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 8px 0 6px"
    height: "24px"
  button-toggle-pressed:
    backgroundColor: "{colors.overlay-selected}"
    textColor: "{colors.text-primary}"
  field:
    backgroundColor: "{colors.surface-control}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "28px"
  kbd:
    backgroundColor: "{colors.surface-control}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.kbd}"
    padding: "1px 6px"
    height: "20px"
  progress-track:
    backgroundColor: "{colors.overlay-pressed}"
    rounded: "{rounded.pill}"
    height: "4px"
  progress-fill:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    height: "4px"
  switch:
    backgroundColor: "{colors.overlay-pressed}"
    rounded: "{rounded.pill}"
    width: "32px"
    height: "18px"
  switch-knob:
    backgroundColor: "{colors.knob}"
    rounded: "{rounded.pill}"
    size: "14px"
  switch-checked:
    backgroundColor: "{colors.accent}"
  switch-win:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    width: "40px"
    height: "20px"
  switch-win-knob:
    size: "12px"
  segmented:
    backgroundColor: "{colors.overlay-hover}"
    rounded: "{rounded.control}"
    padding: "2px"
  segmented-selected:
    backgroundColor: "{colors.surface-control}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
  menu:
    backgroundColor: "{colors.surface-popup-solid}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px"
  menu-item:
    rounded: "{rounded.kbd}"
    padding: "0 8px"
    height: "24px"
  menu-item-highlighted:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  settings-group:
    backgroundColor: "{colors.surface-group}"
    rounded: "{rounded.control}"
  settings-row:
    typography: "{typography.body}"
    padding: "12px"
  banner:
    backgroundColor: "{colors.surface-group}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "12px"
  picker-readout:
    backgroundColor: "{colors.picker-hud}"
    textColor: "{colors.picker-hud-text}"
    typography: "{typography.numeric}"
    rounded: "{rounded.kbd}"
    padding: "2px 6px"
    height: "20px"
  picker-hint-bar:
    backgroundColor: "{colors.picker-hud}"
    textColor: "{colors.picker-hud-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
    height: "28px"
  picker-loupe:
    rounded: "{rounded.popup}"
    size: "120px"
  picker-handle:
    backgroundColor: "{colors.picker-stroke}"
    rounded: "{rounded.box}"
    size: "8px"
  region-tag:
    backgroundColor: "{colors.picker-hud}"
    textColor: "{colors.picker-hud-text}"
    typography: "{typography.label}"
    rounded: "{rounded.kbd}"
    padding: "2px 6px"
    height: "20px"
  detection-box:
    rounded: "{rounded.box}"
  detection-box-linked:
    backgroundColor: "{colors.box-linked-fill}"
    rounded: "{rounded.box}"
---

<!--
  PROVISIONAL TOKEN SPEC (GLIM-27), written before any UI code exists, at the ticket's request.
  Impeccable would normally write a seed DESIGN.md before implementation and let the documenter
  carbonize real tokens after the first build. Treat every value here as the starting contract and
  re-run `/impeccable document` once the first surfaces ship, so the file describes what was built.
  Extensions the frontmatter schema cannot hold (shadows, motion, focus, materials, per-script
  typography, tonal ramps) live in `.impeccable/design.json`.
  GLIM-93 folded in the decisions from the region-picker, Snip popup and Live popup specs
  (docs/design/specs/); where this file and a spec disagree, fix whichever is wrong in the same PR.
-->

# Design System: Glimpse

## Overview

**Creative North Star: "The Margin Note"**

Glimpse writes the meaning of foreign text in the margin beside it, the way a reader pencils a gloss next to a hard line. The note is small, plain and close to its source. It never covers the original, it never decorates itself, and it disappears when the page is turned. Every surface (the region picker, the Snip popup, the Live docked popup, settings, onboarding, the tray item) is the same quiet hand: system type, the OS's own materials and accent, neutral tints, and colour used only to say something.

Density is that of a native utility, not a product page. Popups are compact and content-first: the translation is the largest thing on the surface, controls are small and secondary, and there is no header art, no logo and no empty decoration. Settings and onboarding follow the host OS's settings conventions (grouped rows, standard controls, sidebar or stepped layout) so a Windows user and a Mac user each recognise them at once. The world contributes type, palette and one signature move only; it never supplies controls or layout.

The signature move is the **linked gloss**: hovering or focusing a block in the popup lights its detected box on screen, and in Live mode a block that just changed carries a brief tint that settles into a faint resting mark. Source and meaning are always visibly connected, and change is shown, not churned.

**Key Characteristics:**
- System UI fonts on each OS, with per-script Noto fallbacks; no web fonts, no display face.
- Neutral, untinted greys that read as OS chrome; the OS accent drives interactive colour.
- Native window materials (macOS vibrancy, Windows Acrylic/Mica) under a tint that guarantees legibility over any screen content.
- Colour carries state only: accent for action, focus and linkage; violet for cloud egress; standard status hues.
- Motion is fast, short and explanatory; Live mode never animates anything that did not change.
- Logical (direction-agnostic) layout everywhere; RTL and mixed-direction text are first-class.

### Motion grammar

Motion explains three things and nothing else: a surface arriving at its anchor, content filling in, and a Live block changing. Values live in `.impeccable/design.json` → `extensions.motion`; summary:

- **Durations:** `instant` 0 ms, `fast` 100 ms (hover, press, small state), `base` 160 ms (popup enter, crossfades), `slow` 240 ms (settings panes, onboarding step change), `exit` 80 ms, `settle` 1600 ms (changed-block tint decay). Exits are always faster than entrances.
- **Easing:** `ease-out` `cubic-bezier(0.16, 1, 0.3, 1)` for arrivals; `ease-standard` `cubic-bezier(0.2, 0, 0, 1)` for state changes; `ease-exit` `cubic-bezier(0.4, 0, 1, 1)` for departures; `linear` only for the settle decay and progress fill. No bounce, no elastic, no overshoot.
- **Spring** (for a spring-based motion library, used only for size and position changes of the Live popup and of Live blocks): stiffness 520, damping 44, mass 1 (damping ratio about 0.96, no visible overshoot, settles in about 220 ms). CSS fallback: `base` duration with `ease-out`.
- **Popup enter:** opacity 0 → 1 and scale 0.98 → 1, transform-origin on the edge facing the selection, `base` + `ease-out`. Exit: opacity only, `exit` + `ease-exit`. The window is pre-created; the animation must never delay first paint of content.
- **Expanding the skipped line** in Snip is instant (the chevron rotates in `fast`); the spring is reserved for Live. In Live, a removed block's height collapses with the spring while its content fades in `exit`. The Live window grows to its new height at once and animates content inside it; it shrinks only after the content animation ends.
- **Progressive fill:** detected source text appears with no animation. Each translation replaces its pending source line with a `fast` opacity crossfade; streamed tokens append with no per-token animation. No shimmer, no spinner inside content.
- **Live change:** the changed block's background jumps to `change-flash` at once (no fade-in: the change must be visible on the frame it happens), then decays linearly to `change-rest` over `settle`. A changed block's height change uses the spring; no other block moves except to make room.
- **Reduced motion** (OS setting, or Glimpse's own motion preference set to Reduced): no scale, translate or spring anywhere; size changes are instant. Opacity crossfades shorten to `fast` or below. The Live change shows `change-rest` plus the change mark immediately with no decay. Nothing that carries meaning is removed: the tint, the mark and the text update all still happen.

### Token mapping

Tokens map one-to-one to CSS custom properties and to Tailwind v4 `@theme` names. Do not invent parallel names.

- **Colours:** each pair becomes one property: `--color-<key>: light-dark(<key>, <key>-dark)`, with `color-scheme: light dark` on `:root` so it follows the OS. Tailwind v4 reads `--color-*` from `@theme`, giving `bg-surface-popup`, `text-text-secondary`, `border-border-hairline`, and so on. The `-dark` keys are never emitted as their own utilities. Where `light-dark()` is unavailable, emit the light set on `:root` and the dark set under `@media (prefers-color-scheme: dark)`. Two build-pipeline caveats (GLIM-42): the translucent accent-derived tokens (`change-*`, `overlay-selected`, `box-linked-fill`) are aliased in `@theme` to `--mix-<key>` properties set in plain `:root` rules (one per property, light then a `prefers-color-scheme: dark` override), because the Tailwind/Bun color-mix lowering otherwise flattens them to the opaque accent; and Bun's CSS bundler lowers `light-dark()` to variables keyed on `prefers-color-scheme`, so appearance follows the OS (the webview's), not a per-element `color-scheme`.
- **OS accent:** the shell injects the system accent as `--os-accent` (and `--os-accent-dark` from Windows' AccentLight/AccentDark ramp or macOS `controlAccentColor`). `--color-accent`, `--color-focus-ring`, `--color-change-*`, `--color-overlay-selected` and `--color-box-linked-fill` are then derived with `color-mix(in oklab, var(--os-accent) N%, transparent)` at the alpha each token's hex encodes. The hex values in the frontmatter are the fallback when no accent is injected. `--color-on-accent` is chosen at runtime (white or `#1D1D1F`, whichever contrasts more with the injected accent).
- **Typography:** `--font-ui` holds the shared stack; each role becomes `--text-<role>` (size) with `--text-<role>--line-height` and `--text-<role>--font-weight`, which Tailwind v4 reads as `text-translation`, `text-label`, etc. Per-script stacks and line heights are `--font-<script>` and `--leading-<script>` (see Typography).
- **Spacing:** Tailwind v4's `--spacing: 4px` (emit as `0.25rem`) generates every step in the frontmatter (`p-3` = 12px). Keep the frontmatter keys as the allowed set; do not use off-scale values such as `p-[7px]`.
- **Radii:** `--radius-<key>`; the platform variants are applied by the shell setting `data-os="windows" | "macos"` on `:root`, which remaps `--radius-control` and `--radius-popup`. Windows 10 also gets `data-os-version="10"`, which sets `--radius-popup` to `popup-win10` (0): DWM does not round Windows 10 windows, so the veil must be square too.
- **Material:** the shell sets `data-material="native"` on `:root` when the window has a working native material, and `data-material="none"` when it doesn't (Windows 10, "Transparency effects" off, "Reduce transparency" on, or the helper is unavailable). Popup and window shells paint their translucent veil only under `native`, and the `-solid` surface otherwise. `prefers-reduced-transparency: reduce` is honoured as `none` where the webview exposes it.
- **Sizes in rem:** emit every px value as rem (px ÷ 16) so OS text scaling, which the shell passes through as webview zoom, scales the whole UI evenly.

## Colors

A neutral, untinted grey system that disappears into OS chrome, with the OS accent for action and exactly one product-specific hue (violet) reserved for data leaving the device.

### Primary
- **System Accent** (`accent`, fallback #0A63C9 / #2A6FD9 dark): the OS accent colour, injected at runtime. Primary buttons, selected states, the focus ring, progress fill, the linked-box fill and the Live change tint. It is never used for decoration, headings or icons at rest.
- **Link Blue** (`link`): inline links in settings and onboarding copy. Fixed rather than accent-derived, because an arbitrary accent (yellow, graphite) cannot guarantee text contrast.

### Secondary
- **Egress Violet** (`egress`, `egress-tint`): used only to mark that a cloud provider handled this request: the cloud-in-use indicator on a result, the tray badge, and provider rows in settings that send data off the device. Violet was picked because neither OS uses it for a status meaning, so it cannot be read as "error" or "warning" and does not collide with the default accents. It always comes with a cloud icon and the provider's name; colour is never the only signal.

### Neutral
- **Popup Veil** (`surface-popup`, 90% opaque): the tint painted over the native material in Snip and Live popups. **Popup Veil Solid** (`surface-popup-solid`) replaces it when the OS "Reduce transparency" / "Transparency effects off" setting is on, or when the material is unavailable.
- **Window Veil** (`surface-window`, 72% opaque): background of settings and onboarding windows over Mica / window-background vibrancy. Only primary text and headings may sit directly on it.
- **Group Ground** (`surface-group`): grouped-row containers in settings and onboarding, where body and secondary text live.
- **Control Ground** (`surface-control`): buttons, fields, `kbd` chips.
- **Ink** (`text-primary`), **Pencil** (`text-secondary`), **Faded** (`text-disabled`): the three text levels. Secondary carries source text, metadata, the skipped line and the local indicator. Disabled is exempt from contrast rules and is only used for disabled controls.
- **Hairline** (`border-hairline`), **Control Edge** (`border-control`), **Rule** (`divider`): window inner stroke, control boundaries (3:1 against their surroundings), and in-surface separators.
- **Hover / Pressed / Selected** (`overlay-*`): translucent state layers stacked on any surface.

### Status
- **Success** (`success`), **Warning** (`warning`), **Danger** (`danger`): permission granted / model ready; unsigned-build and hotkey-conflict notices; errors. All pass 4.5:1 as text on the worst-case popup composite. Each status message also carries an icon and words.

### Live change
- **Change Flash** (`change-flash`) → **Change Rest** (`change-rest`): the changed-block tint and its resting state. **Change Mark** (`change-mark`): the 6px dot at a changed block's inline-start edge. Derived from the accent at runtime.

### Picker overlay
- **Scrim** (`picker-scrim`, black at 45%): dims everything outside the selection, in both themes.
- **Stroke** (`picker-stroke`) over **Halo** (`picker-halo`): every line the picker draws (selection edge, crosshair, detection boxes) is a 1px white line with a 1px dark halo, so it reads on any content.
- **HUD** (`picker-hud`, `picker-hud-text`, `picker-hud-text-secondary`): the size readout, the hint bar with its Snip/Live switch and key chips, and the Live region tag. Always dark, regardless of OS appearance. The loupe has no caption.
- **Linked Box** (`box-linked-fill`): fill of the detected box linked to the focused or hovered popup block.

### Named Rules
**The Ninety Rule.** Any translucent surface that carries secondary text or body copy is at least 90% opaque. That is the floor at which every text token still passes 4.5:1 when the content behind the window is pure white or pure black. Lower opacity is allowed only for surfaces that carry primary text and headings alone (`surface-window`, 72%).

**The Borrowed Accent Rule.** Glimpse has no brand colour in its UI. Interactive colour is the user's OS accent; the app-icon orange stays in the icon, the installer and the README.

**The Violet Means Leaving Rule.** Egress violet appears if and only if data left, or will leave, the device. Never use it for decoration, promotion or "premium" cues.

## Typography

**UI Font:** the platform system face: SF Pro on macOS (`-apple-system`), Segoe UI Variable on Windows 11 (Segoe UI on Windows 10), each with a Noto fallback per script.
**Display Font:** none. `title` uses Segoe UI Variable Display on Windows and SF Pro (which switches to its Display cut by size) on macOS.
**Mono:** none by default. API-key fields may use `ui-monospace` because a key is literal data; nothing else does.

**Character:** the OS's own voice. Hierarchy comes from size and weight steps, never from colour, tracking or case.

### Hierarchy
- **Title** (600, 20px, 1.3): onboarding step headings and the settings window's pane title. One per view.
- **Heading** (600, 15px, 1.35): settings group headings and the title line of Snip and Live error and consent states. The Live paused and stale lines are `body`, not `heading`.
- **Translation** (400, 15px, 1.5): translated text in Snip and Live popups. The largest text on any popup, because it is the content. Popups cap measure at about 60ch (the popup's max width enforces it).
- **Source** (400, 13px; 14px on Windows; 1.5): original OCR text, shown under the translation when "Show original" is on, and as the pending placeholder before a translation arrives.
- **Body** (400, 13px; 14px on Windows; 1.45): settings and onboarding copy, control text, descriptions.
- **Label** (500, 12px, 1.35): small control labels, the "N blocks skipped" line, per-block language tags, provider indicators, the popup footer status, the Live status label, tooltip text, `kbd` chips and HUD chips. Sentence case, never uppercase, no extra tracking.
- **Numeric** (500, 12px, 1.35, tabular figures): picker size readout, download progress, byte counts, timers.

### Measure
Prose in Settings and onboarding (step leads, row and switch descriptions, group footers, banner copy, pack and status notes) wraps at **60ch**, about 70–75 characters a line in the system faces, however wide the window is resized. The cap is the `--container-measure` theme value (`max-w-measure` in markup; `.glim-description` and the Banner body carry it), set in `packages/ui/src/styles/theme.css` because the frontmatter has no size scale. Widths are logical, so RTL wraps the same. Titles, headings, labels and single-line status text are not capped.

### Script stacks and sizing
Every rendered block carries the `lang` attribute from language detection (BCP-47, e.g. `ja`, `zh-Hant`, `ar`) and `dir="auto"`; CSS picks the stack and leading with `:lang()`. Stacks put the OS face first and the Noto family last, so text matches the OS where it can and never shows as tofu. The full stacks are in `.impeccable/design.json` → `extensions.scriptTypography`; the rules that matter:

| Scripts | Size vs role | Line height (translation / source / body) | Notes |
|---|---|---|---|
| Latin, Cyrillic, Greek | 1× | 1.5 / 1.5 / 1.45 | Base stack. |
| Han, Kana, Hangul | 1× | 1.7 / 1.7 / 1.65 | Stack chosen by `lang` (JP, SC, TC, HK, KR) so unified Han glyphs use the right regional forms. `line-break: strict`; Korean adds `word-break: keep-all`. No italics; emphasis by weight. |
| Arabic, Persian | 1.0667× (15 → 16px) | 1.75 / 1.75 / 1.7 | Never letter-space (it breaks joining). Never synthesise bold or italic. |
| Urdu (Nastaliq) | 1.0667× | 2.0 / 2.0 / 1.9 | Noto Nastaliq Urdu first; its tall stacking needs the extra leading. |
| Hebrew | 1× | 1.55 / 1.55 / 1.5 | |
| Devanagari, Bengali and other Indic scripts | 1.0667× | 1.75 / 1.75 / 1.7 | Headstroke scripts render small at Latin sizes; the step up keeps conjuncts legible. |
| Thai, Lao, Khmer, Myanmar, Tibetan | 1.0667× | 1.8 / 1.8 / 1.75 (Myanmar, Tibetan 1.9) | Stacked marks above and below need the room. |
| Ethiopic, Tifinagh | 1× | 1.6 / 1.6 / 1.55 | Kefa (macOS) / Ebrima (Windows) first. Georgian and Armenian use the base stack (Segoe UI and the macOS system cascade cover them). |

**Font delivery (GLIM-51).** Glimpse bundles no fonts. macOS 14+ and the default installs of Windows 10/11 ship a face for every script group the translation model covers; the stacks name them, and the Noto families at the end only help users who already have them installed. The one known gap is Urdu Nastaliq on Windows: "Urdu Typesetting" is an optional Windows feature, so without it Urdu renders in Segoe UI's naskh style, which is legible but not Nastaliq. Full reasoning, the per-script font table and the sizes that ruled out bundling: `docs/decisions/GLIM-51-font-fallback.md`. The test page is the gallery's `?page=scripts`.

UI chrome (labels, buttons) uses the user's UI language, set by the same rules. Leading changes per block, never per popup, so a mixed popup does not reflow its Latin lines when a CJK block arrives.

### Named Rules
**The No Costume Rule.** No uppercase labels, no letter-spacing tweaks, no condensed or display faces, no monospace outside literal data. They fail in half the scripts Glimpse renders, and the OS never uses them.

**The Leading Follows Script Rule.** Line height is set per script, not per surface. A token's line height is the Latin value; the script table overrides it.

## Layout

All layout uses logical properties (`margin-inline-start`, `padding-block`, `inset-inline-end`) so every surface mirrors correctly when the UI language is RTL. Text blocks use `dir="auto"` and `unicode-bidi: plaintext` so a mixed Hebrew and English block orders itself; inline labels inside a block (language tags) use `unicode-bidi: isolate` so they never reorder the text around them. Popup chrome follows the UI direction; block text follows its own detected direction.

**Spacing rhythm.** A 4px base with the steps in the frontmatter. Inside popups: 12px outer padding, 8px between blocks, 4px between a translation and its source line, 8px above the footer row. In settings: 24px window padding, 20px between groups, 12px row padding, 8px between a label and its control. More space above a heading than below it (20px / 8px).

**Snip popup placement.** Placed 8px outside the selection and at least 8px inside the work area: below it if there are 200px of room, then above (same test), then the inline-end side, then the inline-start side (each needs 280px), then below or above, whichever is larger, if it has at least 96px. Below and above align the popup's inline-start edge with the region's; sides align their tops. It never overlaps the selected region, with one last resort: when the region fills nearly the whole display, the popup sits inside its block-end, inline-end corner, inset 8px, and can be dragged away. Width follows the region (280px minimum, 480px maximum) and is fixed at show time; height grows with content up to 60% of the screen's work area, then the block list scrolls and the footer stays pinned. The edge facing the region is anchored. Exact rules: `docs/design/specs/snip-popup.md` §3.

**Live popup.** Docked 8px from the pinned region on the side chosen at pin time, and it stays on that side for the session (sides tested in the Snip order, with 160px / 240px / 80px thresholds). Below or above, it is **centred** on the region (subtitles and dialogue boxes are centred) and its width matches the region, clamped to 240–640px; on a side its width is clamped to 240–400px. It can be dragged by its control strip (or moved with Alt/Option+arrows); a moved popup stays put for the session, grows from its top-left, and its offset from the region is remembered per display until Dock puts it back (GLIM-151). A 28px control strip sits at the top (grip, status, local indicator, then the labelled On screen toggle when the frame can draw marks, Private, pause/resume, re-pin, the Update-mode toggle and (in "Only when I refresh") Refresh (GLIM-157), Dock while moved, Pin, stop; no Hide button, which lives in the tray). Pin is on by default (above other windows); off, other apps can cover it. Under it, a 24px cloud row while a cloud provider is in use, then a state row when paused, empty or in error. The strip has three widths: **compact** below 300px (local indicator icon-only, no " · Private" in the label), **regular** 300–359px, **wide** from 360px ("On device" spelled out). Live blocks pad 20px at inline-start so the change mark has room and text never shifts. New or resized blocks change only their own height; the popup's anchored edge never moves. Exact rules: `docs/design/specs/live-popup.md` §2–3.

**Settings.** A fixed-size window (720 × 520 minimum, resizable) with a 200px navigation list at the inline-start side and a scrolling pane. On macOS the list sits on sidebar vibrancy; on Windows it uses the Mica navigation-view convention.

**Onboarding.** One step per view in a 560 × 480 window: title, one paragraph of body copy, the step's control or status, and the primary action at the block-end, inline-end corner (Back at inline-start).

**Picker.** Full-screen per display. The size readout sits 8px outside the selection's bottom-right corner (bottom-left for an RTL UI), flips to the other side when it would leave the screen, and moves inside the selection when neither fits. The loupe is a 120px rounded square (`rounded.popup`, so the pixel grid reads cleanly), showing 15 × 15 device px at 8 × 8 CSS px each with a grid, and no caption; it follows the pointer 24px right and below and flips away from screen edges. The hint bar sits at the top centre of the work area, 16px in, and jumps (no animation) to the bottom when the pointer or selection comes within 48px of it. Live selections stay on one display. Exact rules: `docs/design/specs/region-picker.md` §2 and §4.

## Elevation & Depth

Depth comes from the OS, not from CSS. Popups, settings and onboarding are real windows with the platform's own window shadow and corner rounding (macOS window server; Windows 11 DWM rounded corners and shadow). The webview draws no shadow around its own window.

**Materials.** macOS: `NSVisualEffectView` with the `.popover` material for Snip and Live popups, `.windowBackground` for settings and onboarding, and `.sidebar` for the settings navigation list, all in `.behindWindow` blending. Windows 11: Acrylic (`DWMSBT_TRANSIENTWINDOW`) for popups, which blurs what is behind them, and Mica (`DWMSBT_MAINWINDOW`) for settings and onboarding. Windows 10, transparency turned off, or "Reduce transparency" on: solid surfaces (`surface-popup-solid`, and the solid equivalents of window and group), signalled by `data-material="none"`. Windows 10 windows are also square (`popup-win10`, 0). The webview background is transparent and paints the veil tokens over the material. Never fake a material with CSS `backdrop-filter`; a webview cannot blur what is behind its own window.

**Hairline.** Every popup has a 1px inner stroke in `border-hairline`, drawn by the webview just inside the window edge, so it separates from content of the same brightness. In dark appearance, also add the 0.5px outer dark line (`0 0 0 0.5px #000000A6`) that macOS uses for dark panels.

### Shadow Vocabulary
In-webview elevation only (full values in the sidecar):
- **Menu** (`0 8px 24px #0000002E, 0 0 0 0.5px #0000001F`; dark `0 8px 24px #00000073, 0 0 0 0.5px #FFFFFF1F`): custom dropdowns and context menus inside settings, when a native menu cannot be used.
- **Tooltip** (`0 2px 8px #00000026`; dark `0 2px 8px #00000066`): tooltips on popup icon buttons.
- **Loupe** (`0 4px 16px #00000059, 0 0 0 1px #FFFFFF, 0 0 0 2px #00000099`): the picker loupe, ringed in stroke and halo.
- **HUD** (`0 1px 4px #0000004D`): picker readout chips.

### Named Rules
**The Borrowed Depth Rule.** The window is the only elevated object. Inside a popup everything is flat: no cards, no shadows, no nested surfaces. Groups are separated by space and dividers.

## Shapes

Corners follow each platform. macOS: 12px popups, 6px controls. Windows 11: 8px popups, 4px controls (Fluent). Windows 10: square popups (0), 4px controls. The shell sets `data-os`, which swaps `rounded.popup` / `rounded.control` for their `-win` values; the window's own corner (DWM or the macOS window server) must match the webview's radius. Shared on both: 3px detection boxes, 4px `kbd` chips and HUD readouts, pill for progress bars and the egress indicator. Window radius follows the platform even if the platform changes it; the token is the contract to update.

Borders are 1px everywhere: `border-hairline` for window edges, `border-control` for fields and secondary buttons (3:1 against the surface), `divider` for separators. No borders thicker than 1px except the focus ring (2px). Icons: one outlined family, 16px on a 1.5px stroke (20px in onboarding), with rounded joins. Tray icons are monochrome: template images on macOS, light and dark variants on Windows.

## Components

### Focus
- **Ring:** 2px solid `focus-ring` at a 2px offset, following the control's radius, plus a 2px inner gap in the surface colour (`outline: 2px solid; outline-offset: 2px`). If the injected OS accent is below 3:1 against the surface, the ring falls back to `text-primary`.
- **Picker focus:** 2px `picker-stroke` with a 1px `picker-halo` outside it.
- Visible only for keyboard focus (`:focus-visible`). Every surface, including the picker and every popup control, is reachable and dismissible from the keyboard.

### Snip popup
- **Structure:** the block list (which scrolls, and ends with the skipped line when there is one), then a 24px footer row (`popup-footer`): the provider indicator and Private mark at inline-start, the status text, then the labelled On screen toggle (`button-toggle`, GLIM-158) and the Show original, Copy and Close icon buttons at inline-end. No header, no title, no logo. A 1px `divider` appears above the footer only when the list overflows.
- **Pending state:** as soon as OCR returns, each block shows its source text in `block-source` style. Before OCR returns, static skeleton bars (`skeleton-bar`: `overlay-pressed`, 10px tall, `rounded.box`, centred in a 22px line, width the detected box's share of the region clamped to 30–100%), one per detected box. No shimmer.
- **Missing language packs:** one row per missing language at the top of the list ("Japanese isn't downloaded yet." + Download), never a row per block.
- **Copy feedback:** the footer's status changes to "Copied" with a check icon for 2 s. No toast.
- **Cloud footer wrap:** the egress pill is never truncated; if the footer can't hold it, it moves to its own 24px row above the status row, and if it still doesn't fit it uses the provider's short name.
- **Dismissal:** Esc, Close, or a click outside. The picker's overlays act as the hit-catcher, so the outside click is consumed and does not reach the app below.

### Translation block
- Text in `translation`, source line (when shown) in `source` beneath it, both set per-script.
- **Language tag** (`language-tag`): a trailing inline span, 6px after the text, in the UI language, `unicode-bidi: isolate`. Shown only when the region holds two or more source languages (or Settings says always), and always on blocks in the skipped expansion.
- **Hover / focus:** `overlay-hover` background, and the block's detected box on screen takes `box-linked-fill`. This is the linked gloss. Hovering the box on screen lights the block the same way, and clicking it picks the block (`overlay-selected`) (GLIM-152).
- **Neutral blocks** (numbers, `OK`, keys): shown as-is in `source` style, never highlighted as changed, never counted as skipped.

### Live changed block
- **Every Live block** uses `block-live` padding (20px at inline-start), changed or not, so the mark never shifts text.
- **On change:** background `change-flash` at once, decaying to `change-rest` over the settle duration, plus a 6px `change-mark` dot 8px from the inline-start edge, centred on the first line. The mark and the rest tint stay until the next capture that changes something; then the previous set's marks are removed at once and only the newest set is marked.
- **No greying while settling.** While pixels are still changing nothing dims; the status label says "Updating" only after 1 s of processing a settled change.
- **Never** a coloured side stripe, outline or bold change. Only changed blocks are re-rendered; unchanged blocks keep their DOM nodes.
- **Screen readers:** changed text is announced politely (approach still open in PRODUCT.md); the visual mark is not the only signal.

### "N blocks skipped" line
- One quiet row in `skipped-line` style, always the **last item of the block list** (not the footer, so its expansion scrolls with the list): a 12px chevron pointing inline-end (rotating 90° when open), then "3 blocks skipped · Japanese, Korean" in `text-secondary`. It is a `<button aria-expanded>`: hover shows `overlay-hover`, and activating it expands the skipped blocks inline in `source` style with their language tag, followed by two text buttons, "Translate these" and "Edit source languages…". It never uses a warning colour; skipping is the user's filter working, not an error.

### Provider indicators
- **Local:** `local-indicator`: a chip icon and "On device" in `text-secondary`. Always present when no cloud provider is involved, never louder than that. In a compact Live strip it is icon-only, with the words in its tooltip and `aria-label`.
- **Cloud in use:** `egress-indicator`: a pill in `egress-tint` with a cloud icon and "Sent to <Provider>" in `egress`. Shown on every result a cloud provider handled (in the Snip footer), in the Live popup's cloud row under the strip for the whole session (including while paused), and as a violet-tinted cloud badge on the tray icon. It cannot be dismissed or hidden while the provider is active.

### Live control strip
- 28px tall (`live-strip`): at inline-start an 8px `status-dot` and the status label ("Live", "Updating", "Paused", plus " · Private" when wide enough), then the local indicator; at inline-end `button-icon` Private (pressed state), pause/resume, re-pin, Dock (only while moved), Pin (pressed = on top) and stop, 4px apart; a compact strip wraps its buttons to a second line rather than squeezing the label. A 12px grip at the very start marks the strip as the drag handle. The dot is `accent` while running, a hollow 1.5px `text-secondary` ring when paused or awaiting consent, `danger` on error. The dot never pulses.
- **Stale state** (paused, error, screen locked): hollow or danger dot, every block's text in `text-secondary`, and a `body` state row "Showing text from 3 min ago". Error and consent states add a `heading` title, a `body` paragraph and buttons in the state row.

### Pinned-region frame
- Drawn by a native click-through window, not a webview. While Live runs, it marks the pinned region with 12px corner ticks only (no full rectangle): 2px `accent` over a 1px `picker-halo`, drawn **outside** the region (the ticks' inner edge 1px outside the rect), so they never cover a pixel of it. Paused or error: the ticks turn `picker-stroke` at 60% opacity.
- **Region tag** (`region-tag`): only while the popup is hidden, a HUD chip 4px above the top-left tick: "Live", "Live · Paused", or with a cloud icon "Live · Google" in `egress-dark`, so sending is never invisible.

### Region picker
- Outside the selection: `picker-scrim`. Selection edge, crosshair and snapping guides: `picker-stroke` with `picker-halo`. Window-snap candidates cut a hole in the scrim (so they're obvious over dark content) and show the same stroke at 60% opacity before commit.
- **Hint bar** (`picker-hint-bar`): the Snip/Live switch, the hint and key chips; when the mode will use a cloud provider, it adds the egress pill in its dark-appearance colours.
- **Handles** (`picker-handle`) only while adjusting: 8px squares with a halo ring and 20px hit areas.
- Esc or right-click cancels from any phase.
- `picker-readout` shows "W × H" in tabular figures; a second chip hints the mode ("Snip · Tab for Live") with keys rendered as `kbd` in HUD colours.
- **Detected boxes** (after the drag, while the popup is open): a 1px `picker-stroke` + `picker-halo` outline with `rounded.box`, no fill at rest. Linked box: `box-linked-fill`. Skipped blocks: the same stroke dashed (3px dash, 3px gap) at 60% opacity. Neutral blocks: no box.
- **Numbered badges** (GLIM-152): every box with a popup block carries that block's number in a 20px HUD pill (`picker-hud`, `picker-hud-text`, `numeric`, 1px `picker-stroke` ring) centred on its top inline-start corner; linked or picked turns it `accent` / `on-accent`. The popup shows the same number in a 16px `overlay-pressed` chip in a 24px inline-start gutter. Numbers, not leader lines: the gloss stays in the margin.
- **Overlay mode** (GLIM-152, opt-in, off by default): opaque cards (`surface-popup-solid`, `text-primary`, `border-hairline`, Tooltip shadow, `rounded.control`) paint each translation over its box, text fitted between 15px and 11px, then growing downward. This is the one sanctioned exception to "never covers the original": the user asks for it per Snip or in Settings, and the source is one held Shift (or a hover) away. Exact rules: `docs/design/specs/snip-popup.md` §2.5.

### Buttons, fields and keys
- **Primary** (`button-primary`): one per view at most; onboarding's next step, settings' confirm actions. Hover layers `overlay-hover` over the fill; pressed layers `overlay-pressed`.
- **Secondary** (`button-secondary`) with a 1px `border-control` edge; **icon** buttons (`button-icon`) with a tooltip naming the action and its shortcut. Toggling icon buttons (Show original, Private) use `aria-pressed`; pressed shows `overlay-selected` behind a `text-primary` icon.
- **Labelled toggle** (`button-toggle`, GLIM-158): for a mode that must be found without hovering ("On screen" in both popups). Icon + a short `label`-type word, 24px tall like `button-icon`, a 1px `border-control` edge at rest so it reads as a button; pressed is `button-toggle-pressed` (`overlay-selected`, no edge) with the icon in `accent`. `aria-pressed`, the visible word is its name, the tooltip names the action and key. One per popup at most; everything else stays an icon button.
- **Tooltip** (`tooltip`): `surface-popup-solid`, `label` type, `rounded.kbd`, shadow **Tooltip**, after a 500 ms hover or at once on keyboard focus.
- **Fields** (`field`) with a 1px `border-control` edge; on focus the edge is replaced by the focus ring. Errors: `danger` edge plus an inline message in `danger` below.
- **kbd** chips show OS-native glyphs (⌃⇧S on macOS, Alt+Shift+S on Windows) in `label` type.
- **Control height:** 28px on macOS, 32px on Windows (Fluent standard); icon buttons stay 24px in popups on both.

### Settings and onboarding controls
Each follows its OS's own control, drawn from tokens; `packages/ui` implements them on unstyled Kobalte primitives.
- **Switch:** macOS `switch` (32 × 18 track, 14px `knob` with a soft shadow, `overlay-pressed` off, `accent` on). Windows `switch-win` (40 × 20, off: 1px `border-control` outline and a 12px `text-secondary` knob; on: `accent` fill and an `on-accent` knob; the knob grows 2px on hover). The knob slides `fast` with `ease-standard`; reduced motion jumps.
- **Segmented control** (`segmented`): two to four short options on an `overlay-hover` trough with 2px padding; the selected segment is `surface-control` with `text-primary`. Used for small enums (motion: System / Reduced); anything longer is a select.
- **Select and language picker:** a field-shaped trigger (`field`) with up-down chevrons on macOS and a down chevron on Windows; the list is a `menu` (`surface-popup-solid`, shadow **Menu**, 4px padding) of 24px `menu-item`s (Windows: control height), highlighted with `accent` / `on-accent` on macOS and `overlay-hover` on Windows, the chosen item marked with a check. The language picker is the same list with a search field: it matches the language's name in the UI language, its own name ("日本語") and its code, ignoring accents, and shows the own name in `text-secondary` after the UI name.
- **Hotkey recorder:** a field showing `kbd` chips. Activating it says "Type a shortcut", previews modifiers as they're held, saves on the first valid combo, Esc cancels, Backspace clears. GLIM-23's rules decide what's blocked (inline `danger` message, nothing saved) and what's warned (`warning` message under the field, combo kept). A conflict reported by the app process is a `danger` message.
- **Secret field:** a `field` in `ui-monospace` (a key is literal data) with a show/hide icon button inside its inline-end edge. A saved key is never shown back; the field says it is stored in the Keychain / Credential Manager and offers Replace.
- **Settings groups and rows:** a `heading` above each group (20px above, 8px below). macOS: one `settings-group` container with a 1px `border-hairline` edge and `divider` lines between `settings-row`s. Windows: each row is its own `settings-group` card, 2px apart, as Windows Settings stacks setting cards. A row is the label (`body`) with an optional description (`label`, `text-secondary`) at inline-start and its control at inline-end.
- **Banner:** a `banner` with a 16px status icon in the status colour, a `body` title in weight 600, optional body copy in `text-secondary` and up to two buttons. For unsigned-build guidance, permissions and errors in settings and onboarding; never in popups (they use the state row). No coloured side stripe; the icon and words carry the status.
- **Inline error:** `label` type in `danger` with a 16px alert icon, directly under the field it belongs to, linked with `aria-describedby`.

### Model download progress (onboarding, settings)
- `progress-track` with a `progress-fill` advanced linearly, plus a `numeric` line: "412 MB of 1.2 GB · about 3 min left". Real progress only; an indeterminate state shows the words "Preparing download" and no animated bar.

## Do's and Don'ts

### Do:
- **Do** paint `surface-popup` (90% opaque) over the native material and switch to `surface-popup-solid` when the OS asks for less transparency.
- **Do** take interactive colour from the OS accent, with the frontmatter hex as the fallback only.
- **Do** tag every rendered block with its detected `lang` and `dir="auto"`, and let `:lang()` choose stack and leading.
- **Do** use logical properties for every inline-axis value.
- **Do** keep each popup flat: blocks separated by 8px and, where needed, a `divider`.
- **Do** show the cloud-in-use indicator with icon and provider name on every cloud-handled result and in the tray.
- **Do** honour reduced motion by removing movement while keeping the change tint, mark and text updates.

### Don't:
- **Don't** use gradients, gradient text, glows, coloured shadows or CSS glassmorphism; the only glass is the OS material.
- **Don't** add cards, nested surfaces, eyebrows or kicker labels above headings, section numbers, or hero blocks to any surface.
- **Don't** use uppercase or tracked labels, display faces, or monospace as decoration.
- **Don't** mark changed Live blocks with a coloured side stripe, a border thicker than 1px, a pulsing dot or a shake.
- **Don't** use spinners or shimmer inside content; show the real source text, then the translation.
- **Don't** use the app-icon orange (#EA580C) anywhere in the UI.
- **Don't** use egress violet for anything except data leaving the device, and never rely on colour alone for it.
- **Don't** use emoji or Unicode glyphs as icons, celebration states, confetti or mascots.
- **Don't** animate a whole popup, or any unchanged block, when Live content updates.
- **Don't** let any Glimpse surface cover the selected or pinned region. The only exception is the last-resort inside placement, when the region fills nearly the whole display.

## Open questions for review

Where Impeccable's process would have asked, a choice was made and is listed here.

1. **Process.** Impeccable normally writes a token-free seed before implementation and real tokens after the first build. The ticket asks for tokens now, so this is a provisional token spec, marked as such at the top. The concept-seed direction roll was skipped because PRODUCT.md pins the world (native materials, OS appearance, system type, CleanShot X / Shottr picker feel). Re-run `/impeccable document` after the first surfaces ship.
2. **Creative North Star.** "The Margin Note" was chosen. Alternatives: "The Quiet Interpreter", "Part of the Glass".
3. **Accent.** Follow the OS accent (chosen), or give Glimpse its own fixed accent? The app-icon orange is kept out of the UI because it reads as a brand colour asking for attention and sits close to the generic orange/terracotta AI default. Is the icon itself final?
4. **Popup opacity floor.** 90% (the Ninety Rule) makes text pass on pure white or pure black backgrounds but leaves little of the material visible. Accept it, or allow around 80% with a stronger-contrast text set?
5. **Picker HUD always dark** (CleanShot-style), or follow OS appearance?
6. **Egress colour.** Violet was chosen to avoid status meanings and default accents. Confirm the hue, and confirm that "On device" is always shown for local results (chosen) rather than only showing the cloud state.
7. **Changed-block highlight.** Derived from the OS accent (chosen) rather than a dedicated marker colour. With a graphite or yellow accent the tint is weaker, and the change mark carries the signal. Is the 1.6 s settle right for subtitles that change every 2–3 s?
8. **Platform sizing.** Body and source text are 13px on macOS and 14px on Windows; controls are 28px and 32px. Keep the platform split, or use one size on both?
9. **Translation text size.** 15px by default. Should settings offer a text-size control (suggested: three steps, 13 / 15 / 18px), separate from OS scaling?
10. **Noto delivery.** Decided in GLIM-51: bundle nothing, rely on OS fonts (see Typography > Font delivery). Revisit if the GLIM-87 hardware check finds tofu, or if Nastaliq on Windows without "Urdu Typesetting" is not acceptable (an optional Noto Nastaliq Urdu download is the proposed fix).
11. **macOS 26+ Liquid Glass.** Is `NSGlassEffectView` used where available instead of `NSVisualEffectView`? It changes the material, and probably the popup radius (12px may need to grow to match concentric system corners).
12. **Windows 10.** Mica and Acrylic need Windows 11. Is Windows 10 supported at all? If it is, it gets the solid surfaces and square popups (`popup-win10`, decided in the popup specs).
13. **Icon set.** One outlined family at a 1.5px stroke was specified but not picked (for example Lucide, or authored icons modelled on SF Symbols / Fluent). Native look on each OS argues for authored icons.
14. **`light-dark()` and `color-mix()` support.** Both need a recent WebView2 (Chromium 123+) and WebKit (Safari 17.5+). Confirm the minimum macOS version once the shell spike lands; the media-query fallback is specified either way.
