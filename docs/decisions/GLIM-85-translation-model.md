# GLIM-85: Decision on the default translation model (licence)

Status: **Accepted, provisional** (2026-11-01, adopted so build work can start; the owner can override) · Date: 2026-10-30 · Scope: Windows + macOS, local (offline) translation provider only; Bun/TypeScript first, Rust sidecar or Tauri fallback. Not legal advice. Get a quick licence check before the first public release.

## Recommendation

**Default: Mozilla's Firefox Translations models ("Bergamot", Marian student models).** Weights and runtime are both MPL-2.0. They cover 59 languages to and from English (Japanese, Korean, Simplified and Traditional Chinese, Arabic, Thai, Hindi and most European languages). A pair that doesn't include English goes through English (`ja→en→de`). Language packs are downloaded on demand, about 17–44 MB for each direction.

**Fallback: SMaLL-100 (MIT), via ONNX Runtime, with M2M-100 418M (MIT) as a stand-in that needs no extra work.** It covers two cases:

1. **Long tail:** the roughly 40 languages in the M2M-100 set that Bergamot lacks (Swahili, Zulu, Yoruba, Amharic, Georgian, Armenian, Khmer, Burmese, Sinhala, Nepali, Pashto…).
2. **Runtime fallback:** if the Bergamot runtime fails the shell spike, this is an all-ONNX path on the same runtime as PaddleOCR.

**Optional "Enhanced" download (permissive): Hy-MT2-1.8B (Apache-2.0)** for users whose machines can run it. It has the best quality of anything small, and it translates directly between any of its 33 languages with no pivot. Recommended for Snip. Its Live-mode latency needs measuring first.

**Optional NC download: offer NLLB-200 distilled 600M, but opt-in only, later, and gated.** Keep it out of onboarding and never auto-select it. Before downloading, show a one-screen notice ("CC-BY-NC-4.0: non-commercial use only; not for use at work or for paid work"). Download it straight from Meta's Hugging Face repo, not a Glimpse mirror. Low priority: with the three options above it mainly adds the ~100 low-resource languages that nothing else covers.

Why:

1. **Licence fits "free, open source, use it anywhere".** MPL-2.0, MIT and Apache-2.0 all allow commercial use by anyone, so someone using Glimpse at work is fine. NLLB (CC-BY-NC-4.0) is not: the restriction falls on the *user*, and Glimpse can't make it go away (see the licence analysis).
2. **Quality per MB and per millisecond is far ahead.** On matched FLORES directions, Bergamot averages **59.8 chrF++ into English vs 59.5 for NLLB-600M**, and **55.5 out of English vs 50.3 (NLLB-600M) and 52.6 (NLLB-1.3B)**. Each direction is about 30 MB, against about 900 MB for NLLB-600M int8. The models were built for CPU-only, single-sentence, in-browser use, which is exactly Glimpse's case. In our smoke test NLLB-600M int8 took **1.5–2.9 s per short block** through transformers.js, which is already over the Snip budget before OCR runs.
3. **Actively maintained, with a big shipping user.** Firefox ships these models on desktop and Android, `mozilla/translations` was pushed yesterday, and the language list is growing. NLLB and M2M-100 are frozen (fairseq archived), and MADLAD-400 hasn't changed since 2023.

What we're *not* recommending:

- **NLLB-200 as default.** Licence (NC), size (~0.9 GB int8), latency, and short-input hallucination: our smoke test turned `Einstellungen` into "The following is the list of the".
- **MADLAD-400 3B.** Apache-2.0 and 419 languages, but ~3.2 GB as int8 ONNX (1.65 GB as GGUF q4), slow on CPU, and below NLLB-54B on FLORES. There is no smaller MT variant: the sizes are 3B, 7.2B and 10.7B.
- **TranslateGemma 4B as default.** 55 languages, but the Gemma Terms of Use carry use restrictions that pass on to redistributors, and a 4B model is too slow for CPU Live mode.
- **Hy-MT1.5 / Hunyuan-MT-7B.** Their Tencent HY licence **excludes the EU, UK and South Korea**. Only Hy-MT2 is Apache-2.0. Pin to it.
- **Plain Opus-MT** (Helsinki). Apache-2.0 and per-pair like Bergamot, but older, larger per pair (~300 MB fp32, ~110 MB int8 ONNX) and generally weaker. The multilingual `mul-en` / `en-mul` models are noticeably weaker still. Keep it as a source of extra pairs if Mozilla lacks one.

## Comparison

"Smoke" figures are ours (method below) and **indicative only**. chrF++ is on FLORES-200 devtest for NLLB and on FLORES+ devtest for Bergamot (Mozilla's registry). The two test sets are close but not identical.

| Candidate | Licence: code · weights | Languages / any-to-any | Quality (published) | Disk: fp32 → int8/q4 | RAM · CPU latency (short block) | ONNX / JS (Bun) / Rust | Maintenance |
|---|---|---|---|---|---|---|---|
| **Firefox Translations (Bergamot)** | MPL-2.0 · **MPL-2.0** ("model files are distributed under the MPL 2.0 license") [1] | 59 ↔ en (113 directions; 54 languages both ways). Any-to-any by **English pivot**: one model per source language plus one for the target. | Matched with NLLB on 53 / 57 directions: xx→en **59.8** chrF++ (NLLB-600M 59.5, 1.3B 61.6, 54B 63.3). en→xx **55.5** (50.3 / 52.6 / 54.3). en→ja 30.1 vs 23.6 (600M). ko→en 55.0 vs 52.5. [1][3] | Ships int8 only: **17–44 MB per direction** (median 32 MB) plus vocab and shortlist | ~tens of MB per loaded pair (*unverified*). Built for real-time in-browser CPU translation; expect **tens of ms** per short block (*estimate, not measured*). Pivot doubles it. | **Not ONNX.** Marian intgemm format, run by bergamot-translator (C++ with an official **WASM** build that Firefox uses; npm packages are community forks, most recent 2025-12). Rust: no maintained binding (*unverified*); a C++ sidecar or FFI would be needed. | Very active (pushed 2026-10-29) |
| **SMaLL-100** (330M) | MIT · MIT [6] | 101 languages, direct any-to-any (single model) | FLORES-101 avg spBLEU **10.7**, ≈ M2M-100 1.2B (10.6) and above M2M-418M (7.3), "4.3× faster" than 1.2B. [6] | 1.33 GB → ~0.6 GB ONNX fp32 (community export); int8 ≈ 0.2 GB (*estimate*) | Like M2M-418M or faster (*estimate*) | M2M-100 architecture, so Optimum exports it. One community ONNX repo. Needs its custom tokenizer (target-language token on the source side) ported to JS. Rust: `ort`. | Paper 2022, dormant |
| **M2M-100 418M / 1.2B** | MIT · **MIT** (HF cards) | 100 languages, direct any-to-any | FLORES-101 spBLEU 7.3 / 10.6 (vs 12B 13.3). [6] Smoke: best output of the three on our Japanese chat line. | 418M: 1.94 GB → **0.63 GB** int8 ONNX. 1.2B: 4.96 GB → ~1.3 GB (*est.*) | Smoke (418M): **0.6–2.0 s**, RSS 2.3 GB (untuned path) | **Mature:** `Xenova/m2m100_418M` (int8, q4, fp16), transformers.js pipeline works unmodified. Rust: `ort`, CTranslate2 (`ct2rs`). | Frozen (fairseq archived) |
| **NLLB-200 distilled 600M / 1.3B** | MIT · **CC-BY-NC-4.0** [2] | 200 languages (204 codes), direct any-to-any | FLORES-200 avg chrF++ (our averages of Meta's metrics files): xx→en **52.3 / 55.1**, en→xx **41.8 / 44.0**, non-English pairs 39.5 / 41.5 (54B MoE: 56.8 / 45.3 / 42.7). [3] Smoke: hallucinated on a 1-word UI label and dropped the second sentence in 2 of 3 multi-sentence blocks. | 600M: 2.46 GB → **~0.9 GB** int8 ONNX (encoder 419 MB + merged decoder 476 MB). 1.3B: 5.48 GB → ~1.5 GB (*est.*) | Smoke (600M): **1.5–2.9 s** (7.2 s on a long ja sentence), RSS ~3.5 GB, load 17–31 s (untuned path) | **Mature:** `Xenova/nllb-200-distilled-600M` and many 1.3B exports; transformers.js works. Rust: `ort`, CTranslate2. | Frozen |
| **MADLAD-400 3B** | Apache-2.0 · **Apache-2.0** [4] | 419 languages (evaluated on 204), direct any-to-any via a `<2xx>` token | FLORES-200 avg (BLEU / chrF): xx→en 29.7 / 54.4, en→xx 17.3 / 44.1, xx→yy 8.8 / 31.2. NLLB-54B on the same: 35.5 / 59.6, 20.7 / 50.1, 13.7 / 40.5. [5] | 11.8 GB → **~3.2 GB** int8 ONNX (community); 1.65 GB GGUF q4 | Several seconds per block on CPU (*estimate*) | Community ONNX only (about 6 repos, low downloads); T5 export via Optimum works. Rust: candle `quantized-t5` (has a MADLAD example), CTranslate2. | No updates since 2023 |
| **Hy-MT2-1.8B** (May 2026) | Apache-2.0 · **Apache-2.0** (LICENSE.txt in the HF repo) [7] | 33 languages plus 5 dialects/variants (zh, en, ja, ko, ar, ru, th, vi, hi, km, my, bo, ug…). **Direct any-to-any, no pivot.** Missing: Greek, Swedish, Romanian, Hungarian, Finnish, Danish and others | FLORES-200 XX⇔XX XCOMET-XXL **79.8**, Microsoft Translator 80.1, Gemma4-E4B 80.0. Q4_K_M 77.2 vs BF16 79.2. [8] No chrF reported; not comparable with the rows above. | 4.08 GB bf16 → **1.13 GB** GGUF Q4_K_M; 0.44 GB at 1.25-bit (larger quality loss); ~1.08 GB ONNX int4 (community) | ~1.5–2 GB RSS. LLM decoding at a few tens of tok/s on a laptop CPU, so ~0.5–1.5 s per short block (*estimate, not measured*) | ONNX: community exports only (onnxruntime-genai format). Official: GGUF for llama.cpp (Rust `llama-cpp-2`; JS `node-llama-cpp`, Bun *unverified*). `onnx-community/HY-MT1.5-1.8B-ONNX` suggests transformers.js support for the architecture (*unverified*). | Active (three releases in 9 months) |
| TranslateGemma 4B | Gemma ToU · **Gemma Terms of Use** (restricted uses; terms pass to redistributors) [9] | 55 languages, direct | WMT24++ MetricX 5.32, COMET 81.6 [9] | ~8 GB bf16 → ~2.5 GB q4 (*est.*) | Too slow for Live on CPU (*estimate*) | `onnx-community/translategemma-text-4b-it-ONNX` | Active (Jan 2026) |
| Opus-MT (Helsinki) | MIT · Apache-2.0 / CC-BY-4.0 per model card | ~1,000+ pair models; `mul-en`, `en-mul`, `mul-mul` multilingual | Per-pair Tatoeba/FLORES scores in each card; generally weaker than Bergamot (Mozilla's evals include it) | ~300 MB → ~110 MB int8 ONNX per pair | Smoke (`mul-en`): 0.14–0.56 s, but dropped the second sentence of a chat line | Mature (`Xenova/opus-mt-*`) | Active (repo pushed 2026-02) |

### Smoke test (ours, indicative)

- **Setup:** Node 24, `@huggingface/transformers` 3 with onnxruntime-node 1.21, `dtype: q8`, greedy decoding, 4 intra-op threads, on an 8-vCPU AMD EPYC Linux VM (not a laptop). Five ja and de blocks: a 1-word UI label, a question, a 2-sentence chat line, a 2-sentence system message, a narrative sentence. Bergamot and Hy-MT2 were not run: there is no ONNX/JS path in this harness, and we didn't download them.
- **Results (ms per block):** Opus-MT mul-en 142–559 · M2M-100 418M 599–1986 · NLLB-600M 1502–2880, plus 7221 on one long ja sentence.
- **Caveats:** this is an untuned path. Even the 77M-parameter Opus model took ~0.4 s, so per-step overhead dominates. CTranslate2 or a hand-rolled ORT loop would be several times faster. Use the numbers for ranking only.
- **Output notes:** NLLB: `Einstellungen` → "The following is the list of the", `設定` → "Set it up.", and the second sentence was dropped in 2 of 3 multi-sentence blocks. M2M-418M kept both sentences ("What do you do? come quickly!"). These are known NLLB weak spots on very short or multi-sentence input. They argue for splitting blocks into sentences before translation, whichever model wins.

## Licence analysis

**CC-BY-NC-4.0 (NLLB-200 weights; also NLLB's `lid218e` and Tower-Plus, which is CC-BY-NC-SA).** The licence attaches to the *weights*, not to Glimpse's code, and doesn't "infect" it. What it restricts is *exercising the licensed rights*, which includes running and copying the model, "for commercial advantage or monetary compensation":

- **Glimpse developers:** writing code that loads NLLB is fine. Pointing users to Meta's HF download is fine. Re-hosting the weights, with attribution and for non-commercial purposes, is probably fine too, but it makes us a distributor, so don't. Sponsorships, paid builds or a commercial fork shipping NLLB would not be fine.
- **Glimpse users:** personal use (games, videos, chats with family, learning) is fine. **Using it at work or for paid work** (translating a supplier's PDF, a colleague's message, a client document) is very likely "primarily intended for commercial advantage", so it is outside the licence. That is the user's exposure, not ours, but making NLLB the default would quietly put every business user in breach. It also contradicts "free, use it anywhere", and we can't enforce or detect it. Hence: opt-in, labelled, never the default.
- Whether model weights can be copyrighted at all is unsettled. Don't rely on that.

**Permissive candidates:**

- **MPL-2.0 (Bergamot models and runtime).** Weak, file-level copyleft. Glimpse can bundle or download the models and the WASM runtime under any licence (MIT, Apache, GPL). Duties: keep the licence notice, and publish the source of any *modified* MPL files. Commercial use by anyone is fine. The training data is a mix of OPUS corpora. Mozilla ships these models in Firefox, which is reassuring but is not a guarantee about the data.
- **MIT (M2M-100, SMaLL-100) and Apache-2.0 (MADLAD-400, Hy-MT2, Opus-MT):** attribution and NOTICE only. Hy-MT2's README carries a Tencent trademark section: don't use Tencent marks beyond describing the model.
- **Hy-MT trap:** HY-MT1.5 and Hunyuan-MT-7B use the *Tencent HY Community License*, which "does not apply in the European Union, United Kingdom and South Korea" and forbids using the model *or its output* there. Pin downloads to `tencent/Hy-MT2-*` (Apache-2.0) and check the licence file hash at download time.
- **Gemma ToU (TranslateGemma):** commercial use is allowed, but the prohibited-use policy has to pass to end users and Google can update it. Avoid it as a default.

## Integration notes

- **Provider shape.** `translate(blocks[], src, tgt)` behind the existing pluggable provider interface. The Bergamot provider routes `src→tgt` directly when that model exists, otherwise `src→en→tgt`. When `src == en` or `tgt == en`, it's one hop. The router sends pairs Bergamot can't serve to the SMaLL-100 provider, and to Hy-MT2 when the user enables Enhanced.
- **Downloads.** In onboarding, after the user picks a target language, offer a *starter pack*: `en↔target` plus the top 5–8 source languages they choose (or a default set of ja, zh, ko, es, fr, de, ru), about 30 MB each, so ~200–400 MB in total, smaller than NLLB-600M alone. A block in a language with no installed pack shows an inline "Download Thai → English (31 MB)" action and never silently goes to the network. Model files are fetched from Mozilla's GCS registry or a GitHub-release mirror (MPL allows mirroring) and verified against the registry's SHA-256 (`uncompressedHash`).
- **Quantisation.** Bergamot ships int8 (intgemm) only, so there is nothing to tune. SMaLL-100 needs an Optimum ONNX export plus dynamic int8 that we produce ourselves (a CI job; publish the files with hashes). Hy-MT2: Q4_K_M GGUF, or a community or our own int4 ONNX. Skip the 1.25-bit build, which loses more quality.
- **Runtime path (Bun).** Bergamot: the WASM build in a Bun Worker. It needs SharedArrayBuffer/threads, plus the intgemm WASM module Firefox uses (`import-gemm-module.js`). SMaLL-100 / M2M: onnxruntime-node (N-API, already in the shell spike for PaddleOCR) with a hand-written greedy loop with KV cache, or transformers.js. **Rust fallback:** SMaLL-100/M2M through `ort` or `ct2rs` (CTranslate2). Bergamot through FFI to the C++ library, or CTranslate2's Marian converter if the original `.npz` checkpoints are available (*unverified*). Hy-MT2 through `llama-cpp-2`.
- **Preprocessing (any model).** Split blocks into sentences before translating (both NLLB and Opus dropped second sentences). Batch the changed blocks in each Live frame. Pass rule-1 "neutral" blocks from GLIM-21 through untouched. Cache by `(hash(normalised text), src, tgt, model)`, so repeated Live frames are free.
- **Language-ID mapping.** GLIM-21 emits FLORES codes. Add a FLORES→Bergamot map (`zho_Hant→zh_hant`, `srp_Cyrl→sr`, `hrv/bos→hbs` or per-language, `nob→nb`) and FLORES→M2M ISO codes.

## What this means for PRODUCT.md

- **"One quantised multilingual any-to-any model"** needs rewording to: *"Local translation via downloadable language packs (any-to-any; non-English pairs pivot through English). A long-tail multilingual model covers languages the packs don't."* The user-visible capability stays any-to-any. What goes is the single model. Pivot quality for pairs like `ja→zh` is lower than a direct model. Hy-MT2 Enhanced fixes that for its 33 languages.
- **"Fully usable offline after the first-run model download"** becomes *"…after downloading the language packs you need"*. Offline stays true, and no content ever leaves the machine. Meeting a new language while offline gives a clear "pack not installed" state, never a silent cloud fall-through.
- **"Every language is first-class" / "every major script"**: Bergamot + SMaLL-100 cover roughly 100 languages. The ~100 additional NLLB-only languages (many African and Pacific languages, Arabic dialects) are only reachable through the NC opt-in. GLIM-21 already can't detect most of them, so the gap lines up.
- Settle the **app's own licence** (no LICENSE file yet) before release. Any permissive or MPL-compatible choice works with this recommendation.

## Risks

- **Bergamot runtime integration is the big unknown.** There is no ONNX. The WASM build is maintained inside the `mozilla/translations` repo for Firefox, npm packages are community forks, and threaded WASM plus intgemm under Bun is unproven. Add it to the shell spike. If it fails, the fallback is SMaLL-100/M2M via ORT (lower quality) or a native C++ sidecar.
- **Pivot quality and latency.** Two hops compound errors (names, formality, pronoun dropping in ja/ko/zh), and latency doubles. No published pivot scores for these models are known.
- **Coverage is Mozilla's roadmap.** 59 languages today. Languages are added over time but can't be guaranteed.
- **Short and informal text.** Every model here is sentence-trained. Bergamot has no published short-text or UI-string evaluation. Game slang and chat will be the weakest area.
- **Latency is unmeasured for the recommended default.** Our smoke test measured only ONNX models through an untuned path. The 1.5 s Snip budget has to be confirmed on a real mid-range laptop for Bergamot (expected to pass easily) and Hy-MT2 (borderline).
- **Hy-MT2 is an LLM.** It may add explanations, follow instructions embedded in on-screen text (prompt injection from screen content), or drift on long Live sessions. Use a strict prompt, delimiters and output validation. It also needs ~1.5–2 GB RAM next to OCR.
- **Licence drift.** Tencent has changed licences between releases. Pin versions and store the licence hash with each model.

## Open questions

1. Does the Bergamot WASM build run in a Bun Worker (threads, intgemm), and what are the per-block latency and RSS on a mid-range Windows and macOS laptop? Is the native C++ build an easier sidecar?
2. Starter pack: which default source set, and should it download automatically or only after the user confirms each pack?
3. Ship Hy-MT2 Enhanced in v1, or after a latency and prompt-injection check? Which runtime: llama.cpp or ONNX int4?
4. SMaLL-100 or M2M-100 418M for the long tail? SMaLL-100 is better and smaller but needs our own export and a custom tokenizer.
5. Ship the NC NLLB opt-in at all? If yes, which notice wording, and should the licence acknowledgement be recorded locally?
6. Build a small real-OCR test set (UI labels, game dialogue, subtitles, chat; ja, ko, zh, es, de, ru, ar) and score Bergamot (direct and pivot), SMaLL-100 and Hy-MT2 Q4 with chrF++ and COMET before sign-off.

## Sources

1. Mozilla translations, licence statement and model registry (59 languages, sizes, FLORES+ metrics): https://github.com/mozilla/translations · registry JSON (generated 2026-10-29): https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json · dashboards: https://mozilla.github.io/translations/model-registry/ · old models repo (archived, MPL-2.0): https://github.com/mozilla/firefox-translations-models · runtime: https://github.com/browsermt/bergamot-translator
2. NLLB licences ("All models are licensed under CC-BY-NC 4.0"; code MIT): https://github.com/facebookresearch/fairseq/blob/nllb/README.md · https://huggingface.co/facebook/nllb-200-distilled-600M
3. NLLB per-direction chrF++ metrics (averaged by us): https://dl.fbaipublicfiles.com/large_objects/nllb/models/nllb_200_dense_distill_600m/metrics.csv, …/nllb_200_dense_distill_1b/metrics.csv, …/nllb_200_moe_54b/metrics.csv · NLLB paper: https://arxiv.org/abs/2207.04672
4. MADLAD-400 3B model card (Apache-2.0, 419 languages, GGUF 1.65 GB): https://huggingface.co/google/madlad400-3b-mt · ONNX (community): https://huggingface.co/Kutalia/madlad400-3b-mt-onnx
5. MADLAD-400 paper, Table 5 (Flores-200) and Table 4 (WMT): https://arxiv.org/abs/2309.04662
6. SMaLL-100 paper (FLORES-101 spBLEU vs M2M-100): https://arxiv.org/abs/2210.11621 · model (MIT): https://huggingface.co/alirezamsh/small100 · M2M-100 (MIT): https://huggingface.co/facebook/m2m100_418M, https://huggingface.co/facebook/m2m100_1.2B
7. Hy-MT2-1.8B (Apache-2.0 LICENSE.txt, 33 languages, GGUF sizes): https://huggingface.co/tencent/Hy-MT2-1.8B, https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF · community ONNX: https://huggingface.co/ModaLeap/hy-mt2-1.8b-onnx · HY-MT1.5 licence (excludes EU/UK/KR): https://huggingface.co/tencent/HY-MT1.5-1.8B/blob/main/License.txt
8. Hy-MT2 technical report, Tables 2 and 5 (FLORES-200 XCOMET, quantisation): https://arxiv.org/abs/2605.22064
9. TranslateGemma 4B (Gemma ToU, 55 languages, WMT24++): https://huggingface.co/google/translategemma-4b-it · report: https://arxiv.org/abs/2601.09012
10. ONNX exports used in the smoke test: https://huggingface.co/Xenova/nllb-200-distilled-600M, https://huggingface.co/Xenova/m2m100_418M, https://huggingface.co/Xenova/opus-mt-mul-en
11. CTranslate2 (MIT; supports NLLB, M2M-100, Marian, T5/MADLAD; CPU int8 benchmarks): https://github.com/OpenNMT/CTranslate2 · Opus-MT: https://github.com/Helsinki-NLP/Opus-MT
12. CC-BY-NC-4.0 legal code ("NonCommercial" definition): https://creativecommons.org/licenses/by-nc/4.0/legalcode
