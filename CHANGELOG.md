# Changelog

User-facing changes per release, newest first ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style). The release workflow (`.github/workflows/release.yml`) uses the section whose heading
matches the tag (`## [0.1.0] - 2026-11-20` for `v0.1.0`) as the GitHub Release notes. Without
one it generates a list from the `GLIM-<n>:` commits since the previous tag.

To release: move the Unreleased entries under a new version heading, set that version in
`package.json` and `app/package.json`, merge to `main`, tag `v<version>` and push the tag. The
workflow builds Windows and macOS and leaves a **draft** release for the owner to publish.

## [Unreleased]

### Changed

- Glimpse's popups, Settings and setup window now show up when you stream or record (Discord, OBS,
  screenshots). New switch **Show Glimpse in screen sharing and recordings** in Settings › Privacy,
  on by default, with the same switch in the tray menu (**Show in screen sharing**); it applies to
  open windows at once. It replaces "Hide Glimpse from screenshots and screen sharing", so existing
  installs start showing Glimpse too. Glimpse still never reads its own windows. The selection
  overlay and the Live frame with its numbers and on-screen cards always stay out of captures
  (GLIM-164).

## [0.0.5] - 2026-11-09

Fifth MVP preview, after the owner's test of 0.0.4. Unsigned. What to try:
[docs/mvp-test.md](docs/mvp-test.md) steps 17–25a.

### Fixed

- Live: the On screen button is always in the top bar. When the overlay can't be drawn on this
  system it is greyed out and its tooltip says why, instead of the button being missing (GLIM-163).
- Live: a failed "hidden from capture" check is retried when the frame is shown or moved, and the
  Windows frame re-applies the capture exclusion each time it is shown (GLIM-163).
- Live: the reason the overlay is unavailable is logged once per session, so Copy diagnostics shows it (GLIM-163).

## [0.0.4] - 2026-11-09

Fourth MVP preview, after the owner's test of 0.0.3. Unsigned. What to try:
[docs/mvp-test.md](docs/mvp-test.md).

### Added

- **On screen button.** A labelled "On screen" button in the Snip popup and the Live top bar
  turns the on-screen translations on and off (shortcut in its tooltip), a one-time tip on the
  first Snip, and a tray checkbox. (GLIM-158)
- **Live update mode.** Settings › General › Live › Update: "When the text changes" (default)
  or "Only when I refresh", with a Refresh button, Ctrl/⌘R in the popup and a tray item.
  (GLIM-157)
- A `snip capture` line in the log for every Snip, so a failed capture can be diagnosed from
  Copy diagnostics. (GLIM-156)

### Fixed

- **Snip failing after the first one** ("Glimpse couldn't capture this area"): on Windows the
  screen overlays are now replaced after each Snip instead of being re-shown. (GLIM-156)
- The On screen toggle and Ctrl/⌘⇧T did nothing in the Snip popup. (GLIM-158)
- Live no longer flashes or re-translates when the text hasn't changed (OCR reading the same
  line slightly differently after a hover counted as a change). (GLIM-157)

## [0.0.3] - 2026-11-09

Third MVP preview. Unsigned. What to try: [docs/mvp-test.md](docs/mvp-test.md) steps 17–25.

### Added

- **Numbered markers for Live.** With two or more blocks in a pinned region, each gets a number
  on screen and the same number in the Live popup; a block keeps its number while it stays.
  Clicking a badge scrolls the popup to its translation without taking focus from your app.
  (GLIM-154)
- **Show translations on screen for Live.** The same toggle (Ctrl+Shift+T / ⌘⇧T) and setting
  as Snip paint each translation over its block on the pinned region, updated in place as the
  text changes. The cards are hidden from Glimpse's own capture, so Live never reads them back;
  where Windows can't hide them (Windows 10 before 2004) the option is not offered. (GLIM-154)

## [0.0.2] - 2026-11-08

Second MVP preview, after the owner's first test of 0.0.1. Unsigned. What to try:
[docs/mvp-test.md](docs/mvp-test.md).

### Added

- **Move the Live popup.** Drag it by the grip in its top bar; it stays where you put it for
  the session and opens there next time on that display. Dock (magnet button, or double-click
  the bar) puts it back next to the region. Alt+arrows (Option+arrows on macOS) move it from
  the keyboard, with Shift for bigger steps. (GLIM-151)
- **Pin / unpin the Live popup.** The pin in its top bar keeps it above other windows (the
  default) or lets other apps cover it. (GLIM-151)
- **Numbered markers for Snip.** Each translated block gets a number on its box on screen and
  the same number in the popup; clicking a box jumps to its translation. (GLIM-152)
- **Show translations on screen (Snip).** A toggle in the popup (Ctrl+Shift+T / ⌘⇧T), or
  Settings › General, paints each translation over its bubble or box. Hold Shift or hover a
  card to see the original; Esc goes back to the list. (GLIM-152)

### Changed

- Speech bubbles in comics and manga are read as one block each, in the page's reading order
  (right to left for manga). (GLIM-152)

### Fixed

- Desktop builds now check a full translation end to end before they are published. (GLIM-146)
