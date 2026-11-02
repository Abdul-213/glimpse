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
the output is deterministic). 22 cases:

| Script | Cases | What they cover |
|---|---|---|
| Latin | 7 | en dialog (title, wrapped body, buttons), de dark settings list, fr article, es 12 px menu bar at 1x, vi diacritics, en outlined subtitle over a busy video frame (JPEG q60), en low-contrast placeholder text |
| CJK | 5 | ja game dialogue box over a scene, ja UI with embedded Latin, zh-Hans paragraph + buttons, ko chat bubbles, ja vertical-rl columns |
| Arabic | 2 | RTL article (heading + right-aligned paragraph), dark UI label + buttons (JPEG q75) |
| Cyrillic | 3 | ru dialog, uk outlined subtitle over video (JPEG q60), bg menu (generic Cyrillic recogniser) |
| Devanagari | 2 | hi article, dark UI label + buttons (JPEG q75) |
| Thai, Greek, Mixed | 3 | th notice, el dialog, a window with Japanese and English blocks |

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

1. **Cyrillic and Greek are read as Latin look-alikes when the subset includes English**
   (CER 72 % Cyrillic, 24 % Greek). `planRecognizers({ru, uk, bg, en})` is `[ch, eslav]` and
   `{el, en}` is `[ch, el]`: `ch` wins English's tie-break and goes first, reads "Сохранить" as
   "CoxpaHnTb" with a high score, and rule 3 never re-reads it because the output *is* Latin.
   With `{ru}` alone the same frames read correctly; the uk subtitle survives only because `ch`
   scored it low. Detection then sees French/Catalan-looking Latin and skips the blocks. This is
   the biggest accuracy problem the benchmark found: **GLIM-125**.
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
   - Vertical Japanese with wide column spacing (pitch ~2x the glyph size) splits into one
     block per column (`columnGap` 1). Reading order is still right, so translation gets the
     columns in order, just as separate blocks.
   Translation quality cost is small for the first two (sentences are split before translation
   either way), but the popup shows one block where the UI has two. Tuning proposal and the
   trade-offs are in **GLIM-127**; this benchmark is how to check it.
4. **Small losses**: trailing "." / "?" / "।" sometimes dropped (ar, hi, ko, el lines), Korean
   word spaces sometimes dropped ("그럼역 앞카페에서", WER 39 % at 2 % CER), Arabic "هذه" → "هه"
   and "رद्द" → "रह" on the JPEG'd dark UIs, kana "う" read as "ラ" in vertical text. Worth
   watching, not worth tuning for yet.
5. **Latency** (CI runner: 2-core EPYC 7763, ORT 1 thread, so a slow machine): warm p50 per
   case 108–611 ms for regions up to 640x240 and 948 ms for the 760x300 window; over all runs
   p50 221 ms, p90 581 ms. Cost follows line count more than pixels (`cjk-zh-hans-article`,
   `cyrillic-ru-dialog` with two recognisers, and `latin-en-dialog` are the slow regions). Provider
   init 248 ms, warmup 133 ms; a first call that loads an on-demand recogniser adds up to ~130 ms here.
   Per-case numbers in [ocr-results.md](ocr-results.md).
