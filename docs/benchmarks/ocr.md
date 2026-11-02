# OCR accuracy and latency benchmark (GLIM-64)

`bun run bench:ocr` scores the local OCR engine (PaddleOCR PP-OCRv5 mobile on onnxruntime CPU)
over a fixed corpus of frames with ground truth, together with the grouping (GLIM-56) and
language detection (GLIM-49/GLIM-21) stages that run on its output. CI runs it on every PR to
`develop` and fails only on large regressions. The latest numbers are in
[ocr-results.md](ocr-results.md) (generated; CI also attaches a fresh copy to each run's summary
and as the `ocr-bench` artifact).

## Corpus

`packages/providers/bench/ocr/`: `corpus.json` (ground truth) and `corpus/*.png`, rendered by
`make-corpus.mjs` with @napi-rs/canvas and the Noto fonts (re-render instructions in its header;
the output is deterministic). 23 cases:

| Script | Cases | What they cover |
|---|---|---|
| Latin | 7 | en dialog (title, wrapped body, buttons), de dark settings list, fr article, es 12 px menu bar at 1x, vi diacritics, en outlined subtitle over a busy video frame (JPEG q60), en low-contrast placeholder text |
| CJK | 5 | ja game dialogue box over a scene, ja UI with embedded Latin, zh-Hans paragraph + buttons, ko chat bubbles, ja vertical-rl columns |
| Arabic | 2 | RTL article (heading + right-aligned paragraph), dark UI label + buttons (JPEG q75) |
| Cyrillic | 3 | ru dialog, uk outlined subtitle over video (JPEG q60), bg menu (generic Cyrillic recogniser) |
| Devanagari | 2 | hi article, dark UI label + buttons (JPEG q75) |
| Thai, Greek, Mixed | 4 | th notice, el dialog, a window with Japanese and English blocks, a window with Japanese, Russian and English blocks (`{ja, ru, en}`: `ch` reads first, GLIM-125) |

Each case lists its blocks in reading order, each with the expected language and every line's
text and ink box, and the **source subset** a user reading it would plausibly have (Latin cases
`{en, de, fr, es}`, CJK `{ja, zh-Hans, ko, en}`, Cyrillic `{ru, uk, bg, en}`, others `{x, en}`).
The subset is what Snip passes to OCR (it picks the recognisers) and to detection.
"rendered" frames are clean UI text; "screenshot-like" ones are what captures look like: small
1x text, low contrast, outlined subtitles over moving video, compression artefacts.

## Method

The engine runs as Snip calls it: default options, its own grouping, the case's subset as
`languages`, then the app's GLIM-21 detector over ELD (`glim21Detector`, Snip mode). The rec
cache (GLIM-88) is off so repeated runs measure real work. Per case: one first call (loads the
recogniser if needed; reported, not gated), then `--iter` warm runs (default 5); latency is wall
time per `recognise` including the worker round trip, p50 and p90.

Scoring (`metrics.ts`, unit-tested in `packages/providers/test/bench/`):

- **CER** per line: each engine line is assigned to the ground-truth line whose ink box (grown by
  half a line height) contains its centre, fragments are joined in reading direction, and
  character edits are counted with both sides NFKC-normalised and spaces removed. Engine lines
  that match nothing are false positives and count as insertions. Per script: total edits /
  total characters. Scoring per line keeps grouping and reading-order mistakes out of CER.
- **WER**: the same over whitespace-separated words (so missing spaces show up here, not in
  CER); not defined for ja, zh and th.
- **Grouping exact**: share of ground-truth blocks whose lines all landed in one engine block
  that holds nothing else. **Order right**: share of cases whose engine blocks come out in
  ground-truth order. **Detection**: share of ground-truth blocks whose main engine block was
  detected as the expected language.

## Regression gate

`bun run bench:ocr --check` compares with `packages/providers/bench/ocr/baseline.json` and exits
1 when, for any script:

- CER rises by more than max(3 points, 50 % of the baseline), or
- grouping exact or detection falls by more than 20 points, or
- a script, or a case's recogniser, is missing,

or when the summed warm p50 over all cases grows past 3x the baseline (CI runners are shared;
anything smaller is noise). Improvements never fail. After a deliberate change (new corpus
case, model update, a fix that moves the numbers), refresh both files and commit them with the
change:

```sh
bun run models -- --all
bun run bench:ocr --write-baseline --report=docs/benchmarks/ocr-results.md
```

The baseline's latency is from the CI runner (ubuntu-latest, 2 cores), so take `totalP50` from a CI
run's `ocr-bench` artifact when the corpus changes (a loaded 8-core dev machine read 1.7x slower).

## Findings (2026-11-02)

Recognition on clean and screenshot-like frames is good for Latin, CJK, Arabic, Devanagari and
Thai: 0–4 % CER per script, and the hard cases (outlined subtitles over a busy JPEG'd video
frame, 12 px text at 1x, ~2.3:1 low-contrast placeholder text, a game dialogue box) read
perfectly. Detection is 100 % wherever OCR was right, including the mixed ja/en window and the
one- and two-word button labels. What the corpus caught:

1. **Cyrillic and Greek were read as Latin look-alikes when the subset includes English**
   (CER 72 % Cyrillic, 24 % Greek). `planRecognizers({ru, uk, bg, en})` was `[ch, eslav]` and
   `{el, en}` was `[ch, el]`: `ch` won English's tie-break and went first, read "Сохранить" as
   "CoxpaHnTb" with a high score (0.8–0.95), and rule 3 never re-read it because the output *is*
   Latin. Detection then saw French/Catalan-looking Latin and skipped the blocks.
   **Fixed in GLIM-125** (Cyrillic CER 0 %, Greek 1.7 %, Cyrillic detection 33 % → 89 %):
   - Every PP-OCRv5 recogniser's dictionary has basic Latin, and the Cyrillic and Greek ones read
     the English corpus lines as well as `en` does (0.94–1.00), while `ch`, `en` and `el` read
     Cyrillic as look-alike Latin. So English only pulls in `ch` when a CJK language needs it
     anyway, and without `ch` non-Latin recognisers read first: `{ru, uk, bg, en}` is now
     `[eslav, en]`, `{el, en}` `[el, en]`, `{ar, en}` `[arabic, en]`. Cyrillic and Greek lines
     are read once; English lines are read by the specialist and re-read by `en` (rule 3).
   - With CJK in the subset `ch` still reads first (`{ja, ru, en}` → `[ch, eslav]`), so a new
     rule 3a re-reads Latin lines that look like misread Cyrillic/Greek (mixed scripts or
     digits in a word, a capital after a lowercase letter, all look-alike capitals) with the
     Cyrillic/Greek candidate; the re-read wins only if it comes back in its own script.
     `mixed-ja-ru-window` covers this: CER 60 % before, 0 % after.
   The remaining Cyrillic miss is detection, not OCR: the two-word bg menu item "Нов прозорец"
   is detected as Russian.
2. **Vietnamese loses most tone marks** (CER 20 %, WER 61 %): the `latin` recogniser reads
   "Bạn có muốn cài đặt bản cập nhật" as "Ban có muôn cài dt bn cp nhât". A model limit, not a
   pipeline one: no PP-OCRv5 or PP-OCRv6 dictionary has more than 8 of the 52 marked letters.
   **GLIM-126** keeps Vietnamese on the device but marks it partial and points to cloud OCR in
   Settings and the popup ([decision](../decisions/GLIM-126-vietnamese-ocr.md)).
3. **Grouping (GLIM-56 thresholds)**: 78 % of blocks exact. Three patterns:
   - A heading merges into the paragraph under it when the heading is long (≥ `minWrapLength` 6
     line heights) and only ~1.3x the body size (`sizeRatio` 1.5 allows it): en, ru and el
     dialogs. A 24 px heading over 17–18 px text (fr, ar, hi articles) stays separate.
   - Consecutive long labels in a list merge (de settings "Sprache und Region" + "Tastenkürzel",
     bg menu, ja "Wi-Fi…" + "Bluetooth…"): their rows are ~2.5x the font size apart, and on the
     detector's padded boxes the gap is just under `lineGap` 0.6. Short items stay separate.
   - Vertical Japanese with wide column spacing splits into one block per column. The cause was
     not `columnGap`: a six-glyph column is shorter than `minWrapLength` (6 x the column width).
   **Fixed in GLIM-127** (100 % of blocks exact, 64/64; order 100 %; no CER change). Measured
   on PP-OCRv5 boxes, as gap / mean line height: paragraph lines in Latin, Cyrillic, Greek,
   Arabic and Devanagari are at most 0.38 apart (`region-en`: loose leading and a last line
   with no descenders), list rows 0.46 and more, and headings ~0.44 over a box ≥ 1.2x taller.
   CJK paragraph lines reach 0.45 (their boxes hug the ink). So:
   - `lineGap` 0.6 → 0.42, with `cjkLineGap` 0.6 when both lines are Han/kana/Hangul;
   - a line ≥ 1.2x taller than the next (`headingRatio`) stacks only across a gap ≤ 0.3
     (`headingGap`);
   - lines whose scripts differ (Cyrillic over Latin, kana over a mostly-Latin line) don't stack;
   - vertical columns need only 3 column widths of length (`minColumnLength`).
   The GLIM-56 desktop fixture also changed for the better: a chat speaker name ("Li Wei") no
   longer merges into the message above it. Without that merged block, reading order was read
   row by row across the side-by-side windows. Rows are now cut one gap at a time, widest first,
   and a column gutter more than 3x the widest row gap is cut first, so each window is read whole.
   Language detection on the newly separate short bg menu items ("Нов прозорец" → ru,
   "Последни документи" → sr under GLIM-21 rule 4) was fixed by GLIM-140: short near-ties now
   take the capture's script prior (rule 4w), so Cyrillic detection is 9/9.
4. **Small losses**: trailing "." / "?" / "।" sometimes dropped (ar, hi, ko, el lines), Korean
   word spaces sometimes dropped ("그럼역 앞카페에서", WER 39 % at 2 % CER), Arabic "هذه" → "هه"
   and "رद्द" → "रह" on the JPEG'd dark UIs, kana "う" read as "ラ" in vertical text. Worth
   watching, not worth tuning for yet.
5. **Latency** (CI runner: 2-core EPYC 7763, ORT 1 thread, so a slow machine): warm p50 per
   case 79–612 ms for regions up to 640x240 and 937 ms for the 760x300 window; over all runs
   p50 165 ms, p90 647 ms. Cost follows line count more than pixels (`cjk-zh-hans-article`,
   `cjk-ko-chat`, `latin-fr-article` and `latin-en-dialog` are the slow regions). Provider init
   247 ms, warmup 133 ms; a first call that loads an on-demand recogniser adds up to ~130 ms here.
   GLIM-125 cut the non-Latin, non-CJK cases by about half: they no longer read every line with
   `ch` first (`cyrillic-ru-dialog` 611 → 441 ms, `greek-el-dialog` 203 → 100, `arabic-ar-article`
   367 → 166, `devanagari-hi-article` 331 → 166, `thai-th-notice` 199 → 79; summed p50 over the
   original 22 cases 7016 → 6026 ms). Per-case numbers in [ocr-results.md](ocr-results.md).
