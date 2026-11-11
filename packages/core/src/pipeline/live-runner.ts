// One pinned Live region, end to end in core: capture loop (GLIM-48) -> change detection
// (GLIM-58) -> frame ring (GLIM-20) -> pipeline (`LivePipelineSession`, latest wins) -> block
// diff (live-popup.md §5) -> typed `LiveSessionEvent`s. Pure over ports: a frame source, timers
// and a processor; the app's LiveService (GLIM-59) opens the capture session and wires
// commands, tray, the pinned frame and lock/sleep.
//
// OCR runs only for the first frame and for frames change detection calls settled. A settled
// frame identical to one of the last 8 read (A -> B -> A) reuses that result instead.
//
// GLIM-157: an unchanged page makes no visible update. Pixels can change without the text
// changing (a hover highlight, an animation next to the text): the frame is read again, but
// when its text is the same (live-diff.ts `liveTextKey`: OCR jitter in punctuation, spacing or
// case doesn't count) no `frame` event goes out, no streamed translation for a block that is
// already translated, and no "Updating". "Only when I refresh" (`update: "manual"`): after the
// first read nothing is captured until `refresh()`.
//
// Timings (live-popup.md §8): "Updating" after 1 s of translating changed text (at once for a
// manual Refresh); "empty"
// after 5 s without text (shorter gaps keep the last blocks); pause / resume / stop at once;
// resume compares with the processed frame immediately, so what changed while paused is one
// change set and nothing seen while paused is replayed.

import { normaliseSegment } from "../cache/normalise.ts";
import { toOcrImage } from "../capture/compose.ts";
import type { CaptureFrame } from "../capture/port.ts";
import type { Rect } from "../geometry.ts";
import { diffLiveBlocks, type LiveBlock, type LiveBlockInput, type LiveBlockUpdate } from "../popup/live-diff.ts";
import type { OcrImage } from "../providers/ocr.ts";
import type { PackRow } from "../providers/readiness.ts";
import { type ChangeDecision, ChangeDetector, shouldProcess } from "./change-detection.ts";
import type { BlockTranslation, PipelineEvent, PipelineListener, PipelineResult, RecognisedBlock } from "./events.ts";
import { FrameRing, frameKey } from "./frame-ring.ts";
import { LIVE_QUIET_FOCUS, LiveBudget, type LiveBudgetOptions, type LiveBudgetState } from "./live-budget.ts";
import type {
	LiveError,
	LiveErrorKind,
	LivePauseReason,
	LiveSessionListener,
	LiveStatus,
	LiveTrace,
} from "./live-events.ts";
import {
	type LiveCaptureFailure,
	LiveCaptureLoop,
	type LiveFrameSource,
	type LiveTickInfo,
	type Timers,
} from "./live-loop.ts";
import { isBlankImage } from "./pipeline.ts";

/** What the runner needs from the pipeline (`LivePipelineSession` satisfies it). */
export interface LiveProcessor {
	/** Run one settled frame; null when a newer frame superseded it. */
	process(image: OcrImage, options: { readonly onEvent: PipelineListener }): Promise<PipelineResult | null>;
}

export interface LiveSettingsParams {
	readonly fps: number;
	readonly diffThreshold: number;
	readonly stabilityMs: number;
	/**
	 * GLIM-157, Settings › Live › Update: `text` (default) reads the region again whenever its
	 * pixels change and shows only text changes; `manual` reads it only on `refresh()`.
	 */
	readonly update?: LiveUpdateMode;
}

export type LiveUpdateMode = "text" | "manual";

export interface LiveRunnerOptions extends LiveSettingsParams {
	readonly sessionId: string;
	/** The pinned region, global logical (echoed in `frame` events). */
	readonly region: Rect;
	readonly source: LiveFrameSource;
	readonly timers: Timers;
	readonly processor: LiveProcessor;
	readonly onEvent: LiveSessionListener;
	readonly onTrace?: (trace: LiveTrace) => void;
	/**
	 * GLIM-67: one OCR run's translation reuse, once it finished. `cached` blocks had every
	 * sentence served by the translation cache (no provider call); the app logs the hit rate
	 * at debug level. Counts only, never text.
	 */
	readonly onCache?: (info: LiveCacheInfo) => void;
	/** High-resolution clock for cost measurement (performance.now). */
	readonly perfNow?: () => number;
	readonly motionThreshold?: number;
	/** live-popup.md §8. Defaults 1000 / 5000 ms. */
	readonly updatingAfterMs?: number;
	readonly emptyAfterMs?: number;
	/** Transient capture failures in a row before the session shows "paused" (default 2). */
	readonly unavailableAfter?: number;
	/** A grab this late means the machine slept: re-check at once. Default 5000 ms. */
	readonly sleepGapMs?: number;
	/**
	 * GLIM-66: the CPU budget (live-budget.ts). `false` turns the adaptive back-off off.
	 * Default: 15 % of one core over 20 s.
	 */
	readonly budget?: Partial<LiveBudgetOptions> | false;
	/**
	 * Cumulative CPU time in ms the budget measures (the app: process CPU, which includes the
	 * OCR and translation Workers). Default: the runner's own estimate, change detection plus
	 * the wall time of each OCR run.
	 */
	readonly cpuNow?: () => number;
	/** The budget changed level (for the log). */
	readonly onBudget?: (state: LiveBudgetState) => void;
	/** Over a moving background with still text, drop to `LIVE_QUIET_FOCUS.fps` (default true). */
	readonly quietFocusBackoff?: boolean;
}

export interface LiveCacheInfo {
	readonly frameSeq: number;
	/** Translate-class blocks with a final translation in this run. */
	readonly translated: number;
	/** Of those, served entirely from the cache. */
	readonly cached: number;
	/** Session totals so far. */
	readonly totalTranslated: number;
	readonly totalCached: number;
}

export interface LiveRunnerStats {
	readonly status: LiveStatus;
	readonly grabs: number;
	readonly decisions: Readonly<Record<ChangeDecision["kind"], number>>;
	/** OCR runs started, finished, superseded by a newer frame. */
	readonly ocrRuns: number;
	readonly ocrDone: number;
	readonly superseded: number;
	readonly ringHits: number;
	readonly blankFrames: number;
	/** GLIM-67: translated blocks over the session, and those served from the cache. */
	readonly translatedBlocks: number;
	readonly cachedBlocks: number;
	/** Mean / max change-detection cost per grab (sync, on the caller's thread), ms. */
	readonly meanDetectMs: number;
	readonly maxDetectMs: number;
	readonly meanGrabMs: number;
	/** Mean time from a settled capture to its `frame` event, ms (OCR + grouping + detection). */
	readonly meanSettleToFrameMs: number;
	readonly frameSeq: number;
	readonly loop: ReturnType<LiveCaptureLoop["stats"]>;
	/** Grabs decided in text focus over a moving background, and how often focus started (GLIM-114). */
	readonly focusedGrabs: number;
	readonly focusEntered: number;
	/** GLIM-66: budget level (0 = no back-off), its limits, the measured share of one core. */
	readonly budget: LiveBudgetState | null;
	/** The runner's own cost estimate so far: change detection + OCR wall time, ms. */
	readonly costMs: number;
	/** GLIM-157: reads whose text was unchanged, so nothing was shown (no `frame` event). */
	readonly unchangedReads: number;
}

const ERROR_FOR_CODE: Readonly<Record<string, LiveErrorKind>> = {
	"permission-denied": "screenAccess",
	"no-display": "areaGone",
};

export class LiveRunner {
	readonly #o: LiveRunnerOptions;
	readonly #perf: () => number;
	readonly #detector: ChangeDetector;
	readonly #loop: LiveCaptureLoop;
	readonly #ring = new FrameRing<PipelineResult>();
	#status: LiveStatus = "starting";
	#reason: LivePauseReason | null = null;
	#error: LiveError | null = null;
	#shown: readonly LiveBlock[] = [];
	#shownAt: number | null = null;
	#frameSeq = 0;
	#nextId = 1;
	/** Bumped on pause / stop / reset: results of older runs are ignored. */
	#epoch = 0;
	#inFlight = 0;
	#updatingTimer: unknown = null;
	#emptyTimer: unknown = null;
	#empty = false;
	/** The last `packs` rows sent (JSON), so unchanged rows aren't re-sent every frame. */
	#packsKey = "[]";
	#grabs = 0;
	#grabMs = 0;
	#detectMs = 0;
	#detectMax = 0;
	#ocrRuns = 0;
	#ocrDone = 0;
	#superseded = 0;
	#ringHits = 0;
	#blank = 0;
	#translatedBlocks = 0;
	#cachedBlocks = 0;
	#settleMs = 0;
	#settleCount = 0;
	readonly #budget: LiveBudget | null;
	#userFps: number;
	/** Wall time of OCR runs, ms (part of the cost estimate). */
	#ocrMs = 0;
	#lastOcrAt: number | null = null;
	/** Last grab whose decision wasn't `same` (something moved that matters). */
	#activeAt = 0;
	#quiet = false;
	/** GLIM-157: "Only when I refresh", and a Refresh waiting for its frame. */
	#manual = false;
	#refreshing = false;
	/** Frame events skipped because the text was unchanged (stats, tests). */
	#unchanged = 0;
	/**
	 * GLIM-157: blocks the latest read saw with the same words but different characters (OCR
	 * jitter): what is shown stays, so their new translations are ignored. Keyed by frameSeq.
	 */
	#jitter: { seq: number; ids: ReadonlySet<string> } = { seq: 0, ids: new Set() };
	readonly #decisions: Record<ChangeDecision["kind"], number> = {
		first: 0,
		same: 0,
		settling: 0,
		settled: 0,
		"below-threshold": 0,
	};

	constructor(options: LiveRunnerOptions) {
		this.#o = options;
		this.#perf = options.perfNow ?? (() => options.timers.now());
		this.#detector = new ChangeDetector(
			{
				diffThreshold: options.diffThreshold,
				stabilityMs: options.stabilityMs,
				...(options.motionThreshold === undefined ? {} : { motionThreshold: options.motionThreshold }),
			},
			this.#perf,
		);
		this.#budget = options.budget === false ? null : new LiveBudget(options.budget ?? {});
		this.#manual = options.update === "manual";
		this.#userFps = options.fps;
		this.#loop = new LiveCaptureLoop({
			source: options.source,
			timers: options.timers,
			fps: options.fps,
			perfNow: this.#perf,
			...(options.sleepGapMs === undefined ? {} : { sleepGapMs: options.sleepGapMs }),
			handler: {
				onFrame: (frame, info) => this.#onFrame(frame, info),
				onError: (failure) => this.#onCaptureError(failure),
			},
		});
	}

	get sessionId(): string {
		return this.#o.sessionId;
	}

	get status(): LiveStatus {
		return this.#status;
	}

	get pauseReason(): LivePauseReason | null {
		return this.#reason;
	}

	/** What the popup shows now. */
	get blocks(): readonly LiveBlock[] {
		return this.#shown;
	}

	get running(): boolean {
		return this.#status !== "paused" && this.#status !== "error" && this.#status !== "stopped";
	}

	start(): void {
		if (this.#loop.state !== "idle" || this.#status !== "starting") return;
		this.#setStatus("starting", null, true);
		this.#loop.start();
	}

	/** Pause (the user, the screen lock, sleep). Nothing is captured until `resume()`. */
	pause(reason: LivePauseReason = "user"): void {
		if (this.#status === "stopped" || this.#status === "error") return;
		if (this.#status === "paused" && this.#reason === reason) return;
		// A user pause wins over an automatic one, and an automatic resume never undoes a user pause.
		if (this.#status === "paused" && this.#reason === "user") return;
		this.#halt();
		this.#budget?.restart();
		this.#setStatus("paused", reason);
	}

	/**
	 * Resume after a pause or an error. `reason`: only undo a pause with this reason (an
	 * unlock must not resume a session the user paused).
	 */
	resume(reason?: LivePauseReason): void {
		if (this.#status !== "paused" && this.#status !== "error") return;
		if (reason && (this.#status !== "paused" || this.#reason !== reason)) return;
		this.#detector.resume();
		this.#setStatus(this.#shownAt === null ? "starting" : this.#empty ? "empty" : "live");
		if (this.#loop.state === "idle") this.#loop.start();
		// GLIM-157: in manual mode nothing is captured until Refresh (or a first read is due).
		else if (!this.#manual || this.#shownAt === null) this.#loop.resume();
	}

	/** GLIM-157: "Only when I refresh" is on. */
	get manual(): boolean {
		return this.#manual;
	}

	/**
	 * GLIM-157: read the region now (the Refresh button / key). In manual mode this is the only
	 * way it is read after the first time; in `text` mode it re-reads at once without waiting
	 * for a change. "Updating" shows at once, so the press is acknowledged even when nothing
	 * changed. Ignored while paused or stopped.
	 */
	refresh(): void {
		if (!this.running || this.#status === "starting") return;
		if (this.#status === "live" || this.#status === "empty") this.#setStatus("updating");
		this.#wake();
	}

	stop(): void {
		if (this.#status === "stopped") return;
		this.#loop.stop();
		this.#epoch++;
		this.#clearTimers();
		this.#ring.clear();
		this.#setStatus("stopped");
	}

	/** Settings › Live changed (applies without restarting). */
	setParams(params: Partial<LiveSettingsParams>): void {
		if (params.fps !== undefined) {
			this.#userFps = params.fps;
			this.#applyBudget();
		}
		this.#detector.setOptions({
			...(params.diffThreshold === undefined ? {} : { diffThreshold: params.diffThreshold }),
			...(params.stabilityMs === undefined ? {} : { stabilityMs: params.stabilityMs }),
		});
		if (params.update !== undefined && (params.update === "manual") !== this.#manual) {
			this.#manual = params.update === "manual";
			// Back to automatic: compare the next grab with what was read last, at once.
			if (!this.#manual && this.running) {
				this.#detector.resume();
				if (this.#loop.state === "paused") this.#loop.resume();
			}
		}
	}

	/**
	 * Target language or source subset changed: earlier results no longer apply. Drops the frame
	 * ring and re-reads the region on the next grab.
	 */
	invalidate(): void {
		this.#ring.clear();
		this.#detector.reset();
		// GLIM-157: in manual mode nothing would read it again until Refresh; this re-read is
		// Glimpse's own (a pack landed, the languages changed), so it happens now, quietly.
		if (this.#manual && this.running) this.#wake();
	}

	/** Read the next grab whatever changed (Refresh, or a re-read in manual mode). */
	#wake(): void {
		this.#refreshing = true;
		if (this.#loop.state === "paused") this.#loop.resume();
	}

	stats(): LiveRunnerStats {
		const n = Math.max(1, this.#grabs);
		return {
			status: this.#status,
			grabs: this.#grabs,
			decisions: { ...this.#decisions },
			ocrRuns: this.#ocrRuns,
			ocrDone: this.#ocrDone,
			superseded: this.#superseded,
			ringHits: this.#ringHits,
			blankFrames: this.#blank,
			translatedBlocks: this.#translatedBlocks,
			cachedBlocks: this.#cachedBlocks,
			meanDetectMs: this.#detectMs / n,
			maxDetectMs: this.#detectMax,
			meanGrabMs: this.#grabMs / n,
			meanSettleToFrameMs: this.#settleCount === 0 ? 0 : this.#settleMs / this.#settleCount,
			frameSeq: this.#frameSeq,
			loop: this.#loop.stats(),
			focusedGrabs: this.#detector.stats().focusedGrabs,
			focusEntered: this.#detector.stats().focusEntered,
			budget: this.#budget?.state() ?? null,
			costMs: this.#costMs(),
			unchangedReads: this.#unchanged,
		};
	}

	// ---- loop callbacks ---------------------------------------------------------------

	#onFrame(frame: CaptureFrame, info: LiveTickInfo): number | undefined {
		this.#grabs++;
		this.#grabMs += info.grabMs;
		if (this.#status === "paused" && this.#reason === "unavailable") {
			// Capture is back (unlock, UAC closed): pick up as after a pause.
			this.#detector.resume();
			this.#setStatus(this.#shownAt === null ? "starting" : this.#empty ? "empty" : "live");
		} else if (info.lateMs > (this.#o.sleepGapMs ?? 5000)) {
			this.#detector.resume();
		}
		this.#sampleBudget(frame.capturedAt);
		const t0 = this.#perf();
		// GLIM-157: Refresh reads this frame whatever changed; manual mode reads nothing else.
		const refresh = this.#refreshing || (this.#manual && this.#shownAt === null && this.#frameSeq === 0);
		if (this.#refreshing) {
			this.#refreshing = false;
			this.#detector.reset();
		} else if (this.#manual && this.#frameSeq > 0) {
			this.#loop.pause();
			return undefined;
		}
		const decision = this.#detector.feed(frame);
		this.#decisions[decision.kind]++;
		this.#trackQuiet(frame.capturedAt, decision);
		let action: LiveTrace["action"] = "none";
		if (shouldProcess(decision) || refresh) action = this.#settle(frame);
		// A Refresh answered without OCR (frame ring, blank): its "Updating" ends now.
		if (refresh && this.#inFlight === 0 && this.#status === "updating") this.#setStatus(this.#empty ? "empty" : "live");
		if (this.#manual && action !== "none") this.#loop.pause();
		const detectMs = this.#perf() - t0;
		this.#detectMs += detectMs;
		this.#detectMax = Math.max(this.#detectMax, detectMs);
		this.#o.onTrace?.({
			index: info.index,
			at: frame.capturedAt,
			sequence: frame.sequence,
			sequenceChanged: info.sequenceChanged,
			decision: decision.kind,
			...(decision.kind === "settling"
				? { reason: decision.reason, ...(decision.motion ? { fraction: decision.motion.fraction } : {}) }
				: decision.kind === "settled"
					? { reason: decision.trigger, fraction: decision.diff.fraction }
					: decision.kind === "below-threshold"
						? { fraction: decision.diff.fraction }
						: {}),
			...("scope" in decision && decision.scope ? { scope: decision.scope } : {}),
			action,
			grabMs: info.grabMs,
			detectMs,
		});
		return decision.kind === "settling" ? decision.wakeInMs : undefined;
	}

	#onCaptureError(f: LiveCaptureFailure): void {
		if (this.#status === "stopped") return;
		if (f.fatal) {
			this.#epoch++;
			this.#clearTimers();
			this.#error = { kind: ERROR_FOR_CODE[f.code] ?? "captureFailed", message: `${f.code}: ${f.message}` };
			this.#setStatus("error");
			return;
		}
		if (f.consecutive >= (this.#o.unavailableAfter ?? 2) && this.#status !== "paused") {
			this.#setStatus("paused", "unavailable");
		}
	}

	// ---- processing -------------------------------------------------------------------

	#settle(frame: CaptureFrame): LiveTrace["action"] {
		const seq = ++this.#frameSeq;
		if (isBlankImage(frame)) {
			this.#blank++;
			this.#noText(seq, frame);
			return "blank";
		}
		const key = frameKey(frame);
		const hit = this.#ring.get(key);
		if (hit) {
			this.#ringHits++;
			this.#apply(seq, frame, hit.blocks, hit, true);
			return "reused";
		}
		this.#ocrRuns++;
		this.#inFlight++;
		const epoch = this.#epoch;
		const startedAt = this.#perf();
		this.#lastOcrAt = frame.capturedAt;
		const gap = this.#budget?.state().limits.ocrGapMs ?? 0;
		if (gap > 0) this.#detector.holdUntil(frame.capturedAt + gap);
		let ids: Map<string, string> | null = null;
		const onEvent = (event: PipelineEvent) => {
			if (epoch !== this.#epoch) return;
			if (event.type === "recognised") {
				ids = this.#apply(seq, frame, event.blocks, null, false);
				// GLIM-157: "Updating" only while changed text is being translated.
				if (this.#pendingTranslation(ids)) this.#armUpdating(epoch);
				this.#settleMs += this.#perf() - startedAt;
				this.#settleCount++;
			} else if (event.type === "translation" && ids) {
				this.#translation(seq, ids, event.translation.blockId, event.translation);
			} else if (event.type === "packs" && ids) {
				this.#packs(seq, ids, event.rows);
			}
		};
		this.#o.processor
			.process(toOcrImage(frame), { onEvent })
			.then((result) => {
				if (epoch !== this.#epoch) return;
				if (!result) {
					this.#superseded++;
					return;
				}
				this.#ocrDone++;
				if (result.error?.kind === "ocrFailed" || result.error?.kind === "spendCap") {
					this.#fail({ kind: result.error.kind, message: result.error.message });
					return;
				}
				this.#ring.set(key, result);
				this.#countCache(seq, result);
			})
			.catch((error: unknown) => {
				if (epoch !== this.#epoch) return;
				this.#fail({ kind: "ocrFailed", message: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				this.#ocrMs += this.#perf() - startedAt;
				this.#inFlight = Math.max(0, this.#inFlight - 1);
				if (epoch !== this.#epoch) return;
				if (this.#inFlight === 0) {
					this.#clearTimer("updating");
					if (this.#status === "updating") this.#setStatus(this.#empty ? "empty" : "live");
				}
			});
		return "ocr";
	}

	#countCache(seq: number, result: PipelineResult): void {
		let translated = 0;
		let cached = 0;
		for (const t of Object.values(result.translations)) {
			if (!t.final || t.failure) continue;
			translated++;
			if (t.provider?.remembered) cached++;
		}
		this.#translatedBlocks += translated;
		this.#cachedBlocks += cached;
		this.#o.onCache?.({
			frameSeq: seq,
			translated,
			cached,
			totalTranslated: this.#translatedBlocks,
			totalCached: this.#cachedBlocks,
		});
	}

	/** Diff a recognised block list against what is shown; emit `frame`. Returns run id -> stable id. */
	#apply(
		seq: number,
		frame: CaptureFrame,
		blocks: readonly RecognisedBlock[],
		result: PipelineResult | null,
		reused: boolean,
	): Map<string, string> {
		const ids = new Map<string, string>();
		if (blocks.length === 0) {
			this.#noText(seq, frame);
			return ids;
		}
		this.#clearTimer("empty");
		// Over a moving background, change detection watches where this text is (GLIM-114).
		this.#detector.setTextAreas(blocks.map((b) => b.box));
		const inputs: LiveBlockInput[] = blocks.map((b) => {
			const t = result?.translations[b.id];
			return {
				cls: b.cls,
				lang: b.lang,
				direction: b.direction,
				box: b.box,
				source: b.text,
				translation: t?.final && !t.failure ? t.text : null,
				failed: !!t?.failure,
				waitingForPack: b.waitingForPack,
			};
		});
		const first = this.#shownAt === null;
		const before = this.#shown.map((b) => b.id);
		const shownSource = new Map(this.#shown.map((b) => [b.id, normaliseSegment(b.source)]));
		const diff = diffLiveBlocks(this.#shown, inputs, { newId: () => `L${this.#nextId++}`, first });
		const jitter = new Set<string>();
		blocks.forEach((b, i) => {
			const id = diff.ids[i];
			if (!id) return;
			ids.set(b.id, id);
			const was = shownSource.get(id);
			const kept = diff.blocks.find((x) => x.id === id);
			// Matched as the same text, but read differently this time: the shown text stays.
			if (was !== undefined && kept && normaliseSegment(kept.source) === was && normaliseSegment(b.text) !== was) {
				jitter.add(id);
			}
		});
		this.#jitter = { seq, ids: jitter };
		this.#shown = diff.blocks;
		this.#shownAt = frame.capturedAt;
		// GLIM-157: the same text as shown (boxes may have moved a pixel): nothing to show.
		const unchanged =
			!first &&
			!this.#empty &&
			diff.upserts.length === 0 &&
			diff.removes.length === 0 &&
			diff.order.length === before.length &&
			diff.order.every((id, i) => id === before[i]);
		if (unchanged) this.#unchanged++;
		else this.#emitFrame(seq, frame, diff.upserts, diff.removes, diff.order, diff.changeSet, reused);
		// L12 pack rows: a fresh run sends its `packs` right after `recognised`; a frame-ring
		// hit carries them in its result; nothing waiting clears them.
		if (!blocks.some((b) => b.waitingForPack)) this.#packs(seq, ids, []);
		else if (result) this.#packs(seq, ids, result.packs);
		if (this.#empty || this.#status === "starting") {
			this.#empty = false;
			if (this.#status === "starting" || this.#status === "empty") this.#setStatus("live");
		}
		return ids;
	}

	/** Emit the pack rows (run block ids -> stable ids) when they differ from the last sent. */
	#packs(seq: number, ids: Map<string, string>, rows: readonly PackRow[]): void {
		const mapped = rows.map((r) => ({
			...r,
			segmentIds: r.segmentIds.flatMap((id) => {
				const stable = ids.get(id);
				return stable ? [stable] : [];
			}),
		}));
		const key = JSON.stringify(mapped);
		if (key === this.#packsKey) return;
		this.#packsKey = key;
		this.#o.onEvent({ type: "packs", sessionId: this.#o.sessionId, frameSeq: seq, rows: mapped });
	}

	#translation(
		seq: number,
		ids: Map<string, string>,
		runBlockId: string,
		t: Pick<BlockTranslation, "text" | "final" | "failure">,
	): void {
		const id = ids.get(runBlockId);
		if (!id) return;
		const shown = this.#shown.find((b) => b.id === id);
		if (!shown) return;
		const failed = !!t.failure;
		// The spend guard (GLIM-120) paused cloud translation: stop sending frames until the user continues.
		if (t.final && t.failure?.kind === "spendCap") {
			this.#fail({ kind: "spendCap", message: t.failure.error.message });
			return;
		}
		if (t.final && !failed && shown.translation === t.text) return; // unchanged block, cache hit
		// GLIM-157: an unchanged, translated block doesn't stream its translation again, and a
		// block read with OCR jitter keeps the translation of the text it shows.
		if (!t.final && shown.translation !== null) return;
		if (shown.translation !== null && this.#jitter.seq === seq && this.#jitter.ids.has(id)) return;
		if (t.final) {
			this.#shown = this.#shown.map((b) => (b.id === id ? { ...b, translation: failed ? null : t.text, failed } : b));
		}
		this.#o.onEvent({
			type: "translation",
			sessionId: this.#o.sessionId,
			frameSeq: seq,
			id,
			text: t.text,
			final: t.final,
			failed,
		});
	}

	/** A settled capture with no text. Short gaps keep the last blocks; after 5 s: L7. */
	#noText(seq: number, frame: CaptureFrame): void {
		// Nothing to watch: text focus (GLIM-114) watches the whole region again.
		this.#detector.setTextAreas([]);
		if (this.#status === "starting") this.#setStatus("live");
		if (this.#empty || this.#emptyTimer !== null) return;
		const epoch = this.#epoch;
		const fire = () => {
			this.#emptyTimer = null;
			if (epoch !== this.#epoch || this.#empty) return;
			this.#empty = true;
			const removes = this.#shown.map((b) => b.id);
			this.#shown = [];
			this.#shownAt = frame.capturedAt;
			this.#emitFrame(seq, frame, [], removes, [], [], false);
			this.#packs(seq, new Map(), []);
			if (this.#status === "live" || this.#status === "updating") this.#setStatus("empty");
		};
		const delay = this.#o.emptyAfterMs ?? 5000;
		if (delay <= 0) fire();
		else this.#emptyTimer = this.#o.timers.setTimeout(fire, delay);
	}

	#emitFrame(
		seq: number,
		frame: CaptureFrame,
		upserts: readonly LiveBlockUpdate[],
		removes: readonly string[],
		order: readonly string[],
		changeSet: readonly string[],
		reused: boolean,
	): void {
		this.#o.onEvent({
			type: "frame",
			sessionId: this.#o.sessionId,
			frameSeq: seq,
			upserts,
			removes,
			order,
			changeSet,
			capturedAt: frame.capturedAt,
			reused,
			region: this.#o.region,
			image: { width: frame.width, height: frame.height },
		});
	}

	#fail(error: LiveError): void {
		this.#halt();
		this.#error = error;
		this.#setStatus("error");
	}

	/** Stop capturing and drop work in flight (pause, error). */
	// ---- CPU budget (GLIM-66) ------------------------------------------------------------

	#costMs(): number {
		return this.#detectMs + this.#ocrMs;
	}

	#sampleBudget(now: number): void {
		const budget = this.#budget;
		if (!budget) return;
		const changed = budget.sample(now, this.#o.cpuNow ? this.#o.cpuNow() : this.#costMs());
		if (!changed) return;
		this.#applyBudget();
		this.#o.onBudget?.(changed);
	}

	/**
	 * A moving background whose text hasn't changed for a while costs a diff per grab for
	 * nothing: capture it at the idle rate until something changes (a change is still seen
	 * within half a second).
	 */
	#trackQuiet(now: number, decision: ChangeDecision): void {
		if (decision.kind !== "same" || !this.#detector.focused) this.#activeAt = now;
		const quiet =
			this.#o.quietFocusBackoff !== false && this.#detector.focused && now - this.#activeAt >= LIVE_QUIET_FOCUS.afterMs;
		if (quiet === this.#quiet) return;
		this.#quiet = quiet;
		this.#applyBudget();
	}

	/** Frame rate = the user's, capped by the budget level and quiet focus; OCR gap from the level. */
	#applyBudget(): void {
		const limits = this.#budget?.state().limits;
		let fps = limits ? Math.min(this.#userFps, limits.fpsCap) : this.#userFps;
		if (this.#quiet) fps = Math.min(fps, LIVE_QUIET_FOCUS.fps);
		this.#loop.setFps(fps);
		const gap = limits?.ocrGapMs ?? 0;
		this.#detector.holdUntil(this.#lastOcrAt === null || gap === 0 ? 0 : this.#lastOcrAt + gap);
	}

	#halt(): void {
		this.#loop.pause();
		this.#epoch++;
		this.#inFlight = 0;
		this.#clearTimers();
	}

	/** A block of this run (run id -> stable id) that is shown without its translation yet. */
	#pendingTranslation(ids: ReadonlyMap<string, string>): boolean {
		const mine = new Set(ids.values());
		return this.#shown.some((b) => mine.has(b.id) && b.cls === "translate" && b.translation === null && !b.failed);
	}

	#armUpdating(epoch: number): void {
		if (this.#updatingTimer !== null) return;
		this.#updatingTimer = this.#o.timers.setTimeout(() => {
			this.#updatingTimer = null;
			if (epoch !== this.#epoch || this.#inFlight === 0) return;
			if (this.#status === "live" || this.#status === "empty") this.#setStatus("updating");
		}, this.#o.updatingAfterMs ?? 1000);
	}

	#clearTimer(which: "updating" | "empty"): void {
		const t = which === "updating" ? this.#updatingTimer : this.#emptyTimer;
		if (t !== null) this.#o.timers.clearTimeout(t);
		if (which === "updating") this.#updatingTimer = null;
		else this.#emptyTimer = null;
	}

	#clearTimers(): void {
		this.#clearTimer("updating");
		this.#clearTimer("empty");
	}

	#setStatus(status: LiveStatus, reason: LivePauseReason | null = null, force = false): void {
		if (status !== "error") this.#error = null;
		const changed = force || status !== this.#status || reason !== this.#reason;
		this.#status = status;
		this.#reason = status === "paused" ? reason : null;
		if (!changed && status !== "error") return;
		this.#o.onEvent({
			type: "status",
			sessionId: this.#o.sessionId,
			status,
			reason: this.#reason,
			error: status === "error" ? this.#error : null,
			stale: status === "paused" || status === "error" || status === "stopped",
			capturedAt: this.#shownAt,
			at: this.#o.timers.now(),
		});
	}
}
