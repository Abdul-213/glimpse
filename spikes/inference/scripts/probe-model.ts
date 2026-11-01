// Prints an ONNX model's inputs/outputs and load time through onnxruntime-node.
//   bun scripts/probe-model.ts <model.onnx>
import * as ort from "onnxruntime-node";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/probe-model.ts <model.onnx>");
const t0 = performance.now();
const s = await ort.InferenceSession.create(path, { intraOpNumThreads: 4 });
console.log(`load ${(performance.now() - t0).toFixed(0)} ms`);
console.log("inputs", JSON.stringify(s.inputMetadata));
console.log("outputs", JSON.stringify(s.outputMetadata));
