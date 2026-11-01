// bun src/ocr-cli.ts <image.png> [rec=ch] [--web] [--threads=N] [--min-side=N]
// Runs PP-OCRv5 det + rec and prints lines with timings (second, warm run).
import { join } from "node:path";
import { DET, loadPng, recPaths, SAMPLES } from "./models";
import { OcrEngine, type OrtLike } from "./ocr/pipeline";

const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const pos = args.filter((a) => !a.startsWith("--"));
const imgPath = pos[0] ?? join(SAMPLES, "region-en.png");
const recName = pos[1] ?? "ch";
const threads = Number(flag("threads") ?? 4);
const web = args.includes("--web");

const ort = (web ? await import("onnxruntime-web") : await import("onnxruntime-node")) as unknown as OrtLike;
if (web) {
  const env = (ort as unknown as { env: { wasm: { numThreads: number; simd?: boolean } } }).env;
  env.wasm.numThreads = threads;
}
const { model, dict } = recPaths(recName);
const t0 = performance.now();
const engine = await OcrEngine.create(ort, DET, model, dict, web ? { executionProviders: ["wasm"] } : { intraOpNumThreads: threads, interOpNumThreads: 1, ...(args.includes("--no-arena") ? { enableCpuMemArena: false, enableMemPattern: false } : {}) }, {
  det: { maxSide: 1920, minSide: Number(flag("min-side") ?? 0) },
  recBatch: Number(flag("batch") ?? 8),
  recBucket: Number(flag("bucket") ?? 1),
  rtl: recName === "arabic",
});
console.log(`${web ? "onnxruntime-web" : "onnxruntime-node"} load ${(performance.now() - t0).toFixed(0)} ms`);
const img = loadPng(imgPath);
const first = await engine.run(img);
const warm = await engine.run(img);
console.log(`cold run ${first.timings.total.toFixed(0)} ms; warm ${JSON.stringify(Object.fromEntries(Object.entries(warm.timings).map(([k, v]) => [k, Math.round(v)])))}`);
for (const l of warm.lines) console.log(`  [${l.textScore.toFixed(2)}] ${l.text}`);
console.log(`RSS ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
