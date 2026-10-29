# Low-fidelity flows (GLIM-25)

Greyscale wireframes for every Glimpse surface. Open `index.html` in a browser. Each page is self-contained (inline CSS/JS, no network) and laid out at a fixed 1720 px width, with every state labelled (S1, L4, O3b…) so review comments can point at a state.

| Page | Covers |
|---|---|
| `snip.html` | Hotkey → picker (crosshair, loupe, size readout, dim, window snap) → detected boxes → streaming → copied → dismiss. Popup details: neutral blocks, "N blocks skipped" collapsed/expanded, Arabic RTL source (translation and original view), target-language block, cloud chip. Errors: no text, model missing, provider error, screen access lost. |
| `live.html` | Live picker → pinned docked popup → text settling → changed-block highlight and fade → pause / resume / unpin → focus states → empty region. Cloud variant: one-time consent, cloud chip, region tag. |
| `onboarding.html` | Welcome, screen access (macOS Screen Recording + unsigned note; Windows SmartScreen note), target language, per-language downloads (progress, pause, interrupted), shortcuts with live status, done, resume prompt. |
| `settings.html` | General (target language, launch at login), source-language subset multi-select, shortcuts with recorder/conflict/validation states, providers and masked API keys with Test key, downloads, Live fps and threshold, appearance and motion. |
| `tray.html` | Windows notification-area menu and macOS menu-bar menu: idle, Live running, cloud in use, needs attention; icon badge states. |

`screenshots/` holds full-page PNGs rendered with headless Chromium (Playwright), reduced to a 32-level grey palette. The render had no console errors and made no network requests. The render machine has no CJK font, so the wireframes avoid CJK sample text. The real UI must ship Noto fallbacks (PRODUCT.md).

Not the visual design. No materials, brand colour, type scale or motion here; DESIGN.md owns those. Copy is real but provisional.

## Assumptions

1. **Language packs.** The translation model is one required download, plus one downloadable pack per language (the ticket asked for this assumption). Sizes are `###` placeholders because no figures exist yet.
2. **Onboarding order:** screen access → target language → downloads → shortcuts. Target comes before downloads so the right packs are pre-ticked. The download keeps running in the background through the later steps.
3. **Pre-ticked packs** come from the target language and the OS keyboard layouts.
4. **Clipboard** content after a Snip is translated plus neutral blocks in reading order, one per line, with skipped blocks left out. "Copy after Snip" can be turned off in Settings.
5. **Detected-box state:** after release, the overlay keeps a thin region outline and per-block outlines (solid = translate, dotted = neutral, dashed = skipped) until the popup closes. These are Glimpse windows, so they are excluded from capture.
6. **Popup placement:** right of the region, then left, below, above, then inside the region's bottom edge. The Live popup docks to the free side and matches the region's width.
7. **"Translate these"** in the skipped expander translates the skipped blocks once and doesn't change settings.
8. **Neutral blocks** are listed inline in the popup with a muted "as-is" tag. Target-language blocks are shown as-is with an "already English" tag and aren't counted as skipped (GLIM-21 Q4 recommendation).
9. **Live with a cloud provider** asks for consent once, separately from Snip, because it sends text every time the region changes. A region tag stays visible even when the popup is hidden.
10. **Cloud sends text only, not images** (stated in the switch-to-cloud confirm). This holds for translation providers. A cloud OCR provider would send images, and its copy has to say so.
11. **Live highlight** fades its background after about 2 s and keeps a thin bar on the latest change. With reduced motion there's no fade.
12. **Live settings:** fps range is 1–4 (the brief says ~2–4; 1 is for battery). "On battery" option and a user-visible settle delay. The threshold is shown in plain words rather than a percentage.
13. **Tray:** left-click on Windows also opens the menu. Problems are listed first in the menu. The macOS app has no Dock icon. The "Translate into" submenu lists recent targets.
14. **Launch at login** is offered on the last onboarding step, on by default.
15. **Errors leave the clipboard alone** and show the OCR'd original when there is one.
16. **macOS Screen Recording** may need a Glimpse restart after granting. The setup window resumes at the next step.
17. **Settings** apply immediately, with no Save button. API keys can be revealed with Show for 10 s.
18. **Provider names** are placeholders (`‹Provider A›`). The first providers haven't been chosen.

## Open questions

1. **Gatekeeper guidance** for unsigned macOS builds (open decision in PRODUCT.md). O1a and E4 only link to a placeholder.
2. **Windows screen-access step:** keep it for SmartScreen copy and a matching step strip (as drawn), or skip it automatically?
3. **Does the download selection seed the source-language subset?** Or should onboarding ask for the subset as well?
4. **Where does the "N blocks skipped" line go:** at the end (as drawn), or inline where the skipped blocks were?
5. **Should a region with only neutral blocks** count as "No text found"?
6. **Per-block language tags:** always on (as drawn, with a Settings toggle) or hover only? Should hover show confidence?
7. **Low-confidence OCR** (Snip D7): flag unclear blocks per block, or not at all?
8. **Live popup focus:** can Pause/Unpin take a click without pulling focus from a fullscreen game? This depends on the shell spike.
9. **Live popup growth:** what's the maximum height before it scrolls, and how should long chat panes be handled?
10. **Several tray states at once** (cloud + Live + warning): one badge by priority (as drawn) or two?
11. **Should the cloud-in-use footer** show a request count (as drawn in Live C2), or is that noise?
12. **macOS Accessibility permission:** if the NSEvent hotkey backend is kept (GLIM-23 Q2), onboarding needs an Accessibility step. It isn't drawn.
13. **Mixed-DPI size readout:** logical or physical pixels?
14. **Screen-reader announcements** for Live changes (PRODUCT.md, open). Nothing is drawn for this.
15. **Translation cache** (open decision): if there is one, should Settings have a "Clear cache" control?
