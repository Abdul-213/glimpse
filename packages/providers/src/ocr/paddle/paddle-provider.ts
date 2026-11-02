// GLIM-46: the local OCR provider. PaddleOCR PP-OCRv5 mobile (det + one recogniser per script
// family) on onnxruntime-node, running in a dedicated Bun Worker (worker.ts). Implements core's
// `OcrProvider`; passes `ocrProviderContract`.
//
// - Models come from a `ModelFileSource` (bundled folder, user models folder, or the dev
//   cache). Nothing is downloaded here: missing files are reported as `ModelResource`s.
// - Recognisers are loaded lazily: the bundled ones (`preload`) at init, others the first
//   time a request needs them. After the model manager installs a recogniser, call `rescan()`.
// - Output: lines grouped into blocks by core `groupLines` (GLIM-56), in reading order, each
//   with its `lines`; or one block per line (`grouping: "lines"`).

import { availableParallelism } from "node:os";
import {
	abortable,
	groupLines,
	hashString,
	type LanguageCode,
	type ModelResource,
	OCR_RECOGNIZERS,
	type OcrBlock,
	type OcrCapabilities,
	type OcrLanguageSupport,
	type OcrOptions,
	type OcrProvider,
	type OcrRecognizer,
	type OcrRequest,
	type OcrResult,
	PROVIDER_IDS,
	ProviderError,
	type ProviderFingerprint,
	type ProviderInfo,
	type ProviderStatus,
	provenanceOf,
	type Rect,
	recognizersFor,
	StatusCell,
	stableHash,
	throwIfAborted,
	type Unsubscribe,
	validateOcrImage,
} from "@glimpse/core";
import type { EngineLine, EngineOptions, EngineTimings } from "./engine.ts";
import type { Quad } from "./image.ts";
import {
	type DetectorFiles,
	locateDetector,
	locateRecognizer,
	type ModelFileSource,
	type RecognizerFiles,
} from "./model-files.ts";
import { DEFAULT_RECOGNIZERS, planRecognizers } from "./recognizers.ts";
import { OcrWorkerClient, type SpawnWorker, spawnOcrWorker, WorkerFailure } from "./worker-client.ts";

/** onnxruntime-node version the sessions run on (part of the fingerprint). */
export const ORT_VERSION = "1.31.1";

export const PADDLE_OCR_INFO: ProviderInfo & { readonly task: "ocr" } = {
	id: PROVIDER_IDS.paddleocr,
	name: "On-device text recognition",
	kind: "local",
	task: "ocr",
	vendor: null,
};

/** 4096 x 4096: beyond that, callers downscale (det is capped at 1920 px anyway). */
export const PADDLE_MAX_IMAGE_PIXELS = 4096 * 4096;

export const PADDLE_OCR_CAPABILITIES: OcrCapabilities = {
	kind: "local",
	needsNetwork: false,
	secretId: null,
	languages: "any",
	progressive: true,
	regions: false,
	maxImagePixels: PADDLE_MAX_IMAGE_PIXELS,
	maxImageBytes: null,
};

export interface PaddleOcrOptions {
	/** ORT intra-op threads for Snip; 0 = min(4, half the cores) (GLIM-17: no gain beyond 4). */
	readonly threads: number;
	/** Let Snip's ORT threads spin (busy-wait) between ops: lowest latency, most CPU. */
	readonly spinning: boolean;
	/**
	 * ORT threads for Live reads (`purpose: "live"`); 0 = the Snip count capped at 2. Live gets
	 * its own sessions, made on its first read (GLIM-134, docs/benchmarks/live-cpu.md).
	 */
	readonly liveThreads: number;
	/** Let Live's ORT threads spin. Off: about half the CPU per read for some latency. */
	readonly liveSpinning: boolean;
	/** Detector input long-side cap, px. */
	readonly detMaxSide: number;
	/** Upscale small regions so the short side is at least this. 0 = never. */
	readonly detMinSide: number;
	/** Drop lines whose recognition score is below this. */
	readonly minTextScore: number;
	/** Crop-hash rec cache entries (GLIM-88). 0 = off. */
	readonly recCacheSize: number;
	/** Recognisers loaded at init (when installed). Others load on first use. */
	readonly preload: readonly OcrRecognizer[];
	/**
	 * `blocks` (default): lines grouped into paragraphs/labels by core `groupLines` (GLIM-56);
	 * progress emits the detected boxes, then the blocks once grouped. `lines`: one block per
	 * line, each emitted as soon as it is read.
	 */
	readonly grouping: "blocks" | "lines";
}

export const PADDLE_OCR_DEFAULTS: PaddleOcrOptions = {
	threads: 0,
	spinning: true,
	liveThreads: 0,
	liveSpinning: false,
	detMaxSide: 1920,
	detMinSide: 0,
	minTextScore: 0.5,
	recCacheSize: 512,
	preload: DEFAULT_RECOGNIZERS,
	grouping: "blocks",
};

export interface PaddleOcrContext {
	readonly models: ModelFileSource;
	/** How to start the inference worker. Default: `new Worker(./worker.ts)`. */
	readonly spawnWorker?: SpawnWorker;
}

/** Last request's timings, for diagnostics and benchmarks. */
export interface PaddleOcrTimings extends EngineTimings {
	readonly total: number;
}

export function defaultThreads(): number {
	return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** Axis-aligned bounding box of a quad, in whole pixels, clamped to the image. */
export function quadBounds(q: Quad, width: number, height: number): Rect {
	const xs = q.map((p) => p[0]);
	const ys = q.map((p) => p[1]);
	const x = Math.max(0, Math.min(width, Math.floor(Math.min(...xs))));
	const y = Math.max(0, Math.min(height, Math.floor(Math.min(...ys))));
	const x2 = Math.max(x, Math.min(width, Math.ceil(Math.max(...xs))));
	const y2 = Math.max(y, Math.min(height, Math.ceil(Math.max(...ys))));
	return { x, y, width: x2 - x, height: y2 - y };
}

/** One line as an `OcrBlock`. Ids are `l<index>` (unique within a result). */
export function lineBlock(index: number, line: EngineLine, width: number, height: number): OcrBlock {
	return {
		id: `l${index}`,
		box: quadBounds(line.quad, width, height),
		text: line.text,
		confidence: Math.max(0, Math.min(1, line.score)),
	};
}

export class PaddleOcrProvider implements OcrProvider {
	readonly info = PADDLE_OCR_INFO;
	readonly capabilities = PADDLE_OCR_CAPABILITIES;
	readonly options: PaddleOcrOptions;

	readonly #ctx: PaddleOcrContext;
	readonly #cell = new StatusCell();
	#initPromise: Promise<ProviderStatus> | null = null;
	#client: OcrWorkerClient | null = null;
	#det: DetectorFiles | null = null;
	#installed = new Map<OcrRecognizer, RecognizerFiles>();
	#missing = new Map<OcrRecognizer, ModelResource>();
	readonly #loaded = new Set<OcrRecognizer>();
	#fingerprint: ProviderFingerprint;
	/** Timings of the last successful `recognise`. */
	lastTimings: PaddleOcrTimings | null = null;

	constructor(options: Partial<PaddleOcrOptions>, ctx: PaddleOcrContext) {
		this.options = { ...PADDLE_OCR_DEFAULTS, ...options };
		this.#ctx = ctx;
		this.#fingerprint = this.#computeFingerprint();
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#initPromise) {
			this.#cell.set({ state: "loading" });
			this.#initPromise = this.#load().then(
				(status) => {
					this.#initPromise = null;
					this.#cell.set(status);
					return this.#cell.status;
				},
				(error: unknown) => {
					this.#initPromise = null;
					this.#shutdownWorker();
					this.#cell.set({ state: "error", error: ProviderError.from(error, this.info.id).toInfo() });
					return this.#cell.status;
				},
			);
		}
		return abortable(this.#initPromise, signal, this.info.id);
	}

	/** Re-read which recognisers are installed (after the model manager added or removed one). */
	rescan(): void {
		this.#scanRecognizers();
		for (const r of [...this.#loaded]) if (!this.#installed.has(r)) this.#loaded.delete(r);
		this.#fingerprint = this.#computeFingerprint();
	}

	#scanRecognizers(): void {
		this.#installed = new Map();
		this.#missing = new Map();
		for (const r of OCR_RECOGNIZERS) {
			const loc = locateRecognizer(this.#ctx.models, r);
			if (loc.status === "installed") this.#installed.set(r, loc.files);
			else if (loc.status === "missing") this.#missing.set(r, loc.resource);
		}
	}

	async #load(): Promise<ProviderStatus> {
		const det = locateDetector(this.#ctx.models);
		this.#scanRecognizers();
		const missing: ModelResource[] = [];
		if (!("model" in det)) missing.push(det);
		if (this.#installed.size === 0) {
			// Nothing can read text: ask for the bundled recognisers (GLIM-37: ch + latin).
			const wanted = this.#ctx.models.manifest.models.filter((m) => m.kind === "ocr-recognizer" && m.bundled);
			for (const m of wanted) {
				const res = m.recognizer ? this.#missing.get(m.recognizer) : undefined;
				if (res) missing.push(res);
			}
			if (missing.length === 0 && this.#missing.size > 0) {
				const first = this.#missing.values().next();
				if (!first.done) missing.push(first.value);
			}
		}
		if (missing.length > 0 || !("model" in det)) return { state: "model-missing", missing };
		this.#det = det;
		this.#fingerprint = this.#computeFingerprint();

		const client = new OcrWorkerClient(this.#ctx.spawnWorker ?? spawnOcrWorker);
		client.onCrash = (error) => {
			if (this.#client !== client) return;
			this.#client = null;
			this.#loaded.clear();
			this.#cell.set({ state: "error", error: new ProviderError("internal", error.message).toInfo() });
		};
		this.#client = client;
		const engine: Partial<EngineOptions> = {
			det: { maxSide: this.options.detMaxSide, minSide: this.options.detMinSide },
			minTextScore: this.options.minTextScore,
			recCacheSize: this.options.recCacheSize,
		};
		const threads = this.options.threads > 0 ? this.options.threads : defaultThreads();
		const liveThreads = this.options.liveThreads > 0 ? this.options.liveThreads : Math.min(2, threads);
		await client.request({
			type: "init",
			det: det.model,
			snip: { threads, spinning: this.options.spinning },
			live: { threads: liveThreads, spinning: this.options.liveSpinning },
			engine,
		});
		const preload = this.options.preload.filter((r) => this.#installed.has(r));
		const first = this.#installed.keys().next();
		if (preload.length === 0 && !first.done) preload.push(first.value);
		for (const r of preload) await this.#ensureLoaded(client, r);
		return { state: "ready" };
	}

	async #ensureLoaded(client: OcrWorkerClient, r: OcrRecognizer): Promise<void> {
		if (this.#loaded.has(r)) return;
		const files = this.#installed.get(r);
		if (!files)
			throw new ProviderError("model-missing", `recogniser ${r} is not installed`, { providerId: this.info.id });
		await client.request({ type: "load", recognizer: r, model: files.model, dict: files.dict });
		this.#loaded.add(r);
	}

	async warmup(signal?: AbortSignal): Promise<void> {
		const client = this.#readyClient();
		await abortable(client.request({ type: "warmup" }), signal, this.info.id);
	}

	/** Drop cached recognition results (screen text) from the worker's memory. */
	async clearCache(): Promise<void> {
		await this.#client?.request({ type: "clear-cache" });
	}

	#shutdownWorker(): void {
		const client = this.#client;
		this.#client = null;
		this.#loaded.clear();
		client?.terminate();
	}

	async dispose(): Promise<void> {
		if (this.#cell.status.state === "disposed") return;
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
		const client = this.#client;
		this.#client = null;
		if (client) {
			// Let ORT free its sessions, but never hang dispose on a stuck worker.
			const released = client.request({ type: "dispose" }).catch(() => undefined);
			await Promise.race([released, new Promise((r) => setTimeout(r, 1000))]);
			client.terminate();
		}
		this.#loaded.clear();
	}

	languageSupport(lang: LanguageCode): OcrLanguageSupport {
		if (this.#cell.status.state !== "ready") return { status: "unsupported" };
		const families = recognizersFor(lang);
		if (families.length === 0) return { status: "unsupported" };
		if (families.some((r) => this.#installed.has(r))) return { status: "ready" };
		const resource = families.map((r) => this.#missing.get(r)).find((r) => r !== undefined);
		return resource ? { status: "missing", missing: [resource] } : { status: "unsupported" };
	}

	fingerprint(): ProviderFingerprint {
		return this.#fingerprint;
	}

	#computeFingerprint(): ProviderFingerprint {
		const recs = [...this.#installed.values()].map((f) => `${f.recognizer}=${f.revision}`).sort();
		const revision = [`ort${ORT_VERSION}`, `det=${this.#det?.revision ?? "none"}`, ...recs].join(";");
		const {
			threads: _t,
			spinning: _s,
			liveThreads: _lt,
			liveSpinning: _ls,
			preload: _preload,
			recCacheSize: _cache,
			...output
		} = this.options;
		return { providerId: this.info.id, modelRevision: hashString(revision), optionsHash: stableHash(output) };
	}

	#readyClient(): OcrWorkerClient {
		const client = this.#client;
		if (this.#cell.status.state !== "ready" || !client) {
			throw new ProviderError("not-ready", `provider is ${this.#cell.status.state}`, { providerId: this.info.id });
		}
		return client;
	}

	async recognise(request: OcrRequest, options: OcrOptions = {}): Promise<OcrResult> {
		const { signal, onProgress } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		const client = this.#readyClient();
		const { image } = request;
		const bad = validateOcrImage(image);
		if (bad) throw new ProviderError("invalid-request", bad, { providerId: id });
		if (image.width * image.height > PADDLE_MAX_IMAGE_PIXELS) {
			throw new ProviderError("input-too-large", `image over ${PADDLE_MAX_IMAGE_PIXELS} px`, { providerId: id });
		}
		const candidates = planRecognizers(request.languages, new Set(this.#installed.keys()));
		if (candidates.length === 0) {
			const missing = (request.languages ?? []).flatMap((l) => {
				const s = this.languageSupport(l);
				return s.status === "missing" ? s.missing : [];
			});
			if (missing.length > 0) {
				throw new ProviderError("model-missing", `install ${missing.map((m) => m.id).join(", ")}`, { providerId: id });
			}
			throw new ProviderError("unsupported-language", "no recogniser reads these languages", { providerId: id });
		}
		const fingerprint = this.#fingerprint;
		const started = performance.now();
		try {
			for (const r of candidates) await abortable(this.#ensureLoaded(client, r), signal, id);
			// Copy into a buffer we own and transfer it: the caller's buffer stays usable.
			const rowBytes = image.width * (image.format === "gray8" ? 1 : 4);
			const used = image.stride * (image.height - 1) + rowBytes;
			const data = image.data.slice(0, used).buffer;
			const { width, height } = image;
			let jobId = 0;
			const onAbort = () => client.cancel(jobId);
			signal?.addEventListener("abort", onAbort, { once: true });
			const job = client.request(
				{
					type: "ocr",
					image: { width, height, stride: image.stride, format: image.format, data },
					candidates,
					progressive: onProgress !== undefined,
					purpose: options.purpose ?? "snip",
				},
				{
					transfer: [data],
					onStart: (n) => {
						jobId = n;
					},
					onEvent: (event) => {
						if (!onProgress || signal?.aborted) return;
						if (event.type === "detected") {
							onProgress({ type: "detected", boxes: event.quads.map((q) => quadBounds(q, width, height)) });
						} else if (event.type === "line" && this.options.grouping === "lines") {
							onProgress({ type: "block", block: lineBlock(event.index, event.line, width, height) });
						}
					},
				},
			);
			const result = await abortable(job, signal, id).finally(() => signal?.removeEventListener("abort", onAbort));
			if (!result) throw new ProviderError("internal", "OCR worker returned no result", { providerId: id });
			this.lastTimings = { ...result.timings, total: performance.now() - started };
			// Lines keep their detection index as id, so progress blocks match the final ones.
			const lines = result.lines.map((line) => lineBlock(line.index, line, width, height));
			if (this.options.grouping === "lines") return { blocks: lines, provider: provenanceOf(this.info, fingerprint) };
			// GLIM-56: paragraphs, dialogue boxes, menu items and columns, in reading order.
			const blocks = groupLines(
				result.lines.map((line, i) => ({
					box: (lines[i] as OcrBlock).box,
					text: line.text,
					confidence: (lines[i] as OcrBlock).confidence,
					vertical: line.vertical,
				})),
			);
			if (onProgress && !signal?.aborted) for (const block of blocks) onProgress({ type: "block", block });
			return { blocks, provider: provenanceOf(this.info, fingerprint) };
		} catch (error) {
			if (error instanceof WorkerFailure && error.name === "AbortError") {
				throw new ProviderError("cancelled", "cancelled", { providerId: id });
			}
			throw ProviderError.from(error, id);
		}
	}
}
