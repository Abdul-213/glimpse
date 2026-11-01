# GLIM-37: Which models ship in the installer

Status: **Accepted** (2026-11-01) · Inputs: [GLIM-17 findings](../../spikes/inference/FINDINGS.md), [GLIM-85](GLIM-85-translation-model.md), [GLIM-21](GLIM-21-language-detection.md)

## Decision

The installer ships the **PP-OCRv5 mobile detector, the `ch` and `latin` recognisers, and the
Bergamot WASM runtime**: 34.5 MB on disk, about 27 MB more in a compressed installer. Every
other recogniser (9 of them, 7.8 to 13.5 MB each, 85 MB in total) and every Firefox
Translations language pack downloads on demand through the model download manager (GLIM-38).

| Model | Bundled | On disk | Why |
|---|---|---|---|
| Detector `ch_PP-OCRv5_det_mobile` | yes | 4.8 MB | Needed for any local OCR, every script |
| Recogniser `ch` (+ 18k-char dict) | yes | 16.7 MB | Simplified and Traditional Chinese, Japanese and English in one model: the product's headline languages |
| Recogniser `latin` | yes | 7.9 MB | Every Latin-script language (European languages, Vietnamese, Indonesian, Turkish, Tagalog…): the largest group of source languages by count. Also reads English |
| Bergamot runtime (WASM + JS glue) | yes | 5.1 MB | Needed for any local translation. Pinned by hash: a runtime change is a code change, not a download (FINDINGS) |
| Recogniser `en` | on demand | 7.9 MB | Only faster than `latin`/`ch` for English (286 vs ~330 ms per region); not needed to read English |
| `korean` | on demand | 13.5 MB | Largest recogniser; only Korean users need it |
| `eslav`, `cyrillic`, `arabic`, `devanagari`, `th`, `el`, `ta`, `te` | on demand | 7.8–8.1 MB each | One script each. Bundling all of them would triple the OCR payload (to ~120 MB) for scripts most users never see |
| Firefox Translations packs | on demand | 13–70 MB per direction | Per language pair, chosen at onboarding (GLIM-85 starter pack) |

What this means for the user: OCR of Chinese, Japanese, English and Latin-script text works
straight after install with no network. Translation needs at least one language pack, which
onboarding offers. A block in a script whose recogniser isn't installed gets an inline
"download" action (GLIM-38), never a silent failure.

## How it works

- **Manifest:** [`app/models/manifest.json`](../../app/models/manifest.json) lists every
  model with URL(s), SHA-256, size, licence, attribution, upstream revision and `bundled`.
  It is validated by `parseModelManifest` in `@glimpse/core` (`packages/core/src/models/`).
  Model binaries are never committed.
- **Fetch script:** `bun run models` (bundled), `bun run models -- --all`, `--list`, `--stage`.
  Files are cached by SHA-256 under `~/.cache/glimpse/models/sha256/` (or
  `$GLIMPSE_MODEL_CACHE`, or `$XDG_CACHE_HOME/glimpse/models`); re-runs fetch nothing.
- **Build:** the Electrobun preBuild hook stages the bundled models into `app/dist/models/<id>/`
  with a manifest of just those models, `NOTICE.txt` and `licenses/`, and
  `electrobun.config.ts` copies `dist/models` to `models/` in the app
  (`Resources/app/models` on Linux; same relative path next to the main bundle on every OS).
  Release builds (`canary`, `stable`) fail if a bundled model can't be fetched or verified. Dev
  builds warn and ship an empty `models/` so offline development still builds
  (`GLIMPSE_REQUIRE_MODELS=1` makes dev strict too).
- **CI:** Linux CI caches `~/.cache/glimpse/models` keyed on the manifest's hash.
- **Licences:** PP-OCRv5 weights (PaddlePaddle) and the ONNX conversions (RapidOCR v3.10.0) are
  Apache-2.0; bergamot-translator and the Firefox Translations models are MPL-2.0. The texts and
  attributions are in `app/models/NOTICE.txt` and `app/models/licenses/`, shipped next to the
  models. The About screen should link to `models/NOTICE.txt` (settings UI work).

## Revisit if

- ModelScope (China-hosted) is slow or blocked for users: add a mirror URL to each file once the
  files are mirrored to a Glimpse GitHub release (GLIM-95). The manifest already takes a
  list of URLs.
- Real usage data shows a different top-3 script mix (for example many Korean users).
- GLIM-89 changes how Intel Macs run OCR (no effect on the files themselves).
