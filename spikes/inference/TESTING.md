# GLIM-17 inference spike: rerunning on Windows and macOS

Everything runs from a terminal; no app or display is needed. It takes about 15 minutes per machine,
most of it the benchmark. Use a laptop on mains power with other apps closed.

## 1. Setup (once per machine)

1. Install Bun 1.4.x: https://bun.sh (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`).
2. Get the branch and install:
   ```sh
   git clone https://github.com/Abdul-213/glimpse.git && cd glimpse
   git checkout glim-17-inference-spike        # or develop, once merged
   cd spikes/inference
   bun install
   ```
3. Intel Mac only: onnxruntime-node 1.24 and later ship no macOS x64 binary. Run
   `bun add onnxruntime-node@1.23.2` first, or skip to step 5 and use the WASM runs only (`--web`).
4. Download the models (~470 MB unpacked, verified by SHA-256) and render the test images:
   ```sh
   bun scripts/fetch-models.ts --m2m     # drop --m2m to skip the 630 MB M2M-100 fallback
   bun scripts/make-samples.ts           # fetches Noto fonts into ~/.cache/glim17/fonts
   ```

## 2. Smoke checks (expected output in brackets)

```sh
bun src/ocr-cli.ts samples/region-ja.png ch         # [5 Japanese lines, e.g. 明日の会議は午後三時に始まります。]
bun src/ocr-cli.ts samples/region-ar.png arabic     # [تم حفظ الإعدادات بنجاح, in correct right-to-left order]
bun src/ocr-cli.ts samples/region-ja.png ch --web   # [same lines via onnxruntime-web (WASM)]
bun src/translate-cli.ts                             # [ja/zh/de->en, en->de, ja->en->de sentences]
bun src/m2m.ts ja en "明日の会議は午後三時に始まります。"   # [an English sentence, ~1-3 s]
bun test                                             # [all pass; e2e tests run when models exist]
```

Note anything that fails to load: the exact error (for example `dlopen` / "not a valid Win32 application" /
code-signing or Gatekeeper prompts on macOS) is the most valuable result of this spike.

## 3. Benchmark

```sh
bun src/bench.ts --m2m > results/summary.md
```

It writes `results/bench-<os>-<arch>-<date>.json` and the Markdown tables to `results/summary.md`.
Each case runs in a fresh process, so "load", "first run" and peak RSS are cold numbers.
Please commit both files to the branch (or attach them to GLIM-17) together with:

- Machine model, CPU, RAM, OS version, on battery or mains.
- Whether Windows Defender / macOS showed any prompt on first load.
- Task Manager / Activity Monitor peak memory for `bun` during the `mt` case, as a cross-check.

## 4. What to compare

Budget (PRODUCT.md / GLIM-17): Snip-to-translation **< 1.5 s** on a mid-range laptop; Live re-OCR of a small
region **well under 300 ms**.

- Snip: the `snip ... workers=1 prewarm=true` row, "warm p50" (and "first snip").
- Live: the `node t=4 ch` row for `region-ja.png`, "warm p50"; and the same for `en`/`latin` rec.
- Note whether `onnxruntime-web` is within 2x of `onnxruntime-node` (it is the Intel Mac fallback).

## 5. Optional: real screenshots

Take a 1920x1080 screenshot of a real app with Japanese or Chinese text, save it as PNG, and run
`bun src/ocr-cli.ts <file.png> ch`. Report anything misread.
