// GLIM-66: the Live CPU budget and its adaptive back-off. Pure: CPU readings in, a level out.
//
// Live runs for as long as a region is pinned, often on battery, so it has a budget: on
// average over a rolling window, Live may use at most `shareOfCore` of one CPU core
// (docs/benchmarks/live-cpu.md: 35 % over 30 s, measured costs and why). The runner reads the process
// CPU (or its own cost estimate) on every grab. When the window's average is over budget the
// budget steps up a level, and each level captures less often and reads less often:
//
//   level 0  the user's frame rate, OCR as soon as a change settles
//   level 1  at most 3 fps, at least 1 s between OCR runs
//   level 2  2 fps, at least 2 s between OCR runs
//   level 3  2 fps, at least 3 s between OCR runs (a subtitle up for 3 s is still read)
//
// Fast-changing content (a chat that scrolls every second, rapid subtitles) is then read less
// often, latest frame wins; nothing is skipped for good. After each step the window restarts,
// so the next decision measures the new level. When the average stays under half the budget
// for `relaxAfterMs`, it steps back down one level.
//
// Idle back-off (a static region) is the capture loop's (GLIM-48: 2 fps after 2 s without new
// frames, and no pixel diff for frames the backend reports unchanged). The runner adds the same
// for a moving background whose text holds still (`LIVE_QUIET_FOCUS`). This budget is for the
// active case.

/** Over a moving background (text focus) with nothing to read for `afterMs`: capture at `fps`. */
export const LIVE_QUIET_FOCUS = { afterMs: 2000, fps: 2 } as const;

export interface LiveBudgetLevel {
	/** Frame-rate cap (the user's setting applies when lower). */
	readonly fpsCap: number;
	/** Minimum time between the starts of two OCR runs, ms. */
	readonly ocrGapMs: number;
}

export const LIVE_BUDGET_LEVELS: readonly LiveBudgetLevel[] = [
	{ fpsCap: 4, ocrGapMs: 0 },
	{ fpsCap: 3, ocrGapMs: 1000 },
	{ fpsCap: 2, ocrGapMs: 2000 },
	{ fpsCap: 2, ocrGapMs: 3000 },
];

export interface LiveBudgetOptions {
	/** Average CPU Live may use, as a share of one core (0.15 = 15 %). */
	readonly shareOfCore: number;
	/** Rolling window the average is taken over, ms. */
	readonly windowMs: number;
	/** Step back down when the average stays under `relaxBelow` x budget for this long. */
	readonly relaxBelow: number;
	readonly relaxAfterMs: number;
	readonly levels: readonly LiveBudgetLevel[];
}

export const LIVE_BUDGET_DEFAULTS: LiveBudgetOptions = {
	shareOfCore: 0.35,
	windowMs: 30_000,
	relaxBelow: 0.5,
	relaxAfterMs: 60_000,
	levels: LIVE_BUDGET_LEVELS,
};

export interface LiveBudgetState {
	readonly level: number;
	readonly limits: LiveBudgetLevel;
	/** Average share of one core over the current window; null until the window has filled. */
	readonly share: number | null;
}

export class LiveBudget {
	readonly #o: LiveBudgetOptions;
	#level = 0;
	/** Readings (time, cumulative CPU ms) in the current window, oldest first. */
	#samples: { t: number; cpu: number }[] = [];
	#windowStart: number | null = null;
	#calmSince: number | null = null;
	#share: number | null = null;

	constructor(options: Partial<LiveBudgetOptions> = {}) {
		this.#o = { ...LIVE_BUDGET_DEFAULTS, ...options };
		if (this.#o.levels.length === 0) throw new Error("LiveBudget needs at least one level");
	}

	get options(): Readonly<LiveBudgetOptions> {
		return this.#o;
	}

	state(): LiveBudgetState {
		return { level: this.#level, limits: this.#limits(), share: this.#share };
	}

	/** Forget the readings (pause, resume, a new session): the next ones start a new window. */
	restart(): void {
		this.#samples = [];
		this.#windowStart = null;
		this.#calmSince = null;
		this.#share = null;
	}

	/**
	 * A reading: `cpuMs` is a cumulative CPU counter (process CPU time, or the runner's own
	 * cost total) at `now`. Returns the new state when the level changed, else null.
	 */
	sample(now: number, cpuMs: number): LiveBudgetState | null {
		this.#windowStart ??= now;
		this.#samples.push({ t: now, cpu: cpuMs });
		while (this.#samples.length > 2 && (this.#samples[1]?.t ?? now) <= now - this.#o.windowMs) this.#samples.shift();
		const first = this.#samples[0];
		if (!first || now - this.#windowStart < this.#o.windowMs || now <= first.t) return null;
		const share = Math.max(0, cpuMs - first.cpu) / (now - first.t);
		this.#share = share;
		const budget = this.#o.shareOfCore;
		if (share > budget && this.#level < this.#o.levels.length - 1) {
			this.#level++;
			this.#afterStep(now, cpuMs);
			return this.state();
		}
		if (share < this.#o.relaxBelow * budget && this.#level > 0) {
			this.#calmSince ??= now;
			if (now - this.#calmSince >= this.#o.relaxAfterMs) {
				this.#level--;
				this.#afterStep(now, cpuMs);
				return this.state();
			}
		} else {
			this.#calmSince = null;
		}
		return null;
	}

	#afterStep(now: number, cpuMs: number): void {
		this.#samples = [{ t: now, cpu: cpuMs }];
		this.#windowStart = now;
		this.#calmSince = null;
	}

	#limits(): LiveBudgetLevel {
		const levels = this.#o.levels;
		return levels[Math.min(this.#level, levels.length - 1)] as LiveBudgetLevel;
	}
}
