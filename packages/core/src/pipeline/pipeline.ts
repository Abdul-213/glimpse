// The core translation pipeline used by Snip and Live (GLIM-102):
//
//   capture -> OCR (boxes first, then text) -> block grouping -> per-block language
//   detection -> source-subset filter -> translation routing (pivot) -> per-block results
//
// Pure orchestration over ports (ARCHITECTURE.md §4): `CaptureSource`, `OcrProvider`, the
// translation provider chain, `BlockGrouper`, `BlockLanguageDetector`, a `TranslationCache` and
// a `Clock`. Progress is a typed event stream (events.ts) the popups render in order;
// every run ends with exactly one `done` event, unless it is cancelled (then it rejects
// with `ProviderError("cancelled")` and emits nothing more).
//
// Live mode reuses the same `run` per settled frame (see live.ts); `translate` is also
// called on its own for "Retry", "Translate these" and after a pack download lands.

import type { BlockLanguage, OcrBlock } from "../block.ts";
import { normaliseSegment } from "../cache/normalise.ts";
import type { TranslationCache } from "../cache/translation-cache.ts";
import { toOcrImage } from "../capture/compose.ts";
import { type CaptureSource, isCaptureError } from "../capture/port.ts";
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import { directionOf, sameLanguage } from "../language/lookup.ts";
import { abortable, ProviderError, type ProviderErrorInfo, throwIfAborted } from "../providers/errors.ts";
import type { ModelResource } from "../providers/lifecycle.ts";
import type { OcrImage, OcrProvider } from "../providers/ocr.ts";
import type { Provenance, ProviderRef } from "../providers/provenance.ts";
import {
	type PackRow,
	packMissingSummary,
	type SegmentFailureKind,
	type TranslationReadiness,
	translationReadiness,
} from "../providers/readiness.ts";
import type { TranslationProvider } from "../providers/translation.ts";
import type {
	BlockClass,
	BlockTranslation,
	PipelineError,
	PipelineErrorKind,
	PipelineEvent,
	PipelineListener,
	PipelineResult,
	RecognisedBlock,
} from "./events.ts";
import { type BlockGrouper, type BlockLanguageDetector, type Clock, identityGrouper, systemClock } from "./ports.ts";
import { scriptLanguageDetector } from "./script-detector.ts";
import { executeTranslation, planTranslation } from "./translate.ts";

export interface PipelineDeps {
	/** The selected OCR provider (read per run, so a settings change applies to the next run). */
	readonly ocr: () => OcrProvider | null;
	/** The translation chain in settings order (GLIM-43). */
	readonly chain: () => readonly TranslationProvider[];
	readonly grouper?: BlockGrouper;
	readonly detector?: BlockLanguageDetector;
	/**
	 * Download state of pairs that need packs (the app's `TranslationPacks.readiness`).
	 * Default: the chain's routing, with every missing pack reported as downloadable.
	 */
	readonly readinessOf?: (from: LanguageCode, to: LanguageCode) => TranslationReadiness;
	readonly clock?: Clock;
}

export interface RunOptions {
	readonly mode: "snip" | "live";
	readonly target: LanguageCode;
	/** Source-language subset; empty = every language. */
	readonly sources: readonly LanguageCode[];
	/** Which cache this run reads and writes (`TranslationCaches.forSnip` / a Live session's). */
	readonly cache: TranslationCache;
	readonly private: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: PipelineListener;
	/** Defaults to a fresh id. */
	readonly runId?: string;
	/** Live: only OCR these image-space areas (changed regions, GLIM-67). */
	readonly regions?: readonly Rect[];
	/** Live: the session's detection memo (GLIM-21 rule 5a). */
	readonly memo?: Map<string, BlockLanguage>;
	/**
	 * Live: re-ids grouped blocks so a block keeps its id across frames (GLIM-56
	 * `BlockIdTracker`); the popup updates blocks in place and detection hysteresis keys on it.
	 */
	readonly blockIds?: { assign(blocks: readonly OcrBlock[]): readonly OcrBlock[] };
	/**
	 * Live, "Use on-device" at the cloud consent (live-popup.md L10): cloud translators are left
	 * out of the chain for this run. (Cloud OCR has no local stand-in yet; Live doesn't offer
	 * this answer when the OCR provider is a cloud one.)
	 */
	readonly localOnly?: boolean;
}

export interface BlockTranslateOptions extends Omit<RunOptions, "regions" | "memo" | "blockIds" | "mode"> {
	readonly mode?: "snip" | "live";
	/** "Retranslate": skip cached entries and overwrite them. */
	readonly bypassCache?: boolean;
	/** "Translate these": also translate skipped blocks whose language is known. */
	readonly includeSkipped?: boolean;
	/**
	 * "Translate on this device" (E3, GLIM-80): route through the chain's local providers only,
	 * for this call. Settings are unchanged.
	 */
	readonly localOnly?: boolean;
}

export interface TranslateResult {
	readonly translations: Readonly<Record<string, BlockTranslation>>;
	readonly packs: readonly PackRow[];
	readonly done: number;
	readonly total: number;
	readonly translators: readonly Provenance[];
}

const defaultReadiness =
	(chain: () => readonly TranslationProvider[]) =>
	(from: LanguageCode, to: LanguageCode): TranslationReadiness =>
		translationReadiness(chain(), from, to, (missing: readonly ModelResource[]) => ({
			kind: "needs-download",
			ids: missing.map((m) => m.id),
			bytes: missing.reduce((n, m) => n + (m.bytes ?? 0), 0),
		}));

/** GLIM-21 decision + subset + target -> the popup's block class. */
export function classifyBlock(
	language: BlockLanguage,
	sources: readonly LanguageCode[],
	target: LanguageCode,
): { readonly cls: BlockClass; readonly lang: LanguageCode | null } {
	if (language.kind === "neutral") return { cls: "neutral", lang: null };
	if (language.kind === "skipped") return { cls: "skip", lang: language.lang };
	const { lang } = language;
	if (sameLanguage(lang, target)) return { cls: "target", lang };
	if (sources.length > 0 && !sources.some((s) => sameLanguage(s, lang))) return { cls: "skip", lang };
	return { cls: "translate", lang };
}

/** True when every pixel is black (protected video, some fullscreen games): E4 "captureBlank". */
export function isBlankImage(image: { readonly data: Uint8Array }): boolean {
	const { data } = image;
	for (let i = 0; i < data.length; i += 4) {
		if ((data[i] ?? 0) > 2 || (data[i + 1] ?? 0) > 2 || (data[i + 2] ?? 0) > 2) return false;
	}
	return true;
}

const PROVIDER_ERROR_KINDS: ReadonlySet<SegmentFailureKind> = new Set([
	"providerKey",
	"providerQuota",
	"providerTimeout",
	"offline",
]);

let runCounter = 0;
const newRunId = () => `run-${Date.now().toString(36)}-${(++runCounter).toString(36)}`;

export class TranslationPipeline {
	readonly #deps: PipelineDeps;
	readonly #grouper: BlockGrouper;
	readonly #detector: BlockLanguageDetector;
	readonly #clock: Clock;
	readonly #readinessOf: (from: LanguageCode, to: LanguageCode) => TranslationReadiness;

	constructor(deps: PipelineDeps) {
		this.#deps = deps;
		this.#grouper = deps.grouper ?? identityGrouper;
		this.#detector = deps.detector ?? scriptLanguageDetector();
		this.#clock = deps.clock ?? systemClock;
		this.#readinessOf = deps.readinessOf ?? defaultReadiness(deps.chain);
	}

	/** Snip: capture `rect` (global logical), then `run`. Capture failures end the run with E4. */
	async snip(
		capture: Pick<CaptureSource, "capture">,
		rect: Rect,
		options: Omit<RunOptions, "mode">,
	): Promise<PipelineResult> {
		const runId = options.runId ?? newRunId();
		const opts: RunOptions = { ...options, mode: "snip", runId };
		const started = this.#clock.now();
		this.#started(opts);
		let frame: Awaited<ReturnType<CaptureSource["capture"]>>;
		try {
			frame = await abortable(capture.capture(rect), options.signal);
		} catch (error) {
			if (ProviderError.from(error).code === "cancelled" && options.signal?.aborted) throw error;
			const kind: PipelineErrorKind =
				isCaptureError(error) && error.code === "permission-denied" ? "screenAccess" : "captureFailed";
			const message = isCaptureError(error) ? `${error.code}: ${error.message}` : String(error);
			return this.#finish(opts, started, { blocks: [], error: { kind, message } });
		}
		if (isBlankImage(frame)) {
			return this.#finish(opts, started, { blocks: [], error: { kind: "captureBlank", message: "all-black capture" } });
		}
		return this.#process(toOcrImage(frame), opts, started);
	}

	/** One frame (Snip after capture, or a settled Live frame). */
	async run(image: OcrImage, options: RunOptions): Promise<PipelineResult> {
		const opts: RunOptions = { ...options, runId: options.runId ?? newRunId() };
		const started = this.#clock.now();
		this.#started(opts);
		return this.#process(image, opts, started);
	}

	/**
	 * Translate already-recognised blocks: "Retry" (with `bypassCache`), "Translate these"
	 * (`includeSkipped`), or the blocks that were waiting when their pack lands. Emits
	 * `packs`, `translation` and `progress` events with `options.runId`.
	 */
	async translate(blocks: readonly RecognisedBlock[], options: BlockTranslateOptions): Promise<TranslateResult> {
		const runId = options.runId ?? newRunId();
		const emit = (event: PipelineEvent) => {
			if (!options.signal?.aborted) options.onEvent?.(event);
		};
		const candidates = options.includeSkipped
			? blocks.map((b) => (b.cls === "skip" && b.lang ? { ...b, cls: "translate" as const, waitingForPack: false } : b))
			: blocks;
		const chain = options.localOnly ? this.#deps.chain().filter((p) => p.info.kind === "local") : this.#deps.chain();
		const plan = planTranslation({
			blocks: candidates,
			to: options.target,
			chain,
			readinessOf: options.localOnly && !this.#deps.readinessOf ? defaultReadiness(() => chain) : this.#readinessOf,
		});
		if (plan.packs.length > 0) emit({ type: "packs", runId, rows: plan.packs });
		const total = plan.routed.length + plan.unsupported.length;
		let done = 0;
		const progress = () => emit({ type: "progress", runId, done, total });
		const translations: Record<string, BlockTranslation> = {};
		for (const failed of plan.unsupported) {
			translations[failed.blockId] = failed;
			done++;
			emit({ type: "translation", runId, translation: failed });
		}
		if (total > 0) progress();
		const results = await executeTranslation(plan, {
			cache: options.cache,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.bypassCache ? { bypassCache: true } : {}),
			now: () => this.#clock.now(),
			emit: (translation) => {
				emit({ type: "translation", runId, translation });
				if (translation.final) {
					done++;
					progress();
				}
			},
		});
		throwIfAborted(options.signal);
		for (const [id, t] of results) translations[id] = t;
		const translators = new Map<string, Provenance>();
		for (const t of results.values()) {
			if (t.provider && !t.failure) {
				const key = `${t.provider.id}|${t.provider.remembered ? 1 : 0}`;
				if (!translators.has(key)) translators.set(key, t.provider);
			}
		}
		return { translations, packs: plan.packs, done, total, translators: [...translators.values()] };
	}

	/** The translation chain for a run: without cloud providers when `localOnly` (Live "Use on-device"). */
	#chainFor(opts: { readonly localOnly?: boolean }): readonly TranslationProvider[] {
		const chain = this.#deps.chain();
		return opts.localOnly ? chain.filter((p) => p.info.kind !== "cloud") : chain;
	}

	#started(opts: RunOptions): void {
		const ocr = this.#deps.ocr();
		const translation = this.#chainFor(opts).find((p) => p.status.state === "ready") ?? null;
		const ref = (p: { info: ProviderRef } | null): ProviderRef | null =>
			p ? { id: p.info.id, kind: p.info.kind, name: p.info.name } : null;
		this.#emit(opts, {
			type: "started",
			runId: opts.runId as string,
			mode: opts.mode,
			target: opts.target,
			private: opts.private,
			ocr: ref(ocr),
			translation: ref(translation),
		});
	}

	#emit(opts: RunOptions, event: PipelineEvent): void {
		if (!opts.signal?.aborted) opts.onEvent?.(event);
	}

	async #process(image: OcrImage, opts: RunOptions, started: number): Promise<PipelineResult> {
		const runId = opts.runId as string;
		const { signal } = opts;
		throwIfAborted(signal);
		const ocr = this.#deps.ocr();
		if (!ocr) {
			return this.#finish(opts, started, {
				blocks: [],
				error: { kind: "ocrFailed", message: "no OCR provider is selected" },
			});
		}

		// 1. OCR: boxes first (progressive providers), then the blocks.
		let detectedSent = false;
		let lines: readonly OcrBlock[];
		let ocrProvenance: Provenance;
		const ocrStart = this.#clock.now();
		try {
			const result = await ocr.recognise(
				{ image, languages: opts.sources, ...(opts.regions ? { regions: opts.regions } : {}) },
				{
					...(signal ? { signal } : {}),
					onProgress: (event) => {
						if (event.type !== "detected" || detectedSent) return;
						detectedSent = true;
						this.#emit(opts, {
							type: "detected",
							runId,
							image: { width: image.width, height: image.height },
							boxes: event.boxes.map((box, i) => ({ id: `box-${i}`, box })),
						});
					},
				},
			);
			lines = result.blocks;
			ocrProvenance = result.provider;
		} catch (error) {
			const e = ProviderError.from(error, ocr.info.id);
			if (e.code === "cancelled") throw e;
			return this.#finish(opts, started, {
				blocks: [],
				error: { kind: "ocrFailed", message: e.message, error: e.toInfo() },
			});
		}
		const ocrMs = this.#clock.now() - ocrStart;
		throwIfAborted(signal);
		if (!detectedSent) {
			this.#emit(opts, {
				type: "detected",
				runId,
				image: { width: image.width, height: image.height },
				boxes: lines.map((b) => ({ id: b.id, box: b.box })),
			});
		}

		// 2. Grouping and 3. language detection.
		const ordered = this.#grouper.group(lines, image);
		const grouped = opts.blockIds ? opts.blockIds.assign(ordered) : ordered;
		const memo = opts.memo;
		const decisions = await this.#detector.detect(grouped, {
			sources: opts.sources,
			target: opts.target,
			mode: opts.mode,
			...(memo ? { memo } : {}),
		});
		throwIfAborted(signal);
		const blocks: RecognisedBlock[] = grouped.map((b, order) => {
			const language: BlockLanguage = decisions[order] ?? { kind: "skipped", lang: null, confidence: 0 };
			if (memo) memo.set(normaliseSegment(b.text), language);
			const { cls, lang } = classifyBlock(language, opts.sources, opts.target);
			return {
				id: b.id,
				order,
				box: b.box,
				text: b.text,
				confidence: b.confidence,
				language,
				lang,
				cls,
				direction: lang ? directionOf(lang) : "ltr",
				waitingForPack: false,
			};
		});

		// Readiness before rendering, so pack-waiting blocks are marked in `recognised`.
		const translateStart = this.#clock.now();
		const plan = planTranslation({
			blocks,
			to: opts.target,
			chain: this.#chainFor(opts),
			readinessOf: this.#readinessOf,
		});
		const marked = blocks.map((b) => (plan.waiting.has(b.id) ? { ...b, waitingForPack: true } : b));
		this.#emit(opts, { type: "recognised", runId, blocks: marked });
		if (marked.length === 0) {
			return this.#finish(opts, started, {
				blocks: marked,
				ocr: ocrProvenance,
				error: { kind: "noText", message: "no text found" },
				ocrMs,
			});
		}

		// 4. Translation (pack rows, cache hits, provider batches).
		const translated = await this.translate(marked, { ...opts, runId });
		const translateMs = this.#clock.now() - translateStart;
		return this.#finish(opts, started, {
			blocks: marked,
			ocr: ocrProvenance,
			translated,
			ocrMs,
			translateMs,
		});
	}

	#finish(
		opts: RunOptions,
		started: number,
		parts: {
			readonly blocks: readonly RecognisedBlock[];
			readonly error?: PipelineError;
			readonly ocr?: Provenance;
			readonly translated?: TranslateResult;
			readonly ocrMs?: number;
			readonly translateMs?: number;
		},
	): PipelineResult {
		throwIfAborted(opts.signal);
		const { blocks, translated } = parts;
		const translations = translated?.translations ?? {};
		const packs = translated?.packs ?? [];
		const error = parts.error ?? runError(blocks, translations, packs);
		const translators = translated?.translators ?? [];
		const result: PipelineResult = {
			runId: opts.runId as string,
			mode: opts.mode,
			target: opts.target,
			blocks,
			translations,
			packs,
			done: translated?.done ?? 0,
			total: translated?.total ?? 0,
			error,
			ocr: parts.ocr ?? null,
			translators,
			cloud: parts.ocr?.kind === "cloud" || translators.some((t) => t.kind === "cloud"),
			private: opts.private,
			timings: {
				ocrMs: parts.ocrMs ?? 0,
				translateMs: parts.translateMs ?? 0,
				totalMs: this.#clock.now() - started,
			},
		};
		this.#emit(opts, { type: "done", runId: result.runId, result });
		return result;
	}
}

/** The whole-run error state for a finished run (snip-popup.md §4), or null. */
export function runError(
	blocks: readonly RecognisedBlock[],
	translations: Readonly<Record<string, BlockTranslation>>,
	packs: readonly PackRow[],
): PipelineError | null {
	if (blocks.length === 0) return { kind: "noText", message: "no text found" };
	const count = (cls: BlockClass) => blocks.filter((b) => b.cls === cls).length;
	const translate = count("translate");
	if (translate === 0) {
		return count("target") === 0 && count("skip") > 0
			? { kind: "nothingToTranslate", message: "every block is outside the source languages" }
			: null;
	}
	if (packMissingSummary(packs, translate)) {
		return { kind: "packMissing", message: `waiting for ${packs.map((p) => p.lang).join(", ")}` };
	}
	const results = Object.values(translations);
	if (results.length > 0 && results.length === translate && results.every((t) => t.failure)) {
		const kinds = new Set(results.map((t) => t.failure?.kind));
		const [only] = kinds;
		if (kinds.size === 1 && only && PROVIDER_ERROR_KINDS.has(only)) {
			const error = results[0]?.failure?.error as ProviderErrorInfo;
			return { kind: only as PipelineErrorKind, message: error.message, error };
		}
	}
	return null;
}
