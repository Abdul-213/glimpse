// Headless harness (GLIM-86): drives the main-process capture service (and, as later
// tickets land, the OCR -> language -> translation pipeline) without Electrobun or a
// webview, so Snip and Live flows run end to end on Linux and in CI.
//
// Stages are the extension point: a stage gets every captured frame and returns plain
// data for the report. GLIM-48 / GLIM-56 / GLIM-58 add OCR, detection, translation and
// change-detection stages here; today the harness reports what capture produced.
import {
	type CaptureFrame,
	type CaptureSource,
	collectTranslations,
	type LanguageCode,
	type OcrProvider,
	type Rect,
	rgbaHash,
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
	readonly translation: string | null;
	readonly error: string | null;
}

export interface PipelineStageOptions {
	readonly ocr: OcrProvider;
	/** Language detection (GLIM-39 supplies the real one). Null: leave the block untranslated. */
	readonly detect: (text: string) => LanguageCode | null;
	readonly translation: TranslationProvider;
	readonly to: LanguageCode;
}

/**
 * The text pipeline as a harness stage: frame -> OCR -> language detection -> translation
 * -> blocks. A stand-in until the core pipeline (GLIM-48) exists; then the harness runs that
 * instead, through the same stage hook.
 */
export function pipelineStage(options: PipelineStageOptions): HarnessStage {
	return {
		name: "pipeline",
		async run(frame): Promise<{ blocks: PipelineBlock[] }> {
			const { blocks } = await options.ocr.recognise({ image: toOcrImage(frame) });
			const detected = blocks.map((b) => ({ block: b, from: options.detect(b.text) }));
			const segments = detected.flatMap(({ block, from }) =>
				from && from !== options.to ? [{ id: block.id, text: block.text, from }] : [],
			);
			const outcomes =
				segments.length > 0 ? await collectTranslations(options.translation, { segments, to: options.to }) : new Map();
			return {
				blocks: detected.map(({ block, from }) => {
					const outcome = outcomes.get(block.id);
					return {
						id: block.id,
						box: block.box,
						text: block.text,
						from,
						translation: outcome?.ok ? outcome.translation.text : from === options.to ? block.text : null,
						error: outcome && !outcome.ok ? outcome.error.message : null,
					};
				}),
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
