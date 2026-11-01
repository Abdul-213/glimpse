// GLIM-48: the Live capture loop. Pulls frames from a persistent capture session at the
// configured rate (PRODUCT.md: about 2-4 fps) and hands each one to a handler (change
// detection, GLIM-58, then the pipeline). Pure scheduling over two ports, so it runs on a
// manual clock in tests and on scripted frame sequences in the harness:
//
//   LiveFrameSource  `CaptureSession.next()` (DXGI duplication, SCStream, the file backend)
//   Timers           now + setTimeout / clearTimeout (`systemTimers`, or `ManualTimers` in
//                    @glimpse/core/testing)
//
// Rules:
// - One grab at a time. The next grab is scheduled when the handler has finished with the
//   previous frame, `periodMs` after the previous grab started (no drift, no pile-up).
// - Back off while nothing changes: after `idle.afterMs` with the backend reporting the same
//   `sequence`, the period stretches to `idle.periodMs` (default 500 ms: 2 fps, the bottom of
//   the Live range, so a change is still seen within half a second).
//   The first new frame snaps back to the full rate.
// - The handler can ask for an earlier frame (`wakeInMs`), e.g. when change detection only
//   needs to see the region once more to call it stable. Never faster than `minPeriodMs`.
// - Capture errors: transient ones (`temporarily-unavailable`, `timeout`, `failed`: a lock
//   screen, UAC, a mode switch) retry with exponential backoff; the others (`permission-denied`,
//   `no-display`, `unavailable`, `invalid-argument`) pause the loop until `resume()`.
// - `pause()` stops grabbing at once (a grab in flight is dropped); `resume()` grabs at once.
// - A timer that fires far too late means the machine slept; the next tick reports `lateMs`.

import type { CaptureErrorCode, CaptureFrame } from "../capture/port.ts";
import { isCaptureError } from "../capture/port.ts";
import type { Clock } from "./ports.ts";

/** PRODUCT.md / ticket GLIM-48: Live captures at 2-4 fps. Settings may store more; the loop clamps. */
export const LIVE_FPS = { min: 2, max: 4, default: 3 } as const;

export function clampLiveFps(fps: number): number {
	if (!Number.isFinite(fps)) return LIVE_FPS.default;
	return Math.min(LIVE_FPS.max, Math.max(LIVE_FPS.min, fps));
}

export type TimerHandle = unknown;

/** Wall clock plus one-shot timers. */
export interface Timers extends Clock {
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

export const systemTimers: Timers = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** What the loop pulls frames from. `CaptureSession` satisfies it. */
export interface LiveFrameSource {
	next(): Promise<CaptureFrame>;
}

export interface LiveTickInfo {
	/** 0-based grab counter for this loop (pauses don't reset it). */
	readonly index: number;
	/** The backend reported new content (sequence moved), or this is the first frame. */
	readonly sequenceChanged: boolean;
	/** Wall time of `next()`, ms (on `perfNow`). */
	readonly grabMs: number;
	/** How late the timer fired (> `sleepGapMs`: the machine probably slept). */
	readonly lateMs: number;
	/** First frame after `start()`, `resume()` or a recovered capture error. */
	readonly fresh: boolean;
}

export interface LiveLoopHandler {
	/**
	 * Called with every grabbed frame, in order, never concurrently. Synchronous work here
	 * counts as the loop's per-frame cost. Return a wake hint in ms (when the handler wants
	 * to see the next frame), or nothing for the normal rate.
	 */
	onFrame(frame: CaptureFrame, info: LiveTickInfo): number | undefined | Promise<number | undefined>;
	/** A capture failed. `fatal`: the loop paused itself and waits for `resume()`. */
	onError?(error: LiveCaptureFailure): void;
}

export interface LiveCaptureFailure {
	readonly code: CaptureErrorCode;
	readonly message: string;
	readonly fatal: boolean;
	/** Failures in a row (1 on the first). */
	readonly consecutive: number;
	/** Transient failures: when the loop tries again. */
	readonly retryInMs: number | null;
}

export interface LiveLoopOptions {
	readonly source: LiveFrameSource;
	readonly timers: Timers;
	readonly handler: LiveLoopHandler;
	/** Clamped to `LIVE_FPS`. */
	readonly fps: number;
	readonly idle?: { readonly afterMs: number; readonly periodMs: number };
	/** Never grab more often than this, whatever the handler asks. Default 100 ms. */
	readonly minPeriodMs?: number;
	readonly retry?: { readonly baseMs: number; readonly maxMs: number };
	/** A timer this late means a system sleep. Default 5000 ms. */
	readonly sleepGapMs?: number;
	/** High-resolution clock for cost measurements (`performance.now`). Default: `timers.now`. */
	readonly perfNow?: () => number;
}

export type LiveLoopState = "idle" | "running" | "paused" | "stopped";

export interface LiveLoopStats {
	readonly state: LiveLoopState;
	readonly fps: number;
	/** The period the next grab is scheduled with (stretched while idle). */
	readonly periodMs: number;
	readonly grabs: number;
	/** Grabs whose sequence moved (new screen content). */
	readonly newFrames: number;
	readonly errors: number;
	/** Mean wall time of `next()` and of the handler's synchronous part, ms. */
	readonly meanGrabMs: number;
	readonly meanHandlerMs: number;
	readonly maxHandlerMs: number;
}

const FATAL: ReadonlySet<CaptureErrorCode> = new Set([
	"permission-denied",
	"no-display",
	"unavailable",
	"invalid-argument",
]);
export const LIVE_IDLE_DEFAULT = { afterMs: 2000, periodMs: 1000 / LIVE_FPS.min } as const;
const RETRY_DEFAULT = { baseMs: 500, maxMs: 5000 } as const;

export class LiveCaptureLoop {
	readonly #o: LiveLoopOptions;
	readonly #perf: () => number;
	#fps: number;
	#state: LiveLoopState = "idle";
	#timer: TimerHandle | null = null;
	#dueAt = 0;
	/** Bumped on pause/stop so a grab in flight knows it was dropped. */
	#epoch = 0;
	#busy = false;
	#fresh = true;
	#lastSequence: number | null = null;
	#lastNewAt = 0;
	#failures = 0;
	#index = 0;
	#grabs = 0;
	#newFrames = 0;
	#errors = 0;
	#grabMsTotal = 0;
	#handlerMsTotal = 0;
	#handlerMsMax = 0;
	#periodMs: number;

	constructor(options: LiveLoopOptions) {
		this.#o = options;
		this.#fps = clampLiveFps(options.fps);
		this.#periodMs = 1000 / this.#fps;
		this.#perf = options.perfNow ?? (() => options.timers.now());
	}

	get state(): LiveLoopState {
		return this.#state;
	}

	get fps(): number {
		return this.#fps;
	}

	start(): void {
		if (this.#state !== "idle") return;
		this.#state = "running";
		this.#fresh = true;
		this.#schedule(0);
	}

	/** Stop grabbing; a grab in flight is dropped. */
	pause(): void {
		if (this.#state !== "running") return;
		this.#state = "paused";
		this.#epoch++;
		this.#cancelTimer();
		this.#busy = false;
	}

	/** Grab at once, then continue at the full rate. */
	resume(): void {
		if (this.#state !== "paused") return;
		this.#state = "running";
		this.#fresh = true;
		this.#lastNewAt = this.#o.timers.now();
		this.#failures = 0;
		this.#schedule(0);
	}

	stop(): void {
		if (this.#state === "stopped") return;
		this.#state = "stopped";
		this.#epoch++;
		this.#cancelTimer();
		this.#busy = false;
	}

	/** Runtime settings update (Settings › Live). Applies from the next grab. */
	setFps(fps: number): void {
		this.#fps = clampLiveFps(fps);
		this.#periodMs = 1000 / this.#fps;
	}

	stats(): LiveLoopStats {
		const n = Math.max(1, this.#grabs);
		return {
			state: this.#state,
			fps: this.#fps,
			periodMs: this.#periodMs,
			grabs: this.#grabs,
			newFrames: this.#newFrames,
			errors: this.#errors,
			meanGrabMs: this.#grabMsTotal / n,
			meanHandlerMs: this.#handlerMsTotal / n,
			maxHandlerMs: this.#handlerMsMax,
		};
	}

	#cancelTimer(): void {
		if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
		this.#timer = null;
	}

	#schedule(delayMs: number): void {
		this.#cancelTimer();
		const ms = Math.max(0, delayMs);
		this.#dueAt = this.#o.timers.now() + ms;
		this.#timer = this.#o.timers.setTimeout(() => {
			this.#timer = null;
			void this.#tick();
		}, ms);
	}

	async #tick(): Promise<void> {
		if (this.#state !== "running" || this.#busy) return;
		this.#busy = true;
		const epoch = this.#epoch;
		const timers = this.#o.timers;
		const startedAt = timers.now();
		const lateMs = Math.max(0, startedAt - this.#dueAt);
		let frame: CaptureFrame;
		const g0 = this.#perf();
		try {
			frame = await this.#o.source.next();
		} catch (error) {
			if (epoch !== this.#epoch) return;
			this.#busy = false;
			this.#failed(error);
			return;
		}
		const grabMs = this.#perf() - g0;
		if (epoch !== this.#epoch) return;
		this.#grabs++;
		this.#grabMsTotal += grabMs;
		const recovered = this.#failures > 0;
		this.#failures = 0;
		const sequenceChanged = this.#lastSequence === null || frame.sequence !== this.#lastSequence;
		this.#lastSequence = frame.sequence;
		if (sequenceChanged) {
			this.#newFrames++;
			this.#lastNewAt = startedAt;
		}
		const info: LiveTickInfo = {
			index: this.#index++,
			sequenceChanged,
			grabMs,
			lateMs,
			fresh: this.#fresh || recovered,
		};
		this.#fresh = false;
		let wake: number | undefined;
		const h0 = this.#perf();
		try {
			const r = this.#o.handler.onFrame(frame, info);
			// Only the synchronous part counts as the loop's cost.
			const syncMs = this.#perf() - h0;
			this.#handlerMsTotal += syncMs;
			this.#handlerMsMax = Math.max(this.#handlerMsMax, syncMs);
			wake = r instanceof Promise ? await r : r;
		} catch {
			// A handler bug must not kill the loop; it reports its own errors.
			wake = undefined;
		}
		if (epoch !== this.#epoch) return;
		this.#busy = false;
		if (this.#state !== "running") return;
		this.#schedule(this.#nextDelay(startedAt, wake));
	}

	#nextDelay(startedAt: number, wake: number | undefined): number {
		const now = this.#o.timers.now();
		const idle = this.#o.idle ?? LIVE_IDLE_DEFAULT;
		const base = 1000 / this.#fps;
		const idleFor = now - this.#lastNewAt;
		this.#periodMs = idleFor >= idle.afterMs ? Math.max(base, idle.periodMs) : base;
		let period = this.#periodMs;
		if (wake !== undefined && Number.isFinite(wake)) {
			period = Math.min(period, Math.max(this.#o.minPeriodMs ?? 100, wake + (now - startedAt)));
		}
		return startedAt + period - now;
	}

	#failed(error: unknown): void {
		this.#errors++;
		this.#failures++;
		const code: CaptureErrorCode = isCaptureError(error) ? error.code : "failed";
		const message = error instanceof Error ? error.message : String(error);
		const fatal = FATAL.has(code);
		const retry = this.#o.retry ?? RETRY_DEFAULT;
		const retryInMs = fatal ? null : Math.min(retry.maxMs, retry.baseMs * 2 ** (this.#failures - 1));
		if (fatal) {
			this.#state = "paused";
			this.#epoch++;
		}
		this.#o.handler.onError?.({ code, message, fatal, consecutive: this.#failures, retryInMs });
		if (!fatal && this.#state === "running" && retryInMs !== null) this.#schedule(retryInMs);
	}
}
