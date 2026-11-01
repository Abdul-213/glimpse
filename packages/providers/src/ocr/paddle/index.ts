// Local OCR: PaddleOCR PP-OCRv5 on onnxruntime-node, in a Bun Worker (GLIM-46).

export * from "./factory.ts";
export * from "./model-files.ts";
export * from "./paddle-provider.ts";
export { DEFAULT_RECOGNIZERS, planRecognizers } from "./recognizers.ts";
export { type SpawnWorker, spawnOcrWorker, type WorkerLike } from "./worker-client.ts";
