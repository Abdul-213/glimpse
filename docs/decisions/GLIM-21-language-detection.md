# GLIM-21: Decision on per-block language detection

Status: **Accepted for now** (2026-10-30; revisit after real OCR calibration) · Proposed: 2026-10-25 · Scope: Windows + macOS, Bun/TypeScript first, Rust fallback

## Recommendation

**Primary (Bun/TS): a three-step detector, all in-process with no native code.**

1. **Rule pre-filter.** Blocks with no real language (numbers, symbols, `OK`-style tokens) are marked *neutral* and shown as-is. See the rule section below.
2. **Unicode script pass.** Count letters per script with `\p{Script=…}` regexes. Where the script settles the question it decides alone: Hangul gives Korean, any kana gives Japanese, Thai gives Thai, and a script with no language in the user's subset means skip.
3. **[ELD](https://github.com/nitotm/efficient-language-detector-js)** (Efficient Language Detector, pure JS, Apache-2.0, 60 languages, "medium" database) handles blocks the script pass can't settle. If the user's subset contains a language ELD lacks, the detector switches to **fastText `lid.176.ftz`** (176 languages, 0.9 MB) through the WASM build `fasttext.wasm.js`. That switch is what widens coverage.

**Fallback for the Rust sidecar or Tauri stacks:** [lingua-rs](https://github.com/pemistahl/lingua-rs) (Apache-2.0, 75 languages, best published short-text accuracy), built natively with only the needed language features. Script detection and coverage work the same way as in the primary. For the long tail, use the pure-Rust `fasttext` crate (whether it loads `.ftz` is not verified) or `whatlang` for script detection.

Why:

1. **Most accurate on short and noisy blocks among the JS options, and fast.** In our smoke test (below), ELD got 95% on blocks of 20 characters or fewer and 91% on OCR-noised Latin text. fastText got 85% / 85%, lingua 93% / 76%, CLD3 78% / 56%. ELD took about 0.04 ms per block in Bun 1.4, so Live mode's budget is irrelevant to it.
2. **Fits the stack with no native bindings.** ELD is plain ESM and fastText runs as WASM. Both ran unmodified in Bun 1.4.4. No N-API, no node-gyp, nothing to sign or rebuild for each OS or architecture. Code and data licences are permissive (Apache-2.0; the fastText model is CC-BY-SA-3.0 and only needs attribution when shipped unmodified).
3. **The script pass does most of the work and fixes the detectors' worst failures.** CJK, Korean, Thai, Greek, Indic and similar scripts are decided with certainty. fastText labelled short Chinese UI strings as English or Japanese (`按任意键继续` became `en` at p=1.00), and the script pass removes that whole class of error. It also makes "is this block in my subset?" a cheap, reliable question for every block not written in Latin, Cyrillic or Arabic script.

What we're *not* recommending:

- **Large FLORES-200-native models** (GlotLID, OpenLID, NLLB's own `lid218e`) as the default. They are 1.2–1.7 GB, trained on sentences, and their authors warn against very short input. `lid218e` is also licensed CC-BY-NC.
- **MediaPipe** at this stage. It is browser-only, and its short-text accuracy is unpublished.
- **CLD3, franc and tinyld.** They are less accurate on short text, unmaintained, or both.

## Comparison

Published-benchmark columns are cited inline. "Smoke" columns are our own test (method below) and are **indicative only**.

| Candidate | Langs | Short-text evidence | Smoke: ≤20 chars / noisy Latin | Size on disk · RSS (Bun) · latency | Runs in our stack | Licence (code · model/data) | Maintenance |
|---|---|---|---|---|---|---|---|
| **ELD** 2.1.0 (JS) | 60 | Author's benchmark covers single words, word pairs and tweets, and shows ELD ahead of CLD2/CLD3/franc, but only as images. fasttext.wasm.js's benchmark puts it below fastText on sentence-length text (0.94 vs 0.98 on papluca). [1][9] | **95% / 91%** (large), 91% / 90% (medium) | 0.9–4.3 MB DB · +70 MB (XS) / +104 MB (M) / +212 MB (L) · ~0.04 ms | Pure JS/ESM, works in Bun. Has `setLanguageSubset`. No Rust port. | Apache-2.0 · DB in the same repo, no separate data licence stated (*unverified*) | Active (pushed Aug 2026) |
| **fastText lid.176.ftz** via `fasttext.wasm.js` | 176 | Generally rated weak on very short text (secondary sources). WiLI overall: 83.1% for ftz vs 74.7% for CLD3. DIVERS-Bench TweetLID F1 71.1. [2][10][11] | 85% / 85% | 0.9 MB model + ~1 MB wasm · +44 MB · ~0.09 ms | WASM, works in Bun. Rust: pure-Rust `fasttext` 0.8 crate (*`.ftz` support unverified*) | Wrapper MIT, fastText MIT · **model CC-BY-SA-3.0** | fastText repo archived (Mar 2024). Wrapper inactive since Sep 2024 but small. |
| **lingua** 1.8 (Rust; Python; community WASM `@zkorum/lingua-wasm`) | 75 | Best published short-text numbers. Mean accuracy on single words / word pairs / sentences: high mode 74 / 89 / 96, low mode 64 / 82 / 94, CLD3 48 / 67 / 93, CLD2 34 / 68 / 94. [3] | 93% / **76%** | WASM is 288 MB · **+620–880 MB** (WASM embeds every model, even when built for 6 languages) · ~1.6 ms. Native Rust: "a few dozen MB" (vendor claim) | Native Rust is best. The WASM build is too heavy for us. npm `@valentech/lingua-js` (Neon native build, 2023) is stale. | Apache-2.0 · models trained on Leipzig Wortschatz corpora (*data terms unverified*) | Active (pushed Oct 2026) |
| **whatlang** 0.18 (Rust) | 70 | 57 / 72 / 95 on lingua's single-word / word-pair / sentence sets (measured on its own supported subset). [3] | not run | Tiny, trigram-based, in the binary | Rust only (WASM possible). Includes `detect_script`. | MIT · bundled | Active (Dec 2025) |
| **CLD3** (`cld3-asm`) | 107 | 48 / 67 / 93 (lingua sets). DIVERS-Bench average 48.2. PALI (noisy Perso-Arabic) F1 mostly below 0.15. [3][11][12] | 78% / 56% | ~6.6 MB pkg · ~0.18 ms (Node) | WASM | Apache-2.0 / MIT wrapper | **Archived** (Jun 2024); wrapper last published 2023 |
| **CLD2** (`cld` npm, `cld2` crate) | 83 (160 extended) | 34 / 68 / 94 (lingua sets). node-cld reaches about 95% only around 48 characters. [3][5] | not run | >10 MB · fast | **Native C++ addon** (node-gyp; Bun N-API compatibility *unverified*). Rust crate last released 2017. | Apache-2.0 | Dormant (last push 2021) |
| **tinyld** 1.3 (JS) | 64 | Author says about 95% accuracy from roughly 24 characters on 16 languages. [5] | 74% / 68% | 0.6–2 MB · ~0.17 ms | Pure JS | MIT | Dormant (2023) |
| **franc** 6.2 (JS) | 82 / 187 / 414 | Author says it is "easily confused on small samples". 74% in tinyld's benchmark. DIVERS-Bench TweetLID F1 30.5. [4][5][11] | 62% / 44% | 0.1–0.5 MB | Pure JS. Outputs ISO 639-3. | MIT · UDHR-derived | Low activity |
| **MediaPipe Language Detector** | 110 | Only Wikinews F1 0.978 is published (model card). No short-text data. [6] | **could not run** in Bun | 315 KB tflite + wasm · 90 µs on Pixel 2 | Browser WASM (`@mediapipe/tasks-text`). Needs `document` and script loading. A shimmed Bun run hung. Would have to run in the webview. | Apache-2.0 (model card) | Active |
| **GlotLID v3** (fastText) | ~2,100 labels, FLORES-style `eng_Latn` | README: "avoid using it on very short sentences". DIVERS-Bench best average (77.8), TweetLID 71.8. [7][11] | not run (1.7 GB) | **1.69 GB** | fastText (WASM would need the full model in memory) | Apache-2.0 "plus notices" | Active |
| **OpenLID-v2** / **heliport** | ~200 / 220 | OpenLID: FLORES F1 0.927. Neither publishes short-text results. [8][13] | not run | ~1 GB+ / Rust binary | fastText / Rust crate | **GPL-3.0** (both; OpenLID-v2 licence per its HF card, *not checked against primary repo*) | Active |
| **NLLB `lid218e`** | 217, FLORES codes | n/a | not run | ~1.2 GB | fastText | **CC-BY-NC-4.0** (*per mirrors; official card not checked*). Not acceptable. | n/a |

**Coverage against NLLB.** The FLORES-200 list has 204 language-script codes, which is about 196 languages. Matching by ISO 639-3 and macrolanguage (approximate; Arabic dialects counted as uncovered):

| Approach | FLORES languages covered |
|---|---|
| ELD alone | ~61 |
| ELD + script-unique languages | ~64 |
| fastText lid.176 + script pass | ~115 |

About 80 NLLB languages are covered by none of these. They include Hausa, Igbo, Ewe, Twi, Fon, Zulu, Xhosa, Kinyarwanda, Lingala, Wolof, Tigrinya, Maori, Samoan, Faroese, Dari and the Arabic dialects (acm, apc, ars, ary, aeb…). Only GlotLID/OpenLID-class models cover them.

### Smoke test (ours, indicative)

- **Data:** 128 hand-written blocks in 16 languages: UI labels, game/quest strings, chat with slang, subtitle-like questions. 86 of them are 20 characters or fewer. A further 80 Latin-script variants have simulated OCR noise (`l→1`, `m→rn`, `o→0`, `e→c`, diacritics stripped, a stray `|`). 16 junk blocks (`OK`, `100%`, `F5`, `USB-C`, `@alice`…).
- **Setup:** Bun 1.4.4 and Node 24 on Linux x64. "Membership" means "is the block in subset {es, pt, it, fr}?", measured over all 208 blocks.
- **Caveats:** one author wrote both the set and the noise model; n is small; macOS and Windows were not measured.

| Detector | Clean (128) | ≤20 chars (86) | Noisy Latin (80) | Membership (208) | ms/block | RSS Δ |
|---|---|---|---|---|---|---|
| ELD large | 96% | 95% | 91% | 205 | 0.05 | 212 MB |
| ELD medium | 93% | 91% | 90% | n/a | 0.04 | 104 MB |
| ELD small | 92% | 90% | 89% | n/a | 0.03 | 89 MB |
| lingua high (WASM, all 75) | 95% | 93% | 76% | 200 | 1.57 | ~620 MB |
| lingua low | 88% | 86% | 61% | 184 | 0.96 | ~620 MB |
| fastText lid.176.ftz | 88% | 85% | 85% | 203 | 0.09 | 44 MB |
| CLD3 (cld3-asm, Node) | 76% | 78% | 56% | n/a | 0.18 | n/a |
| tinyld (Node) | 83% | 74% | 68% | n/a | 0.17 | n/a |
| franc (Node) | 65% | 62% | 44% | n/a | 0.25 | n/a |

What the smoke test showed:

- **Every detector assigns a language to junk**, sometimes with high confidence: CLD3 gave `F5` → Maltese at 1.00, and ELD gave `OK` → Polish at 0.78. Confidence thresholds alone can't catch this, so the rule pre-filter is required.
- **Membership is easier than exact identification.** Confusions inside the subset (pt↔it, ru↔uk) don't change the translate/skip decision.
- **Don't restrict the detector to the subset to decide membership.** `setLanguageSubset` (ELD) or lingua's `fromLanguages` would force every block into a subset language. Detect over the full set and test membership. Restriction is only useful afterwards, to choose *which* subset language a translated block is in.

## Short and low-confidence block rule

Detection runs on a **detection copy** of the text: NFKC normalised, with URLs, e-mail addresses, `@handles`, `#tags`, digits, units, punctuation and emoji stripped. `letters` is the count of remaining letters. Hiragana, katakana and Han characters count ×3 each, so a 2-character Japanese word isn't treated as "short".

| # | Condition | Outcome |
|---|---|---|
| 1 | `letters < 2`, or the whole block is a known token (`OK`, `Esc`, `F1`–`F12`, `Lv.`, `HP`, version strings…) | **Neutral.** Show it as-is in place. Never send it to NLLB. Never count it in "N skipped". |
| 2 | The dominant script (≥ 70% of letters) is used by **no** language in the subset | **Skip** (certain). |
| 3 | The script maps to exactly one NLLB language (Hangul, kana, Thai, Lao, Khmer, Greek, Georgian, Armenian, Sinhala, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Odia, Ol Chiki) | That language. Translate if it is in the subset, otherwise skip. |
| 4 | Ambiguous script (Latin, Cyrillic, Arabic, Devanagari, Bengali, Han-only, Hebrew, Ethiopic, Myanmar, Tibetan, Tifinagh) and `letters ≥ 8` and detector confident (ELD `isReliable()` and top score ≥ τ; fastText p ≥ τ; starting τ = 0.5, **to be calibrated**) | Top-1 language. Translate if it is in the subset, otherwise skip. |
| 4w | As rule 4, but the block is short (`letters < 24`), the capture has a **script prior** for its script (below), and the block scores the prior's language within 0.01 of its own top-1 (GLIM-140) | The prior's language. Confident, like rule 4. |
| 5 | Otherwise **uncertain** (short or low confidence). Apply in order: | |
| 5a | Live mode, and the same normalised text was decided before | Reuse the cached decision (also stops flicker). |
| 5b | Other blocks in the same capture were decided confidently, and their majority language is plausible for this block's script; otherwise the capture has a script prior for this block's script | Inherit that language. |
| 5c | Otherwise | **Translate** if any subset language uses this script *and* is in the detector's top 3. Otherwise **skip**. |
| * | Decided language equals the target language | Don't translate. Show the original. |

**Script prior (GLIM-140).** For each ambiguous script that two or more blocks of a capture are written in (OCR confidence above the rule 4 floor, rule 1 tokens excluded), the detector runs once more over those blocks' detection copies joined with spaces. If that result is reliable and its top-1 (consistent with the script) scores ≥ τ, it is the capture's prior for the script. Why: short menu and button labels in closely related languages are near-ties. The GLIM-64 benchmark's Bulgarian menu had "Нов прозорец" at ru 0.842 / bg 0.836 / sr 0.831 and "Последни документи" at sr 0.840 / bg 0.836 in ELD, so rule 4 picked ru and sr (sr is outside the subset, so the item was skipped). The joined menu reads as bg. The window is almost always in one language, so a narrow lead on a short item is weaker evidence than the window. A clear lead (a Russian sentence leads bg by 0.026) or a long block keeps its own top-1, and a prior the block doesn't list among its candidates never applies. The 0.01 margin is on ELD's score scale and must be recalibrated for another detector. In Live only the changed blocks feed the prior.

Why rule 5c leans towards translating:

- A false skip hides content the user asked for behind an expander.
- A false translate costs a few ms of NLLB time on a short string and is visible, so the user can correct it.
- Junk, the case where translation makes things worse, has already been removed by rule 1.

When the user has **no subset** ("translate everything"), detection is only used to choose NLLB's `src_lang`. Rules 1, 3, 4 and 5a–b apply, and uncertain blocks fall back to the capture's majority language, then to the detector's top-1.

## Integration

```
capture → diff/debounce → PaddleOCR (ONNX) → blocks {text, bbox, ocrConf}
  → LID stage (same Bun worker that orchestrates; synchronous, ~0.05 ms/block)
      normalise → rule 1 → script pass (rules 2–3) → ELD or fastText (rule 4) → rule 5
      → {class: translate | skip | neutral, iso, flores, conf, reason}
  → cache keyed by hash(normalised text) → only translate-class blocks go to NLLB with src_lang=flores
  → popup: translated blocks in place, neutral blocks as-is, "N blocks skipped" expander (showing detected language names)
```

- **Live mode.** Only changed blocks are re-detected, and the text-hash cache makes repeat frames free. Add **hysteresis**: a block keeps its previous language unless a new detection is confident and different. This stops language flicker as subtitles scroll.
- **Low OCR confidence** (PaddleOCR rec score below a threshold) moves a block straight to rule 5, even when it is long.
- **Detector choice is made when the subset changes, not per block.** If every subset language is covered by ELD or the script table, use ELD. Otherwise load fastText (0.9 MB, about 44 MB RSS).
- **Mapping to NLLB (FLORES-200 codes).** A static table maps ISO 639-1 to FLORES. Most entries are plain, such as `de→deu_Latn`. These ones need care:

| ISO | FLORES code(s) | Notes |
|---|---|---|
| `zh` | `zho_Hans` / `zho_Hant` | Choose by a simplified-vs-traditional character check. `yue_Hant` (Cantonese) is only reachable through fastText (`yue`). |
| `ar` | `arb_Arab` | NLLB's dialect codes (ary, arz, apc…) are not detectable, so default to MSA. |
| `fa` | `pes_Arab` | Dari is `prs_Arab`. |
| `ms` | `zsm_Latn` | ELD has no Indonesian, so `ind_Latn` needs fastText. |
| `no` | `nob_Latn` | Nynorsk is `nno_Latn`. |
| `lv` | `lvs_Latn` | |
| `sq` | `als_Latn` | |
| `az` | `azj_Latn` | `azb_Arab` if the script is Arabic. |
| `ku` | `kmr_Latn` / `ckb_Arab` | Choose by script. |
| `sr` | `srp_Cyrl` | NLLB has Cyrillic Serbian only. Latin-script Serbian must be transliterated or treated as `hrv_Latn`/`bos_Latn`. |
| `tl` | `tgl_Latn` | |
| `or` | `ory_Orya` | |
| `pa` | `pan_Guru` | |

Equivalent codes for fastText's extras: `sw→swh_Latn`, `uz→uzn_Latn`, `mn→khk_Cyrl`, `ps→pbt_Arab`, `ne→npi_Deva`, `mg→plt_Latn`, `yi→ydd_Hebr`, `qu→quy_Latn`, `id→ind_Latn`.

- **UI.** The source-language picker shows every NLLB language. Languages that can't be detected, beyond ELD, fastText and the script table, get a "can't be detected reliably" note. If one of them is in the subset, blocks in its script follow rule 5c.

## Risks

- **Coverage gap against "every language is first-class".** Roughly 80 NLLB languages, mostly African, Pacific and Arabic dialects, can't be detected by anything small. If a user picks one, filtering is approximate.
- **Short Latin-script blocks stay hard.** Even the best option is wrong on about 1 in 20 blocks of 20 characters or fewer, and closely related pairs (es/gl/ca, pt/gl, cs/sk, da/no/sv, ru/uk/be, ms/id, hr/sr/bs) are worst. CHALIS (2026) shows that all common detectors struggle with these pairs. [14]
- **ELD memory.** RSS is +104 MB for the medium database, more than its README suggests (71 MB), and measured in Bun on Linux only. It also has a small user base (127 stars) and a single maintainer.
- **fastText licence.** CC-BY-SA-3.0 on the model needs attribution in the About/NOTICE file. ShareAlike would apply if we fine-tuned or modified the model. Not legal advice; get a quick check before release. The upstream fastText repo is archived, so the WASM build is effectively frozen. That is fine for inference.
- **Smoke-test bias.** The author's own set, small n, synthetic noise. Real OCR errors (merged words, wrong diacritics, confusables across scripts such as Latin `a` vs Cyrillic `а`) are not covered. Cross-script confusables also distort the script pass, so map common Latin/Cyrillic homoglyphs before counting scripts.
- **Out of scope but adjacent:** the NLLB-200 weights themselves are licensed CC-BY-NC-4.0, which matters for the translation-model decision.

## Open questions

1. **Calibration.** Build a test set of about 1–2k real OCR'd blocks (UI, chat, games, subtitles) across the top 20 subset languages, then set τ, the `letters` cut-off and the script-dominance ratio from it. ELD's score scale is undocumented.
2. **ELD database size:** medium (+104 MB, 91% short-text accuracy) or small (+89 MB, 90%)?
3. **Long-tail add-on:** offer GlotLID (1.7 GB, Apache-2.0) as an optional download for users who select uncovered languages, or accept approximate filtering?
4. Should target-language blocks count towards "N skipped", or show as-is? We recommend as-is.
5. Does ELD's `isReliable()` behave usefully on blocks of 20 characters or fewer, and is its noisy-text lead real at scale?
6. For the Rust fallback, confirm lingua's native memory with lazy loading of about 10–20 languages, and whether the pure-Rust `fasttext` crate loads quantised `.ftz`.

## Sources

1. ELD (JS), README, sizes and RAM: https://github.com/nitotm/efficient-language-detector-js
2. fastText language identification (176 languages, sizes, CC-BY-SA-3.0): https://fasttext.cc/docs/en/language-identification.html · WASM build and papluca benchmark: https://github.com/yunsii/fasttext.wasm.js
3. Lingua accuracy tables (means for single words, word pairs, sentences): https://github.com/pemistahl/lingua-py/tree/main/tables, https://github.com/pemistahl/lingua-rs/tree/main/tables · README (75 languages, speed, memory, WASM): https://github.com/pemistahl/lingua-rs · WASM build: https://www.npmjs.com/package/@zkorum/lingua-wasm
4. franc: https://github.com/wooorm/franc
5. tinyld benchmark (includes node-cld and franc): https://github.com/komodojp/tinyld/blob/develop/docs/benchmark.md
6. MediaPipe Language Detector: https://developers.google.com/edge/mediapipe/solutions/text/language_detector · model card (110 languages, Apache-2.0, F1 0.978): https://storage.googleapis.com/mediapipe-assets/LanguageDetector%20Model%20Card.pdf
7. GlotLID: https://github.com/cisnlp/GlotLID · model files and licence: https://huggingface.co/cis-lmu/glotlid
8. OpenLID paper: https://arxiv.org/abs/2305.13820 · OpenLID-v2 card (GPL-3.0): https://huggingface.co/laurievb/OpenLID-v2
9. CLD3 (archived): https://github.com/google/cld3 · CLD2: https://github.com/CLD2Owners/cld2 · whatlang: https://github.com/greyblake/whatlang-rs
10. fastText vs CLD3 on WiLI (R vignette): https://cran.r-project.org/web/packages/fastText/vignettes/language_identification.html
11. DIVERS-Bench (TweetLID and other domains): https://arxiv.org/abs/2509.17768
12. PALI, noisy Perso-Arabic LID: https://arxiv.org/abs/2304.01322
13. heliport (GPL-3.0): https://github.com/ZJaume/heliport
14. CHALIS, related languages and orthographic noise: https://arxiv.org/abs/2606.06088 · OpenLID-v3 (noise label): https://arxiv.org/abs/2602.13139
15. FLORES-200 language list: https://github.com/facebookresearch/flores/blob/main/flores200/README.md
16. Crates: https://crates.io/crates/lingua, https://crates.io/crates/whatlang, https://crates.io/crates/fasttext
