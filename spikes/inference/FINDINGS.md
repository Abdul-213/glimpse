# GLIM-17 findings: OCR (PP-OCRv5 on ONNX Runtime) and translation (Bergamot WASM) from Bun

Date: 2026-11-01 · Measured on Linux only (headless dev VM). Windows and macOS numbers still need to be run (see TESTING.md, tracked under GLIM-87).

## Verdict

**Run inference inside the Bun process. We don't need a sidecar.** OCR runs on `onnxruntime-node` 1.31.1 (N-API), which works unmodified under Bun 1.4.4. Translation runs on Firefox's own `bergamot-translator.wasm` (v0.6.0), loaded inside a **Bun Worker**. Both produced correct output on every sample. On this VM a warm Snip (600x200 region, OCR + ja→en) takes **~0.6 s**, inside the 1.5 s budget. Live re-OCR of a small region takes **~0.3 s**, which misses "well under 300 ms" unless only changed lines are re-recognised (GLIM-88).

The GLIM-26 "Revisit if GLIM-17 fails" clause does not trigger, with one caveat for **Intel Macs**: onnxruntime-node ≥ 1.24 ships no darwin-x64 binary (GLIM-89, see Risks).

## Runtimes and versions

| Piece | Package / artifact | Version | Works under Bun 1.4.4 | Notes |
|---|---|---|---|---|
| OCR runtime (primary) | `onnxruntime-node` (MIT) | 1.31.1 | Yes, first try | Prebuilt N-API binaries in the npm tarball for win32-x64, win32-arm64, darwin-arm64, linux-x64/arm64. **No darwin-x64** (dropped after 1.23.2). Bun blocks its postinstall by default, which is harmless: the postinstall only fetches CUDA EPs. `session.run` is async on ORT's own thread pool, so it doesn't block the JS event loop. |
| OCR runtime (fallback) | `onnxruntime-web` (MIT), WASM EP | 1.31.1 | Yes | Threads work under Bun (1→4 threads: 1.57 s → 0.68 s on the region). It is **~2x slower than node** and uses more memory. Only use it where node has no binary (Intel Mac). Model must be passed as bytes, not a path. |
| Translation runtime | Firefox `bergamot-translator.wasm` + matching JS glue (MPL-2.0) | v0.6.0+eea6e5a8 (Remote Settings `translations-wasm-v2` record 4.0) | Yes, main thread or Worker | **Single-threaded build**: no SharedArrayBuffer, pthreads or COOP/COEP needed. Outside Firefox there is no `WebAssembly.mozIntGemm`, so the glue uses the WASM's built-in fallback gemm. The glue must match the WASM byte for byte; we pin it by SHA-256 (it is identical to firefox `main` today). |
| npm Bergamot | `@browsermt/bergamot-translator` | 0.4.9 (2022-10) | not used | Stale; predates the 3.x model packs. Don't use. `@molecule/api-ai-translation-bergamot` (Apache-2.0, 2026-10) takes the same approach as this spike and was a useful reference. |
| Fallback MT | `onnxruntime-node` + `@huggingface/tokenizers` 0.2.0 + hand-written greedy KV-cache loop | — | Yes | M2M-100 418M int8 (Xenova export). |
| PNG decode / sample rendering (dev only) | `pngjs` 7, `@napi-rs/canvas` 1.1 (devDependency, Skia+HarfBuzz) | — | Yes | The app gets raw BGRA from capture, so it needs no PNG decoder at runtime. |

## Models: sources, licences, sizes, versioning

### OCR: PP-OCRv5 mobile (Apache-2.0)

Upstream weights are PaddlePaddle's (Apache-2.0; HF `PaddlePaddle/PP-OCRv5_mobile_det`, `.../*_PP-OCRv5_mobile_rec`, in Paddle format only, **no official ONNX**). The ONNX conversions we used are **RapidOCR's** (Apache-2.0), pinned with SHA-256 in RapidOCR's `python/rapidocr/default_models.yaml` (github.com/RapidAI/RapidOCR) and hosted on ModelScope:
`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/{det,rec}/<name>.onnx`, with dicts at `.../resolve/v3.10.0/paddle/PP-OCRv5/rec/<model>/<dict>.txt`. All URLs and hashes are in `scripts/fetch-models.ts`.

| Model | File | Size | Covers |
|---|---|---|---|
| Detector (all scripts) | `ch_PP-OCRv5_det_mobile.onnx` | 4.8 MB | language-agnostic DB detector |
| Rec "ch" | `ch_PP-OCRv5_rec_mobile.onnx` + `ppocrv5_dict.txt` (18,383 chars) | 16.6 MB | Simplified + Traditional Chinese, **Japanese** (kana + kanji), English |
| Rec Korean | `korean_PP-OCRv5_rec_mobile.onnx` | 13.5 MB | Hangul + Latin |
| Rec Latin | `latin_PP-OCRv5_rec_mobile.onnx` | 7.9 MB | de/fr/es/pt/it/... diacritics |
| Rec English | `en_PP-OCRv5_rec_mobile.onnx` | 7.9 MB | English only (fastest) |
| Rec East Slavic / Cyrillic | `eslav_…` / `cyrillic_…` | 7.9 / 8.1 MB | ru/uk/be (eslav); wider Cyrillic set |
| Rec Arabic | `arabic_PP-OCRv5_rec_mobile.onnx` | 8.0 MB | ar/fa/ur. **Emits visual order**: reverse to logical (`visualToLogicalRtl`) |
| Rec Devanagari | `devanagari_…` | 7.9 MB | hi/mr/ne |
| Rec Thai | `th_…` | 7.9 MB | th |
| Rec Greek (bonus) | `el_…` | 7.8 MB | el |

RapidOCR also has Tamil and Telugu v5 rec, and server variants (det 84 MB, rec 81 MB) that we did not test. The rec exports already apply softmax, and their output class count = dict + 2 (blank first, space last).

### Translation: Firefox Translations / Bergamot (MPL-2.0, models and runtime)

Firefox's production channel is **Mozilla Remote Settings**, and Glimpse should use it too (GLIM-38):

- Records: `https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records` (404 records, 115 directions today; 59 languages, all to and from English).
- Runtime: `.../collections/translations-wasm-v2/records` (`name: "bergamot-translator"`, `release: v0.6.0`, `version: 4.0`).
- Attachments: `https://firefox-settings-attachments.cdn.mozilla.net/<attachment.location>`. Files are **zstd-compressed** (`.zst`). `attachment.hash` is the SHA-256 of the `.zst` and `decompressedHash` is the SHA-256 of the unpacked file. Bun has `Bun.zstdDecompressSync`.
- One record per file. Fields: `sourceLanguage`, `targetLanguage`, `fileType` (`model` | `lex` | `vocab`, or `srcvocab` + `trgvocab` for CJK targets), `version` (`3.0`, `3.1`; pre-releases look like `3.0a1`), `architecture` (`tiny` | `base` | `base-memory`), `filter_expression` (Firefox targeting: `''` = everyone, `env.appinfo.OS != 'Android'` = desktop, `env.appinfo.OS == 'Android'` = Android, `env.channel == 'nightly'…` = pre-release).
- **Choosing a pack (desktop)**: filter by `filter_expression ∈ {'', "env.appinfo.OS != 'Android'"}`, drop pre-release versions (`/a\d*$/`), take the highest `version` for the pair, then take all files at that version. This picks the larger **`base`** models for ja→en and zh-Hans→en (Android gets `base-memory`).
- The older `translations-models` (v1, uncompressed, versions 1.x/2.x) collection still exists. Ignore it.
- Other mirrors: the `mozilla/translations` GCS registry (`https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json`) and the archived `mozilla/firefox-translations-models` repo. Remote Settings is what ships, so use that.
- Language codes are BCP-47-ish: `zh-Hans`, `zh-Hant`, `nb`, `nn` (source only), `sr`, `ug`, etc.

| Pack (desktop, v3.0) | Unpacked size | Download (.zst) | Files |
|---|---|---|---|
| ja→en (`base`) | 70.3 MB | 45.9 MB | model 59.5 MB, lex 9.3 MB, vocab 1.4 MB |
| zh-Hans→en (`base`) | 70.1 MB | 47.6 MB | model 59.5 MB, lex 9.2 MB, vocab 1.4 MB |
| de→en (`base-memory`) | 37.3 MB | 23.9 MB | model 31.6 MB, lex 4.9 MB, vocab 0.8 MB |
| en→de (`base-memory`) | 36.7 MB | 24.6 MB | model 31.6 MB, lex 4.3 MB, vocab 0.8 MB |
| runtime wasm | 4.96 MB | 1.2 MB | + 100 KB JS glue |

The packs are larger than GLIM-85's "17–44 MB" figure because the CJK→en desktop packs are now `base` models.

### Fallback: M2M-100 418M (MIT)

`https://huggingface.co/Xenova/m2m100_418M` int8: encoder 288 MB + merged decoder 344 MB + tokenizer 8 MB (632 MB). It works from Bun on onnxruntime-node with our own greedy loop (`src/m2m.ts`): `明日の会議は午後三時に始まります。` → "Tomorrow's meeting begins at 3 a.m." (wrong: 午後 means p.m.). Load 6.9 s, **1.8–3.5 s per sentence**, peak RSS 1.9 GB. That proves the path works, but it is too slow for anything but a long-tail Snip. SMaLL-100 was not tried; it needs its own export and tokenizer (GLIM-85 open question 4).

## Measurements (this machine)

**Machine:** KVM guest, "AMD EPYC Processor (with IBPB)", **8 vCPU** (1 thread/core), AVX2 (no AVX-512), ~2.8 GHz, 23 GB RAM, Linux 6.8, Bun 1.4.4. **The VM was shared with other agents** (load average 2–6 during the runs), so p90s are noisy. Use p50/min. Full data: `results/bench-linux-x64-2026-11-01.{md,json}`. Each case ran in a fresh process with 15 warm iterations.

### OCR (onnxruntime-node, 4 intra-op threads unless noted)

| Case | Warm p50 (min) | Split: det / post / rec | Notes |
|---|---|---|---|
| 600x200 region, 5 ja lines, ch rec | **333 ms** (308) | 53 / 2 / 262 | det at native size (608x192) |
| 600x200, 6 zh lines | 351 ms (277) | 38 / 1 / 295 | |
| 600x200, 5 en lines, ch rec | 327 ms (270) | | |
| 600x200, 5 en lines, **en rec** | **286 ms** (250) | 30 / 2 / 196 | smallest rec |
| 600x200 de / ko / ru | 338 / 266 / 277 ms | | latin / korean / eslav rec |
| 600x200 ar / hi / th (4 lines) | 155 / 141 / 169 ms | | |
| **1920x1080 screenshot**, 23 lines | **1519 ms** (1230) | 784 / 13 / 828 | 8 threads: 1506 (1136) |
| Same region, 2 threads | 504 ms | | 8 threads: 534 (no gain over 4) |
| Same region, onnxruntime-web 4 threads | 677 ms (551) | | 1 thread: 1572 ms |
| Session load (det + rec) | 0.37–0.50 s | | web: 0.9–1.2 s |
| Process start → first OCR result | 0.8–1.1 s | | web: 1.8 s |

- **Recognition dominates.** It costs roughly 75 µs per input column at height 48 (≈ 50 ms for a 640-px line), and batching lines gives no gain on CPU (`scripts/rec-shapes.ts`). The detector is ~40–50 ms for a small region and ~0.5–0.8 s at 1920x1088.
- **Accuracy on rendered samples:** every line was correct in all 10 scripts tested, apart from these misses: `गईं` → `गई` (one dropped anusvara), `gerne!` → `gernel`, and the `▶` glyph and the full-width spaces in `キャンセル　　次へ` (read as one line). Korean on the full screenshot needs the Korean rec (ch rec drops it, as expected). So one recogniser per script family, chosen per block, is needed (GLIM-49/56). Real (non-rendered) screenshots are not tested yet; that step is in TESTING.md.
- **Memory:** with ORT's default CPU arena, peak RSS reaches **~1.2 GB** after full-screen runs (many distinct tensor shapes). With `enableCpuMemArena: false, enableMemPattern: false` the same screenshot peaks at **372 MB** and was no slower in our (noisy) run. A region-only process sits at ~210–320 MB.

### Translation (Bergamot WASM, single thread)

| Route | First call after load | Per sentence warm p50 | Batch of 5 |
|---|---|---|---|
| ja→en | 0.79 s | **50 ms** | 321 ms |
| zh-Hans→en | 0.69 s | 51 ms | 272 ms |
| de→en | 0.36 s | 51 ms | 263 ms |
| en→de | 0.26 s | 48 ms | 254 ms |
| ja→en→de (pivot) | 0.10 s (both models already warm) | **108 ms** | 614 ms |

- Runtime instantiation takes ~0.1–0.3 s. Pack load takes 0.2–0.5 s (ja/zh) and 0.15–0.35 s (de/en). **The first translation per pack is slow (0.26–0.8 s)**, so send a dummy sentence when the pack loads.
- Batching doesn't help: cost is linear in sentences on one thread. Parallelism has to come from several Workers.
- Peak RSS: 4 packs in one runtime is **830 MB**. One ja→en Worker plus OCR is **723 MB**. Each extra Worker adds ~400 MB.
- Output samples: `設定を保存しました。` → "Save the settings." (meaning drift; the source means "settings saved"), `明日の会議は午後三時に始まります。` → "Tomorrow's meeting starts at 3pm.", `请输入您的密码。` → "Please enter your password.", `Die Datei konnte nicht gespeichert werden.` → "The file could not be saved.", `See you tomorrow at the station.` → "Wir sehen uns morgen auf der Station." (should be "am Bahnhof"), pivot `明日の会議は午後三時に始まります。` → "Das morgen Treffen beginnt um 15Uhr." (grammar slip), `キャンセル次へ` → "Cancel Next".
- Loading more packs after translating did **not** crash (`scripts/load-after-translate.ts`, 4 packs loaded one by one with translations in between). The molecule package reported a crash with the older v1 WASM; we could not reproduce it with v0.6.0 / 3.x packs.

### End-to-end Snip (600x200 ja region → OCR → ja→en, Bergamot in a Bun Worker)

| Config | First snip after models ready | Warm p50 (min) | Warm OCR / MT p50 | Peak RSS |
|---|---|---|---|---|
| 1 Worker, no prewarm | 1771 ms (559 + 1211) | 848 ms (562) | 540 / 276 | 744 MB |
| **1 Worker, prewarm** | **773 ms** (478 + 295) | **604 ms** (506) | 330 / 266 | 723 MB |
| 2 Workers, prewarm, lines split | 538 ms (383 + 155) | 484 ms (411) | 333 / 156 | 1132 MB |

Process start to ready (models loaded and prewarmed) takes 1.3–1.8 s.

## Against the budget

- **Snip < 1.5 s: passes with room to spare on this VM** (0.6 s warm, 0.77 s for the first snip). That holds as long as models are preloaded and prewarmed at app start, and the snip is a region rather than the full screen: a full 1920x1080 OCR alone takes ~1.5 s here. A pivot pair adds ~60 ms per line. A mid-range laptop CPU (Apple M-series, Zen 3/4, recent Intel) should be at least as fast per core as this shared VM (*unverified*).
- **Live re-OCR "well under 300 ms": not met by brute force.** Full det + rec of a 5-line region takes 290–350 ms here. Detection alone is 40–50 ms and each line costs ~40–60 ms to recognise. Live has to run det every frame (or only after a pixel-diff trigger, GLIM-58) and **re-recognise only lines whose crop changed** (cache rec results by crop hash). A typical Live frame with 0–1 changed lines then costs ~50–110 ms. Follow-up ticket: GLIM-88.

## Risks for Windows and macOS

1. **Intel Macs: no onnxruntime-node binary since 1.24** (npm tarball and GitHub releases ship only `osx-arm64`; the last `osx-x86_64` / universal2 build is **1.23.2**). Options: (a) pin onnxruntime-node 1.23.2 for darwin-x64 builds (it has `bin/napi-v6/darwin/x64`), (b) use onnxruntime-web WASM on Intel Macs (~2x slower, still inside Snip budget), (c) build ORT from source in CI. Recommendation: (a) for v1, since 1.23.2 has the same InferenceSession API we use, with (b) as the automatic fallback. Ticket GLIM-89.
2. **Bun and N-API on Windows/macOS: unverified.** It works on Linux x64. Bun's N-API is the same code on every OS, but `onnxruntime_binding.node` loads `onnxruntime.dll` / `libonnxruntime.1.31.1.dylib` from its own directory, so when Electrobun bundles the app those files must stay side by side (`bin/napi-v6/<os>/<arch>/`), unpacked from any archive. The macOS dylib needs signing or ad-hoc signing with the app (Gatekeeper / library validation). The Windows package also ships DirectML.dll (18 MB) and dxcompiler.dll (18 MB), which are not needed for CPU. Deleting them saves 36 MB but must be tested (the binding may link DirectML).
3. **Size of onnxruntime-node:** the npm package is ~260 MB across all platforms. Each platform's binaries are 45 MB (darwin-arm64) and 31 MB + 36 MB DirectML (win-x64). The packager must keep only the target OS/arch.
4. **WASM threads:** not needed for Bergamot (single-threaded build). onnxruntime-web threads did work under Bun on Linux (Workers + SharedArrayBuffer); unverified on Windows/macOS.
5. **Bergamot performance on ARM:** the fallback gemm is WASM SIMD. Firefox on Apple Silicon gets the same path unless `mozIntGemm` is present, so we expect similar speed (*unverified*).
6. **Memory:** OCR + one Bergamot route ≈ 0.7 GB peak; each extra loaded route ≈ +0.1–0.4 GB. Unload idle Workers and turn the ORT arena off.
7. **ModelScope as the OCR source** is a China-hosted CDN that can be slow or blocked. We should mirror the OCR ONNX files on our own GitHub release (Apache-2.0 allows it) or reproduce the conversion with `paddle2onnx` in CI from the official PaddlePaddle HF repos.
8. **Remote Settings schema drift:** Mozilla moved from `translations-models` to `-v2` (zstd, new fields) in 2025. The downloader should treat the schema defensively and pin the runtime record by hash.

## Guidance for the build tickets

### GLIM-37 (bundle OCR models)
- Bundle `ch_PP-OCRv5_det_mobile.onnx` (4.8 MB) + `ch_PP-OCRv5_rec_mobile.onnx` (16.6 MB) + `ppocrv5_dict.txt` in the installer (~21.5 MB). Together they cover zh, ja and en.
- Make the other recognisers (latin, korean, eslav/cyrillic, arabic, devanagari, th, el; 8–13.5 MB each) **on-demand downloads** through GLIM-38. Alternatively, bundle latin too (8 MB), since European languages are common.
- Record the source URL, SHA-256 (from `scripts/fetch-models.ts`) and Apache-2.0 NOTICE for each file. Mirror the files to a Glimpse release asset.

### GLIM-38 (model downloader)
- One generic "artifact" downloader: URL, expected SHA-256, optional zstd with `decompressedHash`, atomic rename into the cache, resume optional (files are ≤ 60 MB).
- Bergamot catalogue: fetch `translations-models-v2/records`, apply the desktop selection rule above, and group by `(sourceLanguage, targetLanguage, version)`. A pack is the set of files of one version. Store `pack.json` (`{src,tgt,version,architecture,files:{model,lex,vocab|srcvocab+trgvocab}}`), as `scripts/fetch-models.ts` does. Show the **download size** (`attachment.size`) in the UI and the **unpacked size** (`decompressedSize`) for disk. Delete the `.zst` after unpacking.
- Updates: a newer `version` for an installed pair is an optional update. Keep the old pack until the new one verifies.
- Runtime: fetch the `translations-wasm-v2` `bergamot-translator` record and the JS glue from the Firefox tree, both pinned by SHA-256. Changing the runtime is a code change (glue and WASM must match), not an automatic update.

### GLIM-46 (local PaddleOCR OcrProvider)
- Reuse `src/ocr/{image,det,rec,pipeline}.ts` (copy, don't import). The pipeline is BGR + ImageNet mean/std for det, (x/255−0.5)/0.5 for rec at height 48, DB post-process (thresh 0.3, box 0.6, unclip 1.5) and greedy CTC with blank=0 and a trailing space.
- Session options: `intraOpNumThreads: min(4, cores/2)`, `interOpNumThreads: 1`, `enableCpuMemArena: false`, `enableMemPattern: false`.
- Feed capture pixels straight in (BGRA → our RGBA helper, or a BGRA variant of `resizeNormalizeBGR`, which skips a conversion).
- Snip: det at native resolution capped at 1920 long side. For tiny text, a `minSide` upscale option is in `detInputSize`.
- Live: keep the last frame's boxes and rec results, and re-recognise only boxes whose crop hash changed (GLIM-88).
- Pick the rec model per script. Run "ch" first for CJK, or use GLIM-21/49 script detection on the det crops. Apply `visualToLogicalRtl` for the Arabic rec.
- Load sessions at app start. Loading takes ~0.4 s and the first run costs ~1.3x a warm run.

### GLIM-47 (Bergamot TranslationProvider)
- Run each loaded route in a **Bun Worker** (`src/bergamot-worker.ts` pattern). The WASM call is synchronous and takes ~50 ms per sentence, so it must stay off the main thread.
- Use one runtime per Worker. Several packs can share one runtime (verified). For a pivot route, load both models in the same Worker and use `translateViaPivoting`.
- **Prewarm** each pack with a one-word translation right after loading (saves 0.3–0.8 s on the first snip).
- Split blocks into sentences and translate them as separate strings in one call. For Snip, use two Workers per hot route on machines with ≥ 8 GB RAM; it halves MT latency (266 → 156 ms for 5 lines).
- Use Firefox's Marian config (`MODEL_CONFIG` in `src/bergamot.ts`) and the alignment table (model 256, others 64). Load files into `AlignedMemory`.
- Keep the translation cache from GLIM-20 in front of it, because Live re-translates the same strings.
- Map language codes for `zh-Hans`/`zh-Hant` (GLIM-39).

## Reproduce

`bun install && bun scripts/fetch-models.ts --m2m && bun scripts/make-samples.ts && bun test && bun src/bench.ts --m2m`. Details are in TESTING.md. The model files are gitignored and downloaded by script. The rendered sample PNGs are committed in `samples/`.
