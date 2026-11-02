# Accessibility audit (GLIM-83)

This is the audit of every Glimpse surface against PRODUCT.md "Accessibility & Inclusion" and
DESIGN.md (Focus, Reduced motion, Materials). It records three things: what the automated
check covers, what was fixed, and what still needs a person on a real Windows PC and Mac.
Audit date: 2026-11-02, against `develop` after the Live popup stack (GLIM-79/81/82/92/67/128)
merged.

## Automated check

`bun app/scripts/a11y-check.ts [--surface <name>] [--report f.md] [--json f] [--strict]` builds
every dev preview (`app/scripts/preview-surfaces.ts`, shared with the GLIM-52 design detector).
That is 87 pages: the component gallery, Settings (every pane), onboarding and screen access,
the Snip popup (main path and error states), the Live popup (running, changed, paused, consent,
skipped, OCR stopped), and the region picker (hover, drag, keyboard, too small, Live, results).
It covers macOS and Windows styling, light and dark, and RTL UI. Each page loads in headless
Chromium with reduced motion on, and three checks run:

1. **axe-core 4.14** with the WCAG 2.0/2.1 A and AA rules: contrast, names and roles, ARIA, lists,
   labels, and label-in-name. Landmark and page-title rules are off, because these are small
   app windows, not documents.
2. **Keyboard.** The page records where focus starts, then presses Tab until the cycle closes.
   It flags three things:
   - a stop with no visible focus indicator (an outline or ring on the control or its field
     wrapper)
   - a visible, enabled control that Tab never reaches (composite children such as options,
     radios and roving blocks are skipped, because arrow keys reach them)
   - a control that only has focus at open and that Tab never returns to
3. **Reduced motion.** It lists animations still moving content: transform, translate or
   scale keyframes over 150 ms.

CI runs it with `--strict` after the design detector, so a regression fails the job. The
report goes to the job summary and the `a11y` artifact.

**Result: 0 axe violations, 0 focus problems, 0 unreachable controls and 0 movement under
reduced motion, across all 87 pages.** axe could not decide contrast for 66 elements. All of
them are text over translucent or layered backgrounds: the popup veil over the native
material, the picker scrim, and gallery specimens. Those are covered by the manual checks
below.

## Per surface

| Surface | Keyboard | Focus | Names / roles / announcements | Contrast | Reduced motion / transparency | RTL |
|---|---|---|---|---|---|---|
| Region picker | Full keyboard selection (region-picker.md §6): arrows create and move a box, Shift moves 10 px, Alt/⌥ resizes, Enter confirms, Esc cancels from any phase. | The selection's 2 px picker stroke with halo is the focus indicator. The overlay root (`role="application"`, labelled per mode) holds keyboard focus. | `role="status"` polite region announces the size and the hint. | Stroke and halo are built for any background. axe can't decide the scrim (30 elements), so it is a manual check. | Honours the OS setting (`prefers-reduced-motion`, plus the app's own motion setting). `forced-colors` styles exist. | Readout and hint bar mirror. Checked in the gallery's RTL variants. |
| Snip popup | Focus moves to the block list, or to the first error action. Tab cycles inside the popup (dialog, `aria-modal`). ↑ ↓ Home End move between blocks, Esc closes, copy shortcuts per snip-popup.md §11. | DESIGN.md ring on every control. The block list itself is parked focus with no ring, by design. | Dialog labelled. Blocks are list items with language tags. Errors are a heading plus a body. | Pass where axe can decide. 0 undecided elements. | Entering animation off under reduced motion. The veil switches to solid under reduced transparency (`data-material`, `prefers-reduced-transparency`). | RTL UI and RTL source text are covered by variants. |
| Live popup | Tab order is strip buttons → state-row buttons → blocks (live-popup.md §6.2), wrapping. Blocks use roving ↑ ↓. Pause, Private, Hide and Stop are buttons. | DESIGN.md ring. | Region labelled. GLIM-92: a polite `role="log"` announces changed blocks and a `role="status"` region announces state. | Pass. axe can't decide 9 elements (veil). | The change tint and mark appear at once, with no decay (DESIGN.md Reduced motion). | Checked (`l4-changed-rtl-ui`). |
| Settings | Every pane and control is reachable with Tab. Selects, switches and segmented controls work with keys. The hotkey recorder records from the keyboard. | Ring on controls. Fields show it on the wrapper (`:focus-within`). | Labels on every field. The hotkey recorder's name now matches its visible key caps (fixed, see below). Status lines use `role="status"`. | Pass. 7 undecided elements over the window material. | Motion follows the OS or the app's Motion setting. Materials fall back to solid. | `languages-macos-light-rtl`. |
| Onboarding / screen access | Every step can be done from the keyboard. Back and Next are buttons. Status uses `role="status"`, and screen access uses `aria-live`. | Ring. | Labelled. | Pass. 2 undecided elements. | Same as Settings. | `setup-language-macos-light-rtl`, `access-lost-macos-light-rtl`. |
| Tray / menu bar | A native menu: keyboard and screen-reader access come from the OS (macOS menu-bar navigation, Windows Win+B and arrows). Labels follow each OS's case. Shortcuts show as OS glyphs or text. | OS. | **The icon itself has no accessible name** (GLIM-136). | OS. | — | OS. |

## Fixed in this pass

- **Snip popup Tab trap** (`app/src/views/popup/SnipPopup.tsx` `trapTab`). Two cases broke the
  cycle:
  - In error states without blocks (E1 "No text found"), Tab from the last button tried to
    wrap to the hidden block list, so focus stuck on "Close".
  - In error states with blocks (E3 offline), the wrap target was the first block, so Tab
    never came back to "Retry" or "Snip again" once it had left them.

  The cycle is now all visible stops in DOM order, and Shift+Tab from the parked list still
  wraps to the end. The check confirms both cases against the old code.
- **Hotkey recorder label-in-name (WCAG 2.5.3)**, Windows only. The key caps read
  "AltShiftS", while the accessible name is "Snip: Alt Shift S". `Kbd` now puts spaces between
  the chips. Flex layout ignores them, so nothing visible changes.
- **Gallery list markup.** The expanded skipped line's specimen put a `div` directly in a
  `ul`. It is now an `li`, as in the Snip popup.
- From GLIM-52 (stacked under this PR): a disabled primary button showed disabled text on the
  accent fill and now uses the neutral control fill. The gallery used `text-disabled` for
  normal text, which was 2.9:1.

## Needs real hardware (manual verification for this ticket)

Each item below needs a person on Windows 11 (and 10), and on macOS 14+.

1. **Screen readers.** Use VoiceOver (macOS) and Narrator, plus NVDA if available (Windows).
   - Snip popup: it is announced as a dialog with its title, blocks are read with their
     language, and an error is read with its action.
   - Live popup: changed blocks are announced politely and are not repeated (GLIM-92).
   - Picker: its status announcements.
   - Settings and onboarding: field labels.
   - Tray: the icon name (GLIM-136).
2. **Keyboard focus in the real windows.**
   - Each popup takes focus when it opens: the Snip popup from the hotkey, the Live popup when
     it is focused from the tray or its hotkey.
   - Esc and Tab work over full-screen apps and games.
   - Focus goes back to the previous app when Glimpse closes.
3. **Contrast over real content.**
   - Popups over white, black and busy content (a game, a video) with the native material on.
   - The same with "Reduce transparency" / "Transparency effects" off.
   - These are the 66 elements axe couldn't decide.
4. **High contrast.** Windows contrast themes (`forced-colors`): popups, picker and Settings
   remain usable and focus is visible. Also macOS "Increase contrast".
5. **Reduced motion.** With the OS setting on, the Live change tint shows at once and nothing
   slides or scales: popup open, picker, switches.
6. **Text size.** Settings and popups at the OS's larger text settings (Windows "Text size" 150 %,
   macOS display scaling), and CJK, Arabic and Devanagari blocks at the smallest popup size.
   Nothing may clip.

## Tickets

- **GLIM-136:** the tray / menu-bar icon has no accessible name (native helper).
- **GLIM-135:** paragraph measure in Settings and onboarding (design detector line-length;
  readability).
