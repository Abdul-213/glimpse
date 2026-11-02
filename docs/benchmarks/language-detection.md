# Language detection benchmark: fastText thresholds (GLIM-142)

`bun run bench:lid` scores the GLIM-21 detection rules over fastText `lid.176.ftz` (GLIM-104), the
detector `planDetector` picks when the user's source subset has a language ELD can't cover.
It calibrates fastText's own thresholds (`FASTTEXT_TUNING` in
`packages/providers/src/language-detect/fasttext.ts`). ELD's thresholds (GLIM-140: rule 4w
margin 0.01 under 24 letters) are untouched and are covered by the OCR benchmark
([ocr.md](ocr.md)). The latest numbers, the full tuning grid and every remaining miss are in
[language-detection-results.md](language-detection-results.md) (generated, `--grid`).

## Corpus

`packages/providers/bench/detection/corpus.ts`: 37 captures, 190 blocks. Each capture is what
one Snip of a window hands the detector after OCR: its blocks in reading order with the expected
language, and the source subset a user reading it would plausibly have. Target is English.

| Language | Subset | Captures |
|---|---|---|
| Indonesian | `{id, en}`, `{id}` | settings list, save dialog, chat, shop page with an English button, news article, subtitles |
| Swahili | `{sw, en}`, `{sw}` | the same six |
| Uzbek (Latin) | `{uz, ru, en}`, `{uz}` | settings, dialog, chat, the chat as PaddleOCR reads it (ʻ → `'`), article, login with Russian blocks |
| Afrikaans | `{af, nl, en}`, `{af}` | settings, dialog, chat |
| Galician | `{gl, es, pt, en}` | settings, dialog, article |
| Macedonian | `{mk, bg, en}` | menu, dialog, chat |
| Kazakh | `{kk, ru, en}` | settings, chat, login with Russian blocks |
| Mongolian | `{mn, en}` | settings, chat |
| Nepali | `{ne, hi, en}` | settings, dialog, chat |
| Pashto | `{ps, fa, en}` | settings, chat |

Every subset makes `planDetector` pick fastText (the runner and a test check this). By weighted
letters, 31 blocks are short (< 8, rule 4's floor), 99 medium (8–23) and 60 long. Several labels
are spelled the same in a neighbouring language (gl "Cancelar" = es/pt, mk "Нов прозорец" = bg,
ne "सामान्य" = hi, ps "تنظیمات" = fa), as in real windows. The strings were written for this
benchmark, modelled on common desktop and mobile app strings, and have not been reviewed by
native speakers.

Three of these windows are also OCR benchmark cases (`latin-id-settings`, `latin-sw-shop`,
`latin-uz-chat`, script group "Latin (fastText)"), so the bench:ocr run goes through fastText
too, starting from real OCR output.

## Method

- **fastText alone**: the top-1 label of each block's detection copy against the truth.
- **GLIM-21 rules**: `detectCaptureLanguages` per capture (Snip mode, OCR confidence 0.95). A
  block is right when its action is right (translate a subset language, keep English, skip a
  language outside the subset) and, if translated, its source language is right. Errors are
  *missed* (should have been translated but was kept or skipped: the user sees nothing) or
  *wrong source* (translated from the wrong language, usually a close relative).
- **Grid** (`--grid`): τ 0.1–0.8 in steps of 0.05, rule 4w off or margin 0.1–1.0 under 16–64
  letters. fastText's `reliable` flag is "top-1 ≥ τ", so τ moves both.
- "Before" is GLIM-104 as shipped (τ 0.5, rule 4w off); "after" is `FASTTEXT_TUNING`.

## Results (2026-11-02)

| | short | medium | long | all | missed | wrong source |
|---|---|---|---|---|---|---|
| fastText alone (top-1) | 22.6% | 48.5% | 73.3% | 52.1% (99/190) | | |
| rules, before (τ 0.5, no 4w) | 61.3% | 69.7% | 80.0% | 71.6% (136/190) | 30 | 24 |
| **rules, after** (τ 0.5, 4w 0.7 under 48 letters) | 67.7% | 73.7% | 83.3% | **75.8% (144/190)** | 27 | 19 |

By language, rules after (before): id 100% (100%), uz 82% (82%), mk 88% (88%), kk 87% (80%),
mn 100% (83%), ne 100% (93%), af 65% (59%), gl 57% (36%), ps 45% (45%), sw 30% (30%). English and
Russian blocks in the mixed windows are 100% either way.

OCR benchmark, the three fastText cases: 12/17 blocks detected both before and after (id 8/8,
sw 4/5, uz 0/4; the uz and sw misses are the two model limits below). The ELD cases are
unchanged (100% detection in every script).

**GLIM-144 (Uzbek ʻ in the detection copy).** With Uzbek in the subset, the detection copy now
maps an apostrophe-like mark after o/g and before a letter back to ʻ (U+02BB), the letter OCR
reads as `'`. Same tuning: rules 75.8% → **77.9% (148/190)**, uz 82% → 96% (27/28; only
"Sozlamalar" still reads as English), `uz-chat-ocr` 0/4 → 4/4, fastText alone 52.1% → 54.2%.
bench:ocr `latin-uz-chat` detection 0/4 → 4/4 (Latin (fastText) 70.6% → 94.1%); every ELD case
is unchanged. The grid still puts τ 0.5 and the 0.7 / 48 rule 4w at or within one block of the
best; the numbers in [language-detection-results.md](language-detection-results.md) include it.

## Findings

1. **τ stays 0.5.** It is the best value with or without rule 4w. Lower lets noisy short labels
   through rule 4 (0.4: 131/190 without 4w); higher sends good blocks to rule 5 (0.6: 129/190).
   The rules already add 20 points over fastText alone, mostly through rule 5b: the capture's
   confident majority carries short labels fastText can't read.
2. **Rule 4w helps fastText, with a margin on its own scale: 0.7 under 48 letters** (+8 blocks,
   136 → 144). Softmax probabilities on a short block rarely say more than "somewhere near here"
   (gl "Abrir automaticamente ao acender o ordenador": pt 0.79 / gl 0.15; ne "तिमी अहिले कहाँ छौ?":
   hi 0.67 / ne 0.22), while the joined window reads clearly (that gl list: gl 0.98). So the
   prior should win much more often than on ELD's similarity scores. Results by margin, under
   48 letters: 0.5 → 140, 0.6 → 141, 0.7 → 144, 0.8 → 145, 0.9 → 145, 1.0 → 145. From 0.9 the
   prior starts overriding confident blocks of another language in mixed windows (kk
   "Телефон нөміріңізді енгізіңіз" at 0.94 in a window whose Cyrillic prior is uk), so 0.7
   keeps 0.2 of headroom below that cliff for one block less than 0.8. 48 letters is where the
   gain levels off (24 and 32: 140, 48 and up: 144). The one block 4w makes worse is ps
   "خبرتیاوې" (ps 0.66) in a settings list whose joined text reads fa.
3. **A separate, lower threshold for the script prior doesn't help** (measured 0.25–0.5 with τ
   0.5: no change). Where the Swahili and Uzbek window priors fall below 0.5 (sw 0.44–0.47, uz
   0.47), the failing blocks don't list sw/uz among their top 5 at all, and rule 5b already
   uses the confident majority. Asking fastText for its top 10 instead of 5 changes nothing
   either.
4. **Model limits that no threshold fixes** (follow-ups):
   - **Swahili** (GLIM-145): lid.176 barely knows Swahili UI or chat text (18.5% alone):
     "Habari yako? Umefika wapi?" reads pl 0.77, "Nunua sasa" eo 0.89. The reference Python
     fastText gives identical scores, so it is the model, not the WASM build. Words lid.176 has
     no n-grams for all get one fixed distribution (en 0.12, ca 0.09, de 0.08, oc 0.05, fr 0.05:
     "Jumla", "Batal", "Xeral", "Ekran"), and rule 5c takes that `en` at face value, so with
     English in the subset such blocks are kept as English.
   - **Uzbek apostrophe** (GLIM-144, fixed): lid.176 recognises Uzbek largely by ʻ (U+02BB).
     PaddleOCR reads it as `'`, and the detection copy turned `'` into a space ("yo ldaman"),
     after which fastText read jv/lt/en. Uzbek subsets now get oʻ/gʻ back in the detection copy
     (above). The other in-word mark, ʼ (U+02BC, "maʼlumot"), doesn't help lid.176 either way
     ("doʼstim" scores like "do stim"), so it is left alone.
   - **Close relatives in the subset**: af with nl, gl with pt, ps with fa. The joined window
     itself often reads as the relative (af settings: nl 0.49 / af 0.41; ps settings: fa 0.63),
     so rules 4w and 5b inherit it. The translation is then from a close relative (counted as
     wrong source), not missing.
