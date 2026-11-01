// The PaddleOCR inference Worker (ARCHITECTURE.md section 3: OCR runs in a dedicated Bun
// Worker owned by the pipeline, plain-data messages in and out). Owns the onnxruntime-node
// sessions and runs the whole pipeline (pre-processing, det, DB post-process, crops, rec) so
// none of that CPU work lands on the app's Bun worker. Jobs run one at a time; `cancel` is
// handled immediately and checked between ORT runs.

import * as ort from "onnxruntime-node";
import {
	CancelledError,
	type EngineLine,
	type EngineOptions,
	newTimings,
	OcrEngine,
	type OrtSession,
} from "./engine.ts";
import { type Raster, rasterOf } from "./image.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { buildCharset } from "./rec.ts";

declare const self: Worker;

let engine: OcrEngine | null = null;
let sessionOptions: ort.InferenceSession.SessionOptions = {};
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

const post = (msg: FromWorker) => self.postMessage(msg);

const bunHash = (crop: Raster): string => `${crop.width}x${crop.height}:${Bun.hash(crop.data).toString(16)}`;

async function createSession(path: string): Promise<OrtSession> {
	return (await ort.InferenceSession.create(path, sessionOptions)) as unknown as OrtSession;
}

function requireEngine(): OcrEngine {
	if (!engine) throw new Error("worker not initialised");
	return engine;
}

async function handle(msg: ToWorker): Promise<void> {
	switch (msg.type) {
		case "init": {
			sessionOptions = {
				intraOpNumThreads: msg.threads,
				interOpNumThreads: 1,
				// GLIM-17: the default arena grows to ~1.2 GB over many tensor shapes; off it peaks
				// at ~370 MB with no measurable slowdown.
				enableCpuMemArena: false,
				enableMemPattern: false,
				graphOptimizationLevel: "all",
			};
			const det = await createSession(msg.det);
			const tensor = (data: Float32Array, dims: readonly number[]) => new ort.Tensor("float32", data, [...dims]);
			engine = new OcrEngine(tensor, det, msg.engine as Partial<EngineOptions>, bunHash);
			post({ type: "ok", id: msg.id });
			return;
		}
		case "load": {
			const e = requireEngine();
			if (!e.hasRecognizer(msg.recognizer)) {
				const [session, dict] = await Promise.all([createSession(msg.model), Bun.file(msg.dict).text()]);
				e.addRecognizer(msg.recognizer, session, buildCharset(dict));
			}
			post({ type: "ok", id: msg.id });
			return;
		}
		case "warmup": {
			const e = requireEngine();
			// A synthetic "line": dark bar on white. One det run plus one rec run per recogniser.
			const w = 320;
			const h = 64;
			const data = new Uint8Array(w * h * 4).fill(255);
			for (let y = 24; y < 40; y++) for (let x = 16; x < 300; x++) data.fill(20, (y * w + x) * 4, (y * w + x) * 4 + 3);
			const img: Raster = { width: w, height: h, stride: w * 4, bpp: 4, r: 0, g: 1, b: 2, data };
			await e.detect(img);
			const box = {
				quad: [
					[12, 20],
					[304, 20],
					[304, 44],
					[12, 44],
				] as const,
				score: 1,
			};
			for (const r of e.recognizers()) await e.recognize(img, [box], [r]);
			e.cache.clear();
			post({ type: "ok", id: msg.id });
			return;
		}
		case "ocr": {
			const e = requireEngine();
			const isCancelled = () => cancelled.has(msg.id);
			const img = rasterOf({ ...msg.image, data: new Uint8Array(msg.image.data) });
			const timings = newTimings();
			if (isCancelled()) throw new CancelledError("cancelled");
			const boxes = await e.detect(img, timings);
			if (isCancelled()) throw new CancelledError("cancelled");
			if (msg.progressive) post({ type: "detected", id: msg.id, quads: boxes.map((b) => b.quad) });
			const onLine = msg.progressive
				? (index: number, line: EngineLine) => post({ type: "line", id: msg.id, index, line })
				: undefined;
			const lines = await e.recognize(img, boxes, msg.candidates, {
				cancelled: isCancelled,
				timings,
				...(onLine ? { onLine } : {}),
			});
			post({ type: "ok", id: msg.id, value: { lines, timings } });
			return;
		}
		case "clear-cache":
			engine?.cache.clear();
			post({ type: "ok", id: msg.id });
			return;
		case "dispose":
			await engine?.release();
			engine = null;
			post({ type: "ok", id: msg.id });
			return;
		case "cancel":
			return;
	}
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
	const msg = event.data;
	if (msg.type === "cancel") {
		cancelled.add(msg.target);
		return;
	}
	queue = queue.then(async () => {
		try {
			await handle(msg);
		} catch (error) {
			const name = error instanceof Error ? error.name : "Error";
			const message = error instanceof Error ? error.message : String(error);
			post({ type: "error", id: msg.id, name, message });
		} finally {
			cancelled.delete(msg.id);
		}
	});
};
