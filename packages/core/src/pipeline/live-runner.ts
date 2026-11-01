// One pinned Live region, end to end in core: capture loop (GLIM-48) -> change detection
// (GLIM-58) -> frame ring (GLIM-20) -> pipeline (`LivePipelineSession`, latest wins) -> block
// diff (live-popup.md §5) -> typed `LiveSessionEvent`s. Pure over ports: a frame source, timers
// and a processor; the app's LiveService (GLIM-59) opens the capture session and wires
// commands, tray, the pinned frame and lock/sleep.
//
// OCR runs only for the first frame and for frames change detection calls settled. A settled
// frame identical to one of the last 8 read (A -> B -> A) reuses that result instead.
//
// Timings (live-popup.md §8): "Updating" after 1 s of processing a settled change; "empty"
// after 5 s without text (shorter gaps keep the last blocks); pause / resume / stop at once;
// resume compares with the processed frame immediately, so what changed while paused is one
// change set and nothing seen while paused is replayed.

import { toOcrImage } from "../capture/compose.ts";
import type { CaptureFrame } from "../capture/port.ts";
import type { Rect } from "../geometry.ts";
import { diffLiveBlocks, type LiveBlock, type LiveBlockInput, type LiveBlockUpdate } from "../popup/live-diff.ts";
import type { OcrImage } from "../providers/ocr.ts";
import { type ChangeDecision, ChangeDetector, shouldProcess } from "./change-detection.ts";
import type { PipelineEvent, PipelineListener, PipelineResult, RecognisedBlock } from "./events.ts";
import { FrameRing, frameKey } from "./frame-ring.ts";
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
}

export interface LiveRunnerOptions extends LiveSettingsParams {
	readonly sessionId: string;
	/** The pinned region, global logical (echoed in `frame` events). */
	readonly region: Rect;
	readonly source: LiveFrameSource;
	readonly timers: Timers;
	readonly processor: LiveProcessor;
	readonly onEvent: LiveSessionListener;
	readonly onTrace?: (trace: LiveTrace) => void;
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
	/** Mean / max change-detection cost per grab (sync, on the caller's thread), ms. */
	readonly meanDetectMs: number;
	readonly maxDetectMs: number;
	readonly meanGrabMs: number;
	/** Mean time from a settled capture to its `frame` event, ms (OCR + grouping + detection). */
	readonly meanSettleToFrameMs: number;
	readonly frameSeq: number;
	readonly loop: ReturnType<LiveCaptureLoop["stats"]>;
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
	#grabs = 0;
	#grabMs = 0;
	#detectMs = 0;
	#detectMax = 0;
	#ocrRuns = 0;
	#ocrDone = 0;
	#superseded = 0;
	#ringHits = 0;
	#blank = 0;
	#settleMs = 0;
	#settleCount = 0;
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
		else this.#loop.resume();
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
		if (params.fps !== undefined) this.#loop.setFps(params.fps);
		this.#detector.setOptions({
			...(params.diffThreshold === undefined ? {} : { diffThreshold: params.diffThreshold }),
			...(params.stabilityMs === undefined ? {} : { stabilityMs: params.stabilityMs }),
		});
	}

	/**
	 * Target language or source subset changed: earlier results no longer apply. Drops the frame
	 * ring and re-reads the region on the next grab.
	 */
	invalidate(): void {
		this.#ring.clear();
		this.#detector.reset();
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
			meanDetectMs: this.#detectMs / n,
			maxDetectMs: this.#detectMax,
			meanGrabMs: this.#grabMs / n,
			meanSettleToFrameMs: this.#settleCount === 0 ? 0 : this.#settleMs / this.#settleCount,
			frameSeq: this.#frameSeq,
			loop: this.#loop.stats(),
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
		const t0 = this.#perf();
		const decision = this.#detector.feed(frame);
		this.#decisions[decision.kind]++;
		let action: LiveTrace["action"] = "none";
		if (shouldProcess(decision)) action = this.#settle(frame);
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
		this.#armUpdating(epoch);
		let ids: Map<string, string> | null = null;
		const onEvent = (event: PipelineEvent) => {
			if (epoch !== this.#epoch) return;
			if (event.type === "recognised") {
				ids = this.#apply(seq, frame, event.blocks, null, false);
				this.#settleMs += this.#perf() - startedAt;
				this.#settleCount++;
			} else if (event.type === "translation" && ids) {
				this.#translation(seq, ids, event.translation.blockId, event.translation);
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
				if (result.error?.kind === "ocrFailed") {
					this.#fail({ kind: "ocrFailed", message: result.error.message });
					return;
				}
				this.#ring.set(key, result);
			})
			.catch((error: unknown) => {
				if (epoch !== this.#epoch) return;
				this.#fail({ kind: "ocrFailed", message: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				this.#inFlight = Math.max(0, this.#inFlight - 1);
				if (epoch !== this.#epoch) return;
				if (this.#inFlight === 0) {
					this.#clearTimer("updating");
					if (this.#status === "updating") this.#setStatus(this.#empty ? "empty" : "live");
				}
			});
		return "ocr";
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
		const diff = diffLiveBlocks(this.#shown, inputs, { newId: () => `L${this.#nextId++}`, first });
		blocks.forEach((b, i) => {
			const id = diff.ids[i];
			if (id) ids.set(b.id, id);
		});
		this.#shown = diff.blocks;
		this.#shownAt = frame.capturedAt;
		this.#emitFrame(seq, frame, diff.upserts, diff.removes, diff.order, diff.changeSet, reused);
		if (this.#empty || this.#status === "starting") {
			this.#empty = false;
			if (this.#status === "starting" || this.#status === "empty") this.#setStatus("live");
		}
		return ids;
	}

	#translation(
		seq: number,
		ids: Map<string, string>,
		runBlockId: string,
		t: { readonly text: string; readonly final: boolean; readonly failure: unknown },
	): void {
		const id = ids.get(runBlockId);
		if (!id) return;
		const shown = this.#shown.find((b) => b.id === id);
		if (!shown) return;
		const failed = !!t.failure;
		if (t.final && !failed && shown.translation === t.text) return; // unchanged block, cache hit
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
	#halt(): void {
		this.#loop.pause();
		this.#epoch++;
		this.#inFlight = 0;
		this.#clearTimers();
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
