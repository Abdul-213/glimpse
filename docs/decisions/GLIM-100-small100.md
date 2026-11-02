# GLIM-100: SMaLL-100 for the long tail

Status: implemented (2026-11-02). Answers GLIM-85 open question 4 (SMaLL-100 or M2M-100 418M).

## Decision

- **SMaLL-100** (`alirezamsh/small100`, MIT, revision `8ab680e`), not M2M-100 418M. Same 100
  languages and the same tokenizer, a 3-layer decoder instead of 12: about **6x faster per
  sentence**, **+7 chrF++** on our long-tail set, and **~55% less peak memory**. Download size is
  about the same (618 MB vs 640 MB): the 128k-token embedding table dominates both.
- **int8, not int4.** Dynamic int8 per channel (Optimum export, merged KV-cache decoder). A 4-bit
  build (MatMulNBits + 4-bit embeddings, 385 MB) lost 8 chrF++ points and was slower on AVX2.
- **Files:** the int8 export published as `R4kSo1997/small100-onnx-int8_v2` @ `d66e226` (the same
  Optimum + `quantize_dynamic` pipeline, per channel, no reduced range), and `tokenizer.json` from
  `Xenova/m2m100_418M` @ `9c374f0`, all pinned by SHA-256 in `app/models/manifest.json` (`small100`,
  kind `translation-model`, on demand). Our own export of the pinned upstream revision
  (`packages/providers/scripts/small100-export.py`) scored within noise of it; publishing that on a
  Glimpse mirror and listing it first is GLIM-137.
- **Tokenizer in TypeScript:** SMaLL-100's `sentencepiece.bpe.model` and `vocab.json` are
  byte-identical to M2M-100's, so M2M-100's `tokenizer.json` runs it through
  `@huggingface/tokenizers` (pure JS, Apache-2.0). The ids match transformers' `M2M100Tokenizer`
  over SMaLL-100's own files (`small100-real.test.ts`). The only SMaLL-100 difference is the
  prompt: the *target* language token goes first on the encoder side, and the decoder starts at
  `</s>` with no forced BOS (`decode.ts`).
- **Routing:** second in the default chain, flagged `longTail`, so `routeTranslation` gives it
  only pairs Bergamot can't serve at all. A missing Bergamot pack is offered before it, and while
  Bergamot is still starting nothing Bergamot lists goes to it.

## Measurements

This machine: KVM guest, AMD EPYC, 8 vCPU, AVX2 (no VNNI), Linux, Bun 1.4.4, onnxruntime-node
1.31.1, 4 intra-op threads. **The VM was shared with other agents (load average 4–9)**, so read
p50s as relative, not absolute. 120 sentences: the first 10 of FLORES-101 devtest in each of
sw, zu, yo, am, ka, hy, km, my, ps, ne, ja, de, into English (news sentences, ~25 words; much longer
than a typical UI line). chrF++ against the English references (sacrebleu, `word_order=2`).
`packages/providers/scripts/small100-bench.ts` reproduces it.

All 120 sentences (each model in its own run, so load differed between runs):

| Model (int8 ONNX) | Download | Load | p50 / p90 per sentence | ms per output token | RSS after load / peak | chrF++ |
|---|---|---|---|---|---|---|
| **SMaLL-100, pinned export** (shipped) | 618 MB | 6.4 s | 1.35 s / 2.9 s | 36 | 927 / 1178 MB | **44.0** |
| SMaLL-100, our export | 618 MB | 6.1 s | 0.90 s / 1.6 s | 22 | 919 / 1170 MB | 43.4 |
| SMaLL-100, 4-bit (rejected) | 393 MB | 6.5 s | 1.15 s / 2.4 s | 27 | 732 / 948 MB | 35.2 |
| M2M-100 418M (`Xenova/m2m100_418M`, GLIM-17) | 640 MB | 12.5 s | 7.5 s / 14.6 s | 204 | 1361 / 2651 MB | 37.0 |

Back to back on the same 16 sentences (sw, ja, km, am × 4), same load:

| Model | p50 / p90 per sentence | ms per output token | Peak RSS |
|---|---|---|---|
| SMaLL-100, pinned export (two runs) | 1.39 s / 2.95 s, 1.28 s / 3.17 s | 27–28 | 1.18 GB |
| SMaLL-100, our export | 1.18 s / 1.87 s | 23 | 1.16 GB |
| M2M-100 418M | 8.67 s / 13.0 s | 167 | 2.61 GB |

GLIM-17's reference sentence `明日の会議は午後三時に始まります。` (M2M-100: 1.8–3.5 s, peak RSS
1.9 GB, and "begins at 3 a.m.", wrong) takes **0.24 s** with SMaLL-100: "The meeting will start
tomorrow at 3 pm." Short UI-length lines (`Die Datei konnte nicht gespeichert werden.`,
`Habari za asubuhi, unaendeleaje?`) take ~0.2 s once loaded; the first request pays ~6–7 s to
load the model.

Per-language chrF++, SMaLL-100 pinned export vs M2M-100: sw 58.4 / 52.6, zu 42.9 / 35.1,
yo 29.4 / 24.6, am 38.5 / 31.9, ka 42.9 / 27.2, hy 48.3 / 40.0, km 43.8 / 38.5, my 33.2 / 22.9,
ps 45.2 / 38.3, ne 47.7 / 33.1, ja 44.2 / 46.1, de 53.7 / 55.7. M2M-100 is only ahead on ja and
de, which Bergamot serves anyway. Yoruba and Burmese are weak; expect rough but useful output for
the long tail, not Bergamot quality.

Notes:

- onnxruntime session options matter for the M2M-100 export: with the CPU arena off and
  `graphOptimizationLevel: "all"` (the OCR Worker's settings) it ran ~4x slower per token
  (1.07 s vs 0.26 s). SMaLL-100 is insensitive to them (±5%), so its Worker keeps the arena off
  for the smaller resident size. The M2M row uses onnxruntime's defaults.
- ~20% of the time is the encoder; the rest is the decoder, dominated by the 128k-vocabulary output
  projection. Greedy search only (beam search would multiply the decoder cost).
- Memory is held only while the Worker runs: it starts on the first long-tail request and exits
  after 2 minutes idle (`idleSeconds`).

## Not verified

- No measurement on real Windows or macOS hardware (Apple Silicon int8 kernels differ; the pinned
  export was quantised for ARM64 by its author, which should help there).
- Quality on short UI strings, chat and game text (the GLIM-85 open question 6 test set doesn't
  exist yet); FLORES is news prose.
