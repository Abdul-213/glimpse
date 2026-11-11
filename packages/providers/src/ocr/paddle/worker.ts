// The PaddleOCR inference Worker (ARCHITECTURE.md section 3: OCR runs in a dedicated Bun
// Worker owned by the pipeline, plain-data messages in and out). Owns the onnxruntime-node
// sessions and runs the whole pipeline (pre-processing, det, DB post-process, crops, rec) so
// none of that CPU work lands on the app's Bun worker. Jobs run one at a time; `cancel` is
// handled immediately and checked between ORT runs.

import type { OcrPurpose, OcrRecognizer } from "@glimpse/core";
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
import { type FromWorker, OCR_PROTOCOL, type OrtProfile, type ToWorker } from "./protocol.ts";
import { buildCharset } from "./rec.ts";

declare const self: Worker;

// GLIM-134: two engines over the same model files. `snip` (latency first) is made at init;
// `live` (fewer, non-spinning threads: about half the CPU per read) on the first Live request.
// ORT fixes the thread pool per session, so a profile is a set of sessions.
const engines = new Map<OcrPurpose, OcrEngine>();
let profiles: Record<OcrPurpose, OrtProfile> | null = null;
let detPath = "";
let engineOptions: Partial<EngineOptions> = {};
const recFiles = new Map<OcrRecognizer, { readonly model: string; readonly charset: readonly string[] }>();
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

const post = (msg: FromWorker) => self.postMessage(msg);

const bunHash = (crop: Raster): string => `${crop.width}x${crop.height}:${Bun.hash(crop.data).toString(16)}`;

function sessionOptions(p: OrtProfile): ort.InferenceSession.SessionOptions {
	return {
		intraOpNumThreads: p.threads,
		interOpNumThreads: 1,
		// GLIM-17: the default arena grows to ~1.2 GB over many tensor shapes; off it peaks
		// at ~370 MB with no measurable slowdown.
		enableCpuMemArena: false,
		enableMemPattern: false,
		graphOptimizationLevel: "all",
		// "session.intra_op.allow_spinning": spinning threads busy-wait between ops (GLIM-134).
		extra: { session: { intra_op: { allow_spinning: p.spinning ? "1" : "0" } } },
	};
}

async function createSession(path: string, p: OrtProfile): Promise<OrtSession> {
	return (await ort.InferenceSession.create(path, sessionOptions(p))) as unknown as OrtSession;
}

const tensor = (data: Float32Array, dims: readonly number[]) => new ort.Tensor("float32", data, [...dims]);

/** The engine for a purpose, made on first use; recognisers load into it as requests need them. */
async function engineFor(purpose: OcrPurpose): Promise<OcrEngine> {
	const have = engines.get(purpose);
	if (have) return have;
	if (!profiles) throw new Error("worker not initialised");
	const p = profiles[purpose];
	const e = new OcrEngine(tensor, await createSession(detPath, p), engineOptions, bunHash);
	engines.set(purpose, e);
	return e;
}

async function ensureRecognizer(e: OcrEngine, purpose: OcrPurpose, r: OcrRecognizer): Promise<void> {
	if (e.hasRecognizer(r)) return;
	const files = recFiles.get(r);
	if (!files || !profiles) throw new Error(`recogniser ${r} is not loaded`);
	e.addRecognizer(r, await createSession(files.model, profiles[purpose]), files.charset);
}

function protocolMismatch(got: unknown): string {
	const app = typeof got === "string" ? got : "an older protocol";
	return `OCR worker is from another build (worker: ${OCR_PROTOCOL}, app: ${app}); rebuild the app so both match`;
}

function requireEngine(): OcrEngine {
	const e = engines.get("snip");
	if (!e) throw new Error("worker not initialised");
	return e;
}

async function handle(msg: ToWorker): Promise<void> {
	switch (msg.type) {
		case "init": {
			if (msg.protocol !== OCR_PROTOCOL) throw new Error(protocolMismatch(msg.protocol));
			profiles = { snip: msg.snip, live: msg.live };
			detPath = msg.det;
			engineOptions = msg.engine;
			await engineFor("snip");
			post({ type: "ok", id: msg.id });
			return;
		}
		case "load": {
			if (!recFiles.has(msg.recognizer)) {
				const charset = buildCharset(await Bun.file(msg.dict).text());
				recFiles.set(msg.recognizer, { model: msg.model, charset });
			}
			for (const [purpose, e] of engines) await ensureRecognizer(e, purpose, msg.recognizer);
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
			const e = await engineFor(msg.purpose);
			for (const r of msg.candidates) await ensureRecognizer(e, msg.purpose, r);
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
			for (const e of engines.values()) e.cache.clear();
			post({ type: "ok", id: msg.id });
			return;
		case "dispose":
			await Promise.all([...engines.values()].map((e) => e.release()));
			engines.clear();
			recFiles.clear();
			profiles = null;
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
