// Times the rec model alone at fixed shapes: bun scripts/rec-shapes.ts [rec=ch] [threads=4]
import * as ort from "onnxruntime-node";
import { recPaths } from "../src/models";

const { model } = recPaths(process.argv[2] ?? "ch");
const threads = Number(process.argv[3] ?? 4);
for (const opt of ["all", "extended"] as const) {
  const s = await ort.InferenceSession.create(model, { intraOpNumThreads: threads, graphOptimizationLevel: opt });
  for (const [n, w] of [[1, 160], [1, 320], [1, 640], [1, 960], [5, 640], [8, 320]] as const) {
    const x = new ort.Tensor("float32", new Float32Array(n * 3 * 48 * w).fill(0.1), [n, 3, 48, w]);
    await s.run({ x });
    const t = performance.now();
    for (let i = 0; i < 5; i++) await s.run({ x });
    console.log(`${opt} threads=${threads} [${n},3,48,${w}] ${((performance.now() - t) / 5).toFixed(1)} ms`);
  }
}
