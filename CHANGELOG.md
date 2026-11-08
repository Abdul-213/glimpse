# Changelog

User-facing changes per release, newest first ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style). The release workflow (`.github/workflows/release.yml`) uses the section whose heading
matches the tag (`## [0.1.0] - 2026-11-20` for `v0.1.0`) as the GitHub Release notes. Without
one it generates a list from the `GLIM-<n>:` commits since the previous tag.

To release: move the Unreleased entries under a new version heading, set that version in
`package.json` and `app/package.json`, merge to `main`, tag `v<version>` and push the tag. The
workflow builds Windows and macOS and leaves a **draft** release for the owner to publish.

## [Unreleased]

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
