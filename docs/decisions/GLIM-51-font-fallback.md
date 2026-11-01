# GLIM-51: Font fallback strategy (Noto)

Status: **Proposed** (2026-11-01, agent). The OS font names below come from Apple's and Microsoft's published font lists and from the stacks in `.impeccable/design.json`. **None of it has been checked on a real Mac or Windows PC yet.** The test page (gallery `?page=scripts`) is how a person checks it (GLIM-87).

## Decision

**Glimpse bundles no fonts in v1.** Each script uses the OS's own face for it, through the per-script stacks generated into `packages/ui/src/styles/tokens.css` (`:lang()` rules). The Noto family at the end of each stack is a bonus for users who have it installed, not something Glimpse ships.

Revisit if either of these happens:
1. The hardware check finds tofu or a clearly wrong face for a script on a default macOS 14+ or Windows 10/11 install.
2. The owner decides Urdu must render in Nastaliq on Windows machines without the optional "Urdu Typesetting" font (see Gaps). The proposed fix is an optional download of Noto Nastaliq Urdu through the model download manager (GLIM-38), not a bundle.

## Why not bundle Noto

- **Size.** One weight of a single regional Noto Sans CJK font is about 15–20 MB. Glimpse needs five regional sets (SC, TC, HK, JP, KR) and at least two weights (400 and the 600 used by headings). That is well over 100 MB, against a ~29 MB OCR/translation bundle (GLIM-37). The non-CJK Noto families are small (tens to hundreds of KB each), but neither OS needs them.
- **Fidelity.** DESIGN.md's direction is "looks like part of the OS". On each OS the system faces (PingFang, Hiragino, Yu Gothic, Malgun, Nirmala, SF Arabic, Segoe UI) are what the user's other apps use, so Noto would make Glimpse look foreign.
- **Coverage is already there.** Both OSes ship a face for every script group the translation model covers (table below). WebKit and Chromium also fall back per character to any installed font that has the glyph, so even an unlisted script finds the OS's font.

## Coverage by script group

Script groups follow the scripts NLLB-200 covers. "Stack" is the `:lang()` rule in `.impeccable/design.json` → `scriptTypography`; "system" means the base stack plus the browser's per-character fallback.

| Script (sample lang) | macOS 14+ | Windows 10/11 (default install) | Stack |
|---|---|---|---|
| Latin, Cyrillic, Greek (en, vi, ru, el) | SF Pro | Segoe UI Variable (11), Segoe UI (10) | base |
| Georgian, Armenian (ka, hy) | system cascade (Helvetica / Mshtakan) | Segoe UI | base |
| Ethiopic (am, ti) | Kefa | Ebrima | Ethiopic |
| Tifinagh (zgh) | system cascade (verify) | Ebrima | Tifinagh |
| Arabic, Persian (ar, fa) | SF Arabic, Geeza Pro | Segoe UI | Arabic |
| Urdu Nastaliq (ur) | Noto Nastaliq Urdu (ships with macOS) | Urdu Typesetting **only if the optional feature is installed**, else Segoe UI (naskh) | Urdu |
| Hebrew (he, yi) | SF Hebrew | Segoe UI | Hebrew |
| Devanagari (hi, mr, ne) | Kohinoor Devanagari | Nirmala UI | Devanagari |
| Bengali (bn, as) | Kohinoor Bangla | Nirmala UI | Bengali |
| Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Sinhala | Sangam MN / Kohinoor families | Nirmala UI | other Indic |
| Thai (th) | Thonburi | Leelawadee UI | Thai |
| Lao, Khmer (lo, km) | Lao / Khmer Sangam MN | Lao UI, Khmer UI, Leelawadee UI | Lao/Khmer |
| Myanmar, Tibetan (my, bo) | Myanmar Sangam MN, Kailasa | Myanmar Text, Microsoft Himalaya | Myanmar/Tibetan |
| Japanese (ja) | Hiragino Sans | Yu Gothic UI, Meiryo UI | ja |
| Chinese Simplified (zh-Hans) | PingFang SC | Microsoft YaHei UI | zh-Hans |
| Chinese Traditional (zh-Hant, zh-HK) | PingFang TC / HK | Microsoft JhengHei UI | zh-Hant, zh-HK |
| Korean (ko) | Apple SD Gothic Neo | Malgun Gothic | ko |
| Symbols, emoji | Apple Color Emoji | Segoe UI Emoji, Segoe UI Symbol | every stack |

## Gaps and risks

- **Urdu on Windows** renders in naskh unless "Urdu Typesetting" is installed (Settings › Apps › Optional features, or added automatically with an Urdu language pack). It is legible, so it stays a revisit trigger rather than a blocker.
- **Han regional forms** depend on the block's `lang` tag. A Chinese block detected only as `zh` (no script subtag) uses the base stack, so the OS picks the face, which may be the wrong region. Language detection (GLIM-21/39) should emit `zh-Hans` / `zh-Hant`; the test page shows both.
- **Windows 10 font versions** are older (Segoe UI rather than Segoe UI Variable, older Nirmala UI). Check Windows 10 separately in GLIM-87.
- **Per-character fallback** is good in both engines but may pick an odd face for a rare script. The test page's "Expected font" column is what a person compares against.

## How it's built and tested

- Stacks, size step (`--script-scale`) and leading (`--leading-*`) are generated from the sidecar into `tokens.css`. Every element with a `lang` resets to the base stack, then `:lang()` picks the script's stack (zero specificity, so utilities still win). `packages/ui/test/tokens.test.ts` checks the generated rules.
- `app/test/script-samples.test.ts` checks that every sample's `lang` resolves to its declared script, and that every non-base script has a `:lang()` rule in `tokens.css`.
- The test page `bun app/scripts/gallery.ts` → `?page=scripts` shows every script at translation and source size, the mixed-direction cases and long/short text. `--shots` renders it headlessly; the Linux box has no CJK, Indic or SE Asian fonts, so the committed PNGs show tofu for those. That is expected, and it is why the real check is manual.

## Manual test notes (GLIM-87)

On a default macOS 14 and a default Windows 11 (and Windows 10 if supported), open the gallery's `?page=scripts` in the app's webview (dev build) and check:
1. No empty boxes in any row. The face matches the "Expected font" column.
2. Thai, Myanmar, Tibetan and Vietnamese marks are not clipped, and lines don't collide.
3. Every mixed-direction case matches its caption.
4. Urdu: Nastaliq on macOS; on Windows, note whether Urdu Typesetting is installed.
