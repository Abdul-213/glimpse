// Headless harness (GLIM-86): drives the main-process capture service (and, as later
// tickets land, the OCR -> language -> translation pipeline) without Electrobun or a
// webview, so Snip and Live flows run end to end on Linux and in CI.
//
// Stages are the extension point: a stage gets every captured frame and returns plain
// data for the report. `pipelineStage` runs the core pipeline (GLIM-102: OCR, grouping,
// detection, cache, translation); change detection (GLIM-58) plugs in the same way.
import {
	type BlockClass,
	type BlockGrouper,
	type BlockLanguageDetector,
	type CaptureFrame,
	type CaptureSource,
	functionDetector,
	type LanguageCode,
	type OcrProvider,
	type PipelineErrorKind,
	type PipelineListener,
	type PipelineResult,
	type Rect,
	rgbaHash,
	TranslationCache,
	TranslationPipeline,
	type TranslationProvider,
	toOcrImage,
} from "@glimpse/core";

/** One block of a pipeline run, as the harness reports it. */
export interface PipelineBlock {
	readonly id: string;
	readonly box: Rect;
	readonly text: string;
	/** Detected source language, or null when the detector gave none (block not translated). */
	readonly from: LanguageCode | null;
	/** GLIM-21 class: translate / skip / neutral / target. */
	readonly cls: BlockClass;
	/** The translation, the text itself for target-language blocks, else null. */
	readonly translation: string | null;
	readonly error: string | null;
	/** Served entirely from the translation cache. */
	readonly remembered: boolean;
	readonly provider: string | null;
}

export interface PipelineStageReport {
	readonly blocks: PipelineBlock[];
	/** Whole-run error kind (snip-popup.md E1-E7), or null. */
	readonly error: PipelineErrorKind | null;
	/** Event types in order, consecutive repeats collapsed (`translation x3`). */
	readonly events: string[];
	readonly done: number;
	readonly total: number;
	readonly cloud: boolean;
	readonly timings: PipelineResult["timings"];
}

export interface PipelineStageOptions {
	readonly ocr: OcrProvider;
	/**
	 * Language detection: a `BlockLanguageDetector` (GLIM-109 adapts the GLIM-49 one) or a per-text
	 * function (null: leave the block untranslated). Default: core's script-table detector.
	 */
	readonly detect?: BlockLanguageDetector | ((text: string) => LanguageCode | null);
	/** The translation chain (or one provider). */
	readonly translation: TranslationProvider | readonly TranslationProvider[];
	readonly to: LanguageCode;
	readonly sources?: readonly LanguageCode[];
	/** Shared across frames (default: one app-wide cache for the stage's life). */
	readonly cache?: TranslationCache;
	readonly private?: boolean;
	readonly grouper?: BlockGrouper;
	/** Every pipeline event (for tests and --json). */
	readonly onEvent?: PipelineListener;
}

/**
 * The core pipeline (GLIM-102) as a harness stage: frame -> OCR -> grouping -> language
 * detection -> cache / translation -> blocks.
 */
export function pipelineStage(options: PipelineStageOptions): HarnessStage {
	const chain: readonly TranslationProvider[] = Array.isArray(options.translation)
		? options.translation
		: [options.translation as TranslationProvider];
	const detect = options.detect;
	const detector = typeof detect === "function" ? functionDetector(detect) : detect;
	const pipeline = new TranslationPipeline({
		ocr: () => options.ocr,
		chain: () => chain,
		...(detector ? { detector } : {}),
		...(options.grouper ? { grouper: options.grouper } : {}),
	});
	const cache = options.cache ?? new TranslationCache({ name: "harness" });
	return {
		name: "pipeline",
		async run(frame, ctx): Promise<PipelineStageReport> {
			const events: string[] = [];
			let last = "";
			let repeat = 1;
			const result = await pipeline.run(toOcrImage(frame), {
				mode: ctx.mode,
				target: options.to,
				sources: options.sources ?? [],
				cache,
				private: options.private ?? false,
				onEvent: (event) => {
					options.onEvent?.(event);
					if (event.type === last) {
						repeat++;
						events[events.length - 1] = `${event.type} x${repeat}`;
					} else {
						last = event.type;
						repeat = 1;
						events.push(event.type);
					}
				},
			});
			return {
				blocks: result.blocks.map((b): PipelineBlock => {
					const t = result.translations[b.id];
					return {
						id: b.id,
						box: b.box,
						text: b.text,
						from: b.lang,
						cls: b.cls,
						translation: t && !t.failure ? t.text : b.cls === "target" ? b.text : null,
						error: t?.failure ? `${t.failure.kind}: ${t.failure.error.message}` : null,
						remembered: t?.provider?.remembered === true,
						provider: t?.provider?.id ?? null,
					};
				}),
				error: result.error?.kind ?? null,
				events,
				done: result.done,
				total: result.total,
				cloud: result.cloud,
				timings: result.timings,
			};
		},
	};
}

export interface HarnessStage {
	readonly name: string;
	run(frame: CaptureFrame, context: StageContext): Promise<unknown> | unknown;
}

export interface StageContext {
	readonly mode: "snip" | "live";
	readonly index: number;
	/** The previous frame of this Live run (null for Snip and the first Live frame). */
	readonly previous: CaptureFrame | null;
}

export interface FrameReport {
	readonly index: number;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly partial: boolean;
	readonly displayIds: readonly number[];
	readonly sequence: number;
	/** The backend reported new content (sequence moved, or first frame). */
	readonly sequenceChanged: boolean;
	/** FNV-1a of the pixels, to cross-check `sequenceChanged`. */
	readonly hash: string;
	readonly pixelsChanged: boolean;
	/** Capture latency. */
	readonly ms: number;
	readonly stages: Readonly<Record<string, unknown>>;
}

export interface SnipReport {
	readonly mode: "snip";
	readonly backend: string;
	readonly rect: Rect;
	readonly frame: FrameReport;
}

export interface LiveReport {
	readonly mode: "live";
	readonly backend: string;
	readonly rect: Rect;
	readonly fps: number;
	readonly frames: readonly FrameReport[];
	readonly summary: { readonly captured: number; readonly changed: number; readonly unchanged: number };
}

export interface RunOptions {
	readonly scale?: number;
	readonly stages?: readonly HarnessStage[];
	/** Called with every frame (the CLI saves PNGs here). */
	readonly onFrame?: (frame: CaptureFrame, report: FrameReport) => void | Promise<void>;
	/** performance.now-style clock for latency. */
	readonly clock?: () => number;
}

export interface LiveOptions extends RunOptions {
	readonly fps: number;
	readonly count: number;
	/** Sleep 1000/fps ms between frames (real Live timing). Default: back to back. */
	readonly realtime?: boolean;
	readonly sleep?: (ms: number) => Promise<void>;
}

const hex = (n: number) => n.toString(16).padStart(8, "0");

async function report(
	frame: CaptureFrame,
	ms: number,
	ctx: StageContext,
	previous: CaptureFrame | null,
	stages: readonly HarnessStage[],
): Promise<FrameReport> {
	const results: Record<string, unknown> = {};
	for (const stage of stages) results[stage.name] = await stage.run(frame, ctx);
	const hash = rgbaHash(frame);
	return {
		index: ctx.index,
		width: frame.width,
		height: frame.height,
		scale: frame.scale,
		partial: frame.partial,
		displayIds: frame.displayIds,
		sequence: frame.sequence,
		sequenceChanged: previous === null || previous.sequence !== frame.sequence,
		hash: hex(hash),
		pixelsChanged: previous === null || rgbaHash(previous) !== hash,
		ms: Math.round(ms * 100) / 100,
		stages: results,
	};
}

/** One Snip: a single capture of `rect` run through the stages. */
export async function runSnip(source: CaptureSource, rect: Rect, options: RunOptions = {}): Promise<SnipReport> {
	const clock = options.clock ?? (() => performance.now());
	const t0 = clock();
	const frame = await source.capture(rect, options.scale === undefined ? {} : { scale: options.scale });
	const ms = clock() - t0;
	const r = await report(frame, ms, { mode: "snip", index: 0, previous: null }, null, options.stages ?? []);
	await options.onFrame?.(frame, r);
	return { mode: "snip", backend: source.backend, rect, frame: r };
}

/** A Live run: open a session on `rect` and pull `count` frames. */
export async function runLive(source: CaptureSource, rect: Rect, options: LiveOptions): Promise<LiveReport> {
	const clock = options.clock ?? (() => performance.now());
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const session = await source.openSession(rect, {
		fps: options.fps,
		...(options.scale === undefined ? {} : { scale: options.scale }),
	});
	const frames: FrameReport[] = [];
	let previous: CaptureFrame | null = null;
	try {
		for (let i = 0; i < options.count; i++) {
			if (i > 0 && options.realtime) await sleep(1000 / options.fps);
			const t0 = clock();
			const frame = await session.next();
			const ms = clock() - t0;
			const r = await report(frame, ms, { mode: "live", index: i, previous }, previous, options.stages ?? []);
			frames.push(r);
			await options.onFrame?.(frame, r);
			previous = frame;
		}
	} finally {
		session.close();
	}
	const changed = frames.filter((f) => f.sequenceChanged).length;
	return {
		mode: "live",
		backend: source.backend,
		rect,
		fps: options.fps,
		frames,
		summary: { captured: frames.length, changed, unchanged: frames.length - changed },
	};
}
