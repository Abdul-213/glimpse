// The PP-OCRv5 pipeline over ONNX Runtime sessions: detect -> crop -> recognise (with the
// per-script recogniser routing of recognizers.ts and the crop-hash cache of rec-cache.ts).
// No I/O and no ORT import: sessions come in through the structural `OrtLike` types, so tests
// can drive it with fake sessions and the worker with onnxruntime-node.
// Ported from spikes/inference/src/ocr/pipeline.ts.

import type { OcrRecognizer } from "@glimpse/core";
import {
	DB_DEFAULTS,
	type DbOptions,
	DET_MEAN,
	DET_STD,
	type DetBox,
	type DetSizeOptions,
	dbPostprocess,
	detInputSize,
} from "./det.ts";
import { type Quad, type Raster, resizeNormalizeBGR } from "./image.ts";
import { cropQuad, ctcDecode, isTallQuad, REC_HEIGHT, recBatch, recWidth, visualToLogicalRtl } from "./rec.ts";
import { type CropHasher, fnvCropHash, RecCache } from "./rec-cache.ts";
import {
	bestReading,
	FALLBACK_SCORE,
	type LineReading,
	lookalikeReaderFor,
	preferLookalike,
	preferSpecialist,
	specialistFor,
} from "./recognizers.ts";

// Structural subset of onnxruntime-common, so tests can pass fakes.
export interface OrtTensor {
	readonly data: unknown;
	readonly dims: readonly number[];
}
export interface OrtSession {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
	release?(): Promise<void>;
}
export type TensorFactory = (data: Float32Array, dims: readonly number[]) => OrtTensor;

export interface EngineOptions {
	readonly det: DetSizeOptions;
	readonly db: DbOptions;
	readonly recMaxWidth: number;
	readonly recBatch: number;
	/** Lines scoring below this after every pass are dropped. */
	readonly minTextScore: number;
	/** Rec cache entries (GLIM-88). 0 turns it off. */
	readonly recCacheSize: number;
}

export const ENGINE_DEFAULTS: EngineOptions = {
	det: { maxSide: 1920, minSide: 0 },
	db: DB_DEFAULTS,
	recMaxWidth: 3200,
	recBatch: 8,
	minTextScore: 0.5,
	recCacheSize: 512,
};

export interface EngineLine {
	/** Index of the detected box (detection order), stable between progress and result. */
	readonly index: number;
	readonly quad: Quad;
	readonly detScore: number;
	readonly text: string;
	readonly score: number;
	readonly recognizer: OcrRecognizer;
	/** The box was tall and its crop rotated: vertical text. */
	readonly vertical: boolean;
}

export interface EngineTimings {
	det: number;
	detPost: number;
	rec: number;
	lines: number;
	recRuns: number;
	cacheHits: number;
}

export const newTimings = (): EngineTimings => ({ det: 0, detPost: 0, rec: 0, lines: 0, recRuns: 0, cacheHits: 0 });

export class CancelledError extends Error {
	override name = "AbortError";
}

interface Recognizer {
	readonly session: OrtSession;
	readonly charset: readonly string[];
	/** Emits right-to-left text in visual order (Arabic). */
	readonly rtl: boolean;
}

export interface RecognizeOptions {
	/** Polled between ORT runs; throw `CancelledError` when it returns true. */
	readonly cancelled?: () => boolean;
	/** Called once per kept line, as soon as its reading is final. */
	readonly onLine?: (index: number, line: EngineLine) => void;
	readonly timings?: EngineTimings;
}

export class OcrEngine {
	readonly #tensor: TensorFactory;
	readonly #det: OrtSession;
	readonly #recs = new Map<OcrRecognizer, Recognizer>();
	readonly #cache: RecCache;
	readonly #hash: CropHasher;
	readonly opts: EngineOptions;

	constructor(
		tensor: TensorFactory,
		det: OrtSession,
		opts: Partial<EngineOptions> = {},
		hash: CropHasher = fnvCropHash,
	) {
		this.#tensor = tensor;
		this.#det = det;
		this.opts = { ...ENGINE_DEFAULTS, ...opts };
		this.#cache = new RecCache(this.opts.recCacheSize);
		this.#hash = hash;
	}

	addRecognizer(name: OcrRecognizer, session: OrtSession, charset: readonly string[]): void {
		this.#recs.set(name, { session, charset, rtl: name === "arabic" });
	}

	hasRecognizer(name: OcrRecognizer): boolean {
		return this.#recs.has(name);
	}

	recognizers(): OcrRecognizer[] {
		return [...this.#recs.keys()];
	}

	get cache(): RecCache {
		return this.#cache;
	}

	async release(): Promise<void> {
		const sessions = [this.#det, ...[...this.#recs.values()].map((r) => r.session)];
		this.#recs.clear();
		this.#cache.clear();
		await Promise.all(sessions.map((s) => s.release?.()));
	}

	async detect(img: Raster, t?: EngineTimings): Promise<DetBox[]> {
		const s = detInputSize(img.width, img.height, this.opts.det);
		const t0 = performance.now();
		const input = resizeNormalizeBGR(img, s.w, s.h, DET_MEAN, DET_STD);
		const out = await this.#det.run({ [this.#det.inputNames[0] ?? "x"]: this.#tensor(input, [1, 3, s.h, s.w]) });
		const t1 = performance.now();
		const prob = out[this.#det.outputNames[0] ?? ""]?.data;
		if (!(prob instanceof Float32Array)) throw new Error("detector returned no float32 output");
		const boxes = dbPostprocess(prob, s.w, s.h, img.width, img.height, this.opts.db);
		if (t) {
			t.det += t1 - t0;
			t.detPost += performance.now() - t1;
		}
		return boxes;
	}

	/** Read each crop with one recogniser, batched, through the cache. */
	async #read(
		name: OcrRecognizer,
		crops: readonly { readonly crop: Raster; readonly key: string }[],
		cancelled: (() => boolean) | undefined,
		t: EngineTimings | undefined,
	): Promise<LineReading[]> {
		const rec = this.#recs.get(name);
		if (!rec) throw new Error(`recogniser ${name} is not loaded`);
		const out: LineReading[] = new Array(crops.length);
		const todo: number[] = [];
		crops.forEach((c, i) => {
			const hit = this.#cache.get(name, c.key);
			if (hit) {
				out[i] = { ...hit, recognizer: name };
				if (t) t.cacheHits++;
			} else todo.push(i);
		});
		// Sort by width so each batch pads little (PaddleOCR does the same).
		const widthOf = (i: number) => {
			const c = crops[i]?.crop;
			return c ? recWidth(c.width, c.height, 1e9) : 0;
		};
		todo.sort((a, b) => widthOf(a) - widthOf(b));
		const t0 = performance.now();
		for (let i = 0; i < todo.length; i += this.opts.recBatch) {
			if (cancelled?.()) throw new CancelledError("cancelled");
			const idx = todo.slice(i, i + this.opts.recBatch);
			const { data, width } = recBatch(
				idx.map((k) => (crops[k] as { crop: Raster }).crop),
				this.opts.recMaxWidth,
			);
			const input = { [rec.session.inputNames[0] ?? "x"]: this.#tensor(data, [idx.length, 3, REC_HEIGHT, width]) };
			const result = (await rec.session.run(input))[rec.session.outputNames[0] ?? ""];
			if (!result || !(result.data instanceof Float32Array)) throw new Error(`recogniser ${name} returned no output`);
			if (t) t.recRuns++;
			const [, T, C] = result.dims as [number, number, number];
			const probs = result.data;
			idx.forEach((k, j) => {
				const r = ctcDecode(probs, T, C, rec.charset, j * T * C);
				const reading: LineReading = {
					text: rec.rtl ? visualToLogicalRtl(r.text) : r.text,
					score: r.score,
					recognizer: name,
				};
				this.#cache.set(name, (crops[k] as { key: string }).key, { text: reading.text, score: reading.score });
				out[k] = reading;
			});
		}
		if (t) t.rec += performance.now() - t0;
		return out;
	}

	/**
	 * Recognise detected boxes. `candidates` is the plan from `planRecognizers` (first-pass
	 * first); every name in it must be loaded. Returns kept lines in `boxes` order.
	 */
	async recognize(
		img: Raster,
		boxes: readonly DetBox[],
		candidates: readonly OcrRecognizer[],
		options: RecognizeOptions = {},
	): Promise<EngineLine[]> {
		const { cancelled, onLine, timings: t } = options;
		const first = candidates[0];
		if (!first || boxes.length === 0) return [];
		const crops = boxes.map((b) => {
			const crop = cropQuad(img, b.quad);
			return { crop, key: this.#hash(crop) };
		});
		const readings = await this.#read(first, crops, cancelled, t);
		const final: (LineReading | null | undefined)[] = new Array(boxes.length);
		const emit = (i: number) => {
			const r = final[i];
			const box = boxes[i];
			if (!r || !box || r.score < this.opts.minTextScore || r.text.trim() === "") return;
			onLine?.(i, this.#line(i, box, r));
		};

		// Rule 3a: Latin text that looks like misread Cyrillic or Greek goes to that script's reader.
		if (candidates.length > 1) {
			const byReader = new Map<OcrRecognizer, number[]>();
			readings.forEach((r, i) => {
				const s = lookalikeReaderFor(r.text, first, candidates);
				if (s) byReader.set(s, [...(byReader.get(s) ?? []), i]);
			});
			for (const [name, idx] of byReader) {
				const again = await this.#read(
					name,
					idx.map((i) => crops[i] as { crop: Raster; key: string }),
					cancelled,
					t,
				);
				idx.forEach((i, j) => {
					readings[i] = preferLookalike(readings[i] as LineReading, again[j] as LineReading);
				});
			}
		}

		// Rule 3: re-read lines whose script has a specialist among the candidates.
		const bySpecialist = new Map<OcrRecognizer, number[]>();
		readings.forEach((r, i) => {
			const s = candidates.length > 1 ? specialistFor(r.text, r.recognizer, candidates) : null;
			if (s) bySpecialist.set(s, [...(bySpecialist.get(s) ?? []), i]);
			else if (r.score >= FALLBACK_SCORE || candidates.length === 1) {
				final[i] = r;
				emit(i);
			}
		});
		for (const [name, idx] of bySpecialist) {
			const again = await this.#read(
				name,
				idx.map((i) => crops[i] as { crop: Raster; key: string }),
				cancelled,
				t,
			);
			idx.forEach((i, j) => {
				const r = preferSpecialist(readings[i] as LineReading, again[j] as LineReading);
				if (r.score >= FALLBACK_SCORE) {
					final[i] = r;
					emit(i);
				} else readings[i] = r;
			});
		}

		// Rule 4: low scores try every other candidate; best score wins.
		const low = boxes.map((_, i) => i).filter((i) => final[i] === undefined);
		const alternatives = new Map<number, LineReading[]>(low.map((i) => [i, [readings[i] as LineReading]]));
		for (const name of candidates) {
			const idx = low.filter((i) => !alternatives.get(i)?.some((r) => r.recognizer === name));
			if (idx.length === 0) continue;
			const again = await this.#read(
				name,
				idx.map((i) => crops[i] as { crop: Raster; key: string }),
				cancelled,
				t,
			);
			idx.forEach((i, j) => {
				alternatives.get(i)?.push(again[j] as LineReading);
			});
		}
		for (const i of low) {
			final[i] = bestReading(alternatives.get(i) ?? []);
			emit(i);
		}

		const lines: EngineLine[] = [];
		final.forEach((r, i) => {
			const box = boxes[i];
			if (r && box && r.score >= this.opts.minTextScore && r.text.trim() !== "") {
				lines.push(this.#line(i, box, r));
			}
		});
		if (t) t.lines = lines.length;
		return lines;
	}

	#line(index: number, box: DetBox, r: LineReading): EngineLine {
		return {
			index,
			quad: box.quad,
			detScore: box.score,
			text: r.text.trim(),
			score: r.score,
			recognizer: r.recognizer,
			vertical: isTallQuad(box.quad),
		};
	}
}
