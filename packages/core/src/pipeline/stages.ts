// GLIM-109: the real grouping (GLIM-56) and language detection (GLIM-49) behind the pipeline's
// narrow ports (ports.ts).
//
// - `lineGrouper`: OCR lines -> blocks with `groupLines`. Engines that already group (PaddleOCR
//   in its default `blocks` mode returns blocks with `lines`) pass through unchanged, so
//   grouping happens exactly once whichever engine is selected.
// - `glim21Detector`: the GLIM-21 rules (`detectCaptureLanguages`) over an injected detector
//   library (ELD), chosen per source subset with `planDetector`. Snip decides each capture on
//   its own. Live keeps one `LanguageDetectionSession` per session (text cache, rule 5a, and
//   per-block hysteresis keyed by the stable block ids `BlockIdTracker` assigns), found through
//   the identity of the session's `memo` map: `LivePipelineSession` replaces the memo when the
//   subset changes, which drops the decisions that depended on it.

import type { BlockLanguage, OcrBlock, OcrLine } from "../block.ts";
import { type DetectOptions, detectCaptureLanguages } from "../language/detect/decide.ts";
import { type LanguageDetector, planDetector } from "../language/detect/detector.ts";
import { LanguageDetectionSession } from "../language/detect/session.ts";
import { type GroupOptions, groupLines } from "./group-lines.ts";
import type { BlockGrouper, BlockLanguageDetector, DetectionContext } from "./ports.ts";

/** Engine blocks without `lines` are lines to group; blocks with `lines` are already grouped. */
export function lineGrouper(options: Partial<GroupOptions> = {}): BlockGrouper {
	return {
		id: "glim-56",
		group(blocks) {
			if (blocks.every((b) => b.lines !== undefined)) return blocks;
			const grouped = blocks.filter((b) => b.lines !== undefined);
			const lines = blocks
				.filter((b) => b.lines === undefined)
				.map(
					(b): OcrLine => ({
						box: b.box,
						text: b.text,
						confidence: b.confidence,
						...(b.writing ? { vertical: b.writing === "vertical-rl" } : {}),
					}),
				);
			if (grouped.length === 0) return groupLines(lines, options);
			// Mixed (unusual): keep the engine's blocks first, then ours, with ids that can't clash.
			const taken = new Set(grouped.map((b) => b.id));
			let prefix = options.idPrefix ?? "g";
			while ([...taken].some((id) => id.startsWith(prefix))) prefix += "g";
			return [...grouped, ...groupLines(lines, { ...options, idPrefix: prefix })];
		},
	};
}

/** Overrides for every detector (tests, the harness); a detector's own `tuning` sits under these. */
export type DetectThresholds = Partial<Omit<DetectOptions, "subset" | "target" | "detector">>;

export interface Glim21DetectorOptions {
	/**
	 * Detector libraries in preference order (ELD before fastText, GLIM-21), or a loader for
	 * them (ELD's database loads on first use). Empty or failed: the script rules alone.
	 */
	readonly detectors: readonly LanguageDetector[] | (() => Promise<readonly LanguageDetector[]>);
	/** Thresholds (tau, minLetters, dominance, minOcrConfidence); GLIM-21 defaults otherwise. */
	readonly tuning?: DetectThresholds;
	/** Live text-cache size per session. */
	readonly maxEntries?: number;
	/** The loader failed (reported once; detection goes on with the script rules). */
	readonly onLoadError?: (error: unknown) => void;
}

interface LiveState {
	readonly key: string;
	readonly session: LanguageDetectionSession;
}

const SKIPPED: BlockLanguage = { kind: "skipped", lang: null, confidence: 0 };

export interface Glim21Detector extends BlockLanguageDetector {
	/** Load the detector libraries now (in the background after startup, so Snip doesn't wait). */
	load(): Promise<void>;
	/**
	 * Drop the loaded list so the next detection (or `load()`) asks the loader again: a detector
	 * model was downloaded or removed (fastText, GLIM-104). Detections already running finish
	 * with the old list.
	 */
	invalidate(): void;
}

/** The GLIM-49 detector as the pipeline's `BlockLanguageDetector`. */
export function glim21Detector(options: Glim21DetectorOptions): Glim21Detector {
	const { detectors } = options;
	let loaded: readonly LanguageDetector[] | null = typeof detectors === "function" ? null : detectors;
	let loading: Promise<readonly LanguageDetector[]> | null = null;
	const load = (): readonly LanguageDetector[] | Promise<readonly LanguageDetector[]> => {
		if (loaded) return loaded;
		if (typeof detectors !== "function") return detectors;
		const run = detectors()
			.catch((error: unknown): readonly LanguageDetector[] => {
				options.onLoadError?.(error);
				return [];
			})
			.then((list) => {
				// An invalidate() while this ran started a newer load: that one wins.
				if (loading === run) loaded = list;
				return list;
			});
		loading ??= run;
		return loading;
	};
	// One detection session per Live session (keyed by its memo map), dropped with it.
	const live = new WeakMap<object, LiveState>();

	const decide = (
		blocks: readonly OcrBlock[],
		ctx: DetectionContext,
		libraries: readonly LanguageDetector[],
	): BlockLanguage[] => {
		const { detector } = planDetector(ctx.sources, libraries);
		// OCR language hints (Vision's detectedLanguages) go in as a prior (GLIM-22, GLIM-60).
		const inputs = blocks.map((b) => ({
			id: b.id,
			text: b.text,
			confidence: b.confidence,
			...(b.languageHints && b.languageHints.length > 0 ? { hints: b.languageHints } : {}),
		}));
		// The block's language doesn't depend on the target (only GLIM-49's `translate` flag
		// does, and the pipeline classifies target blocks itself), so a target change keeps
		// the Live session's decisions.
		const base = { ...options.tuning, subset: ctx.sources, target: null, detector };
		let decisions: Map<string, { readonly language: BlockLanguage }>;
		if (ctx.mode === "live" && ctx.memo) {
			const key = `${detector?.id ?? "script"}|${ctx.sources.join(",")}`;
			let state = live.get(ctx.memo);
			if (!state || state.key !== key) {
				state = {
					key,
					session: new LanguageDetectionSession({
						...base,
						...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
					}),
				};
				live.set(ctx.memo, state);
			}
			decisions = state.session.detect(inputs);
		} else {
			decisions = detectCaptureLanguages(inputs, base);
		}
		return blocks.map((b) => decisions.get(b.id)?.language ?? SKIPPED);
	};

	return {
		id: "glim-21",
		load: async () => {
			await load();
		},
		invalidate() {
			if (typeof detectors !== "function") return;
			loaded = null;
			loading = null;
		},
		detect(blocks, ctx) {
			const libraries = load();
			return Array.isArray(libraries)
				? decide(blocks, ctx, libraries as readonly LanguageDetector[])
				: (libraries as Promise<readonly LanguageDetector[]>).then((list) => decide(blocks, ctx, list));
		},
	};
}
