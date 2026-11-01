# Product

<!-- impeccable:product-schema 1 -->

<!--
  Written for GLIM-24 from the design brief and the ticket's UX notes, without a live
  `/impeccable init` interview. Inferred items were dropped on review (2026-10-30);
  anything marked "(open)" is still undecided.
-->

## Platform

web

<!-- Glimpse is a desktop app for Windows and macOS. Every UI surface is HTML/CSS in the
     shell's webview (Electrobun candidate, Tauri fallback), so Impeccable treats it as `web`.
     The surfaces still have to look and behave like native desktop utilities; see
     Brand Commitments. -->

## Stack

Provisionally decided in `docs/decisions/GLIM-26-stack.md`.

- **Shell:** Electrobun (Bun + system webview) with small per-OS native helper libraries loaded through `bun:ffi`. Tauri stays the fallback if real-machine checks fail.
- **UI:** Solid + TypeScript, unstyled primitives, Tailwind driven by DESIGN.md tokens, Motion One.
- **Engines:** pluggable OCR and translation providers. Default OCR is PaddleOCR via ONNX, bundled, the same engine on both OSes. Default translation is Mozilla's Firefox Translations (Bergamot, MPL-2.0) language packs, downloaded on demand, pivoting through English (`docs/decisions/GLIM-85-translation-model.md`).

## Users

Glimpse is for people who run into text they can't read on their own screen, in places where copying it out is impossible or tedious: rendered images, game UIs, video frames, canvas apps, scanned PDFs, screenshots in chats.

- **Players and media viewers:** people playing untranslated or fan-translated games, or watching videos and streams with burned-in foreign text. They need to understand dialogue, menus and subtitles without leaving fullscreen or losing their place. Text changes all the time, so Live mode matters most to them.
- **People using foreign-language software, documents and chats:** an app or OS dialog in another language, a scanned contract, a message thread with a relative or colleague, a supplier's PDF. They want a quick one-off meaning, and often want to paste it somewhere (Snip mode, clipboard).
- **Language learners:** people who want to check their own reading against a translation, see which language each block is in, and translate only the language they're studying while leaving their native-language text alone (source-language subset).
- **Privacy-conscious users:** people translating sensitive material such as private chats, work documents, medical or legal letters, who won't send screen contents to a third-party service. For them, offline by default and a clear, honest indicator whenever a cloud provider is in use are the reasons to choose Glimpse.

## Product Purpose

Glimpse lets you select any area of your screen and read what it says in your own language. It OCRs the region, detects the language of each text block, and translates it to a target language. Optionally it translates only blocks in a chosen subset of source languages.

It exists because translating on-screen text usually means screenshotting, uploading to a website, waiting, and losing context. Glimpse puts the translation next to the text, in under a second, without the content leaving the machine.

**Success looks like:** the user presses a hotkey, drags a box, reads the translation, and is back in their game, video or document without thinking about Glimpse. In Live mode they forget it's running until the text they're watching changes.

**Goals**
- Fast, accurate, in-place translation of any on-screen text in both modes.
- Fully usable offline after the first-run model download, with no account.
- Equally solid on Windows and macOS.
- Handle every major script, both writing directions, and mixed-language regions.

**Non-goals**
- No Glimpse accounts, sync, or hosted backend. Cloud use only goes through providers the user brings their own keys for.
- No Linux in the first release (deferred, not rejected).

## Positioning

A screen-area translator that runs fully on-device by default. Bundled OCR plus a local translation model mean it works offline, free and privately. It has a Live mode that watches a pinned region and re-translates only when the content settles. It is open source and keeps any cloud keys in the OS keychain. Most screen translators are thin front-ends for a cloud API. Glimpse is truthful when it says "nothing left your machine".

## Operating Context

- **Invocation:** a global hotkey (Snip `Alt+Shift+S` / `⌃⇧S`, Live toggle `Alt+Shift+L` / `⌃⇧L`; see `docs/decisions/GLIM-23-default-hotkeys.md`) or the tray/menu-bar icon, triggered while another app is focused and often fullscreen. Glimpse stays in the background otherwise and has no main window in normal use.
- **Snip flow:** hotkey → full-screen region picker over the current screen → drag or snap to a region → the popup appears next to the selection, first with detected text boxes, then streamed translation → the translation goes to the clipboard → dismiss and return focus to the previous app.
- **Live flow:** pick a region and pin it. Glimpse captures at about 2–4 fps and re-OCRs only when the pixel diff passes a threshold and the region has been stable for about 300 ms. One persistent popup stays docked to the region and updates in place. Live mode never touches the clipboard. Typical use is a game dialogue box, subtitle strip or chat pane over a long session.
- **Language filtering:** blocks outside the chosen source-language subset are collapsed into an expandable "N blocks skipped" line, not hidden silently.
- **Self-capture:** Glimpse's own windows are excluded from capture at the OS level (ScreenCaptureKit exclusion on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows), so its popups never feed back into OCR.
- **Environments:** fullscreen and borderless games, video players, browsers, PDF readers, chat apps. Multi-monitor and mixed-DPI setups. Light and dark OS themes. Underlying content can be any brightness or colour.
- **First run:** grant permissions (macOS Screen Recording; possibly a Gatekeeper bypass because builds are unsigned), download the translation model, pick a target language and hotkeys.

## Capabilities and Constraints

**Surfaces**
1. **Region picker overlay:** transparent full-screen overlay with crosshair, zoom loupe, live size readout, dimmed surround, and snapping to window edges.
2. **Snip popup:** one-shot result next to the selection. Shows detected text boxes, then streamed translation, with copy-to-clipboard and a "N blocks skipped" expander.
3. **Live docked popup:** one persistent popup attached to the pinned region, updated in place, with changed blocks highlighted. Controls to pause, re-pin and stop.
4. **Settings:** target language, source-language subset, hotkeys, provider choice (local or cloud) and API keys, model management, appearance and motion preferences.
5. **Onboarding / first run:** permissions, model download with progress, Gatekeeper/SmartScreen guidance for unsigned builds, first hotkey.
6. **Tray / menu-bar item:** start Snip or Live, show the active provider, current Live status, settings, quit.

**Hard constraints**
- **Offline-first:** the default path needs no network after the model download. Bundled OCR and a local translation model.
- **Privacy:** cloud providers are opt-in, use the user's own API keys, and store them only in the OS keychain (macOS Keychain / Windows Credential Manager). When a cloud provider handles a request, the UI says so clearly, on that result and in the tray.
- **Two OSes, one product:** Windows and macOS, each following its own conventions for hotkeys, permissions, window materials and tray behaviour. Linux is deferred.
- **Unsigned releases** from GitHub. Users will hit Gatekeeper and SmartScreen warnings, and macOS permission prompts may behave differently for unsigned apps. Onboarding has to explain this honestly.
- **Every script and both directions:** CJK, Arabic, Hebrew, Devanagari, Thai, Cyrillic and more, in source and target text. RTL layout and mixed-direction content must render correctly. Fonts must fall back across scripts (Noto) so no text shows as tofu.
- **Latency:** popups appear in under 100 ms because windows are pre-created and hidden. OCR and translation then fill in progressively.
- **Local model cost:** models are large and inference runs on the user's CPU/GPU. The model download and Live-mode capture loop must respect disk, bandwidth and battery.

**Terminology:** *Snip* (one-shot mode), *Live* (pinned, continuously updated mode), *region*, *block* (one detected text unit), *source-language subset*, *provider* (OCR or translation engine, local or cloud).

**Decided**
- Default hotkeys: `docs/decisions/GLIM-23-default-hotkeys.md`.
- Per-block language detection (accepted for now): `docs/decisions/GLIM-21-language-detection.md`.
- Provisional, owner can override: stack (`GLIM-26-stack.md`), default translation model (`GLIM-85-translation-model.md`), translation cache (`GLIM-20-translation-cache.md`), first cloud providers (`GLIM-22-cloud-providers.md`).

**Open decisions**
- Gatekeeper bypass guidance for unsigned macOS builds.

## Brand Commitments

- **Name:** Glimpse. Icon at `assets/icon.svg`.
- **Personality:** calm, fast, unobtrusive, native. A utility that gets out of the way. It should feel like part of the OS, not a branded app asking for attention. No mascots, no celebration, no upsell.
- **Binding visual constraints given so far (recorded, not expanded; DESIGN.md owns the details):** use native window materials (macOS vibrancy, Windows Mica/Acrylic); follow the OS light/dark setting; use Noto fallbacks for all scripts; aim for the region-picker feel of CleanShot X and Shottr.
- **Open source** on GitHub, so the UI, copy and privacy claims are public and auditable.

## Evidence on Hand

- `assets/icon.svg`: the app icon.
- `README.md`: placeholder only.
- No screenshots, users, testimonials, benchmarks, accuracy or latency figures, or press exist yet. Future work must not invent them. Claims like "under 100 ms" are targets, not measured results.

## Product Principles

1. **Never in the way.** Glimpse appears beside the text it explains, at the moment it's needed, and leaves without a trace. It doesn't steal focus longer than needed, doesn't cover the source text, and never touches the clipboard in Live mode. Every surface can be driven entirely from the keyboard and dismissed in one keystroke.
2. **Instant first, then progressive.** Something real shows at once: the popup in under 100 ms, then the detected text boxes, then the translation streaming in. Progress is shown with real content, not spinners or blank waits.
3. **Show change, not churn.** In Live mode, stability matters more than freshness. Update in place, highlight only the blocks that changed, and never re-render or reflow the whole popup when one line changes.
4. **Private by default, honest always.** Local processing is the default. Leaving the device is always the user's explicit choice and always visible. The UI never implies privacy it isn't delivering.
5. **Every language is first-class.** Any script, either direction, or a mix in one region must render correctly with fonts that fit. Skipped or filtered content is acknowledged ("N blocks skipped"), never dropped silently.

## Accessibility & Inclusion

- Full keyboard control of every surface, including the region picker, with visible focus.
- Respect the OS reduced-motion setting. Highlights and streaming must still communicate without animation.
- Follow OS light/dark appearance. Popups must stay legible over any underlying content, light, dark or busy.
- RTL layout and bidirectional text are correct in popups and settings, not only in translated output.
- Readable sizing for all scripts, including dense CJK and complex Indic and Arabic shaping.
- (open) Screen-reader support for popups and Live updates, such as announcing changed blocks politely. The approach still needs to be decided.
