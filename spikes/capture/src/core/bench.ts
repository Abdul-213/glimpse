// Benchmark harness. Clock, sleep and CPU sampling are injectable so the
// scheduling/accounting logic is unit-tested without a screen.
import { summarize, type LatencySummary } from "./stats";

export interface BenchDeps {
	now: () => number; // ms, monotonic
	sleep: (ms: number) => Promise<void>;
	cpuMicros: () => number; // user+system CPU of this process, microseconds
}

export const realDeps: BenchDeps = {
	now: () => performance.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
	cpuMicros: () => {
		const u = process.cpuUsage();
		return u.user + u.system;
	},
};

export interface LatencyResult {
	label: string;
	warmupMs: number[];
	summary: LatencySummary;
	failures: number;
	firstError?: string;
}

/**
 * Time `n` sequential captures after `warmup` untimed ones. The first (cold)
 * capture is reported separately: for persistent backends (DXGI, WGC, SCStream)
 * it includes session start-up, which is what a Snip pays if nothing is warm.
 */
export async function latencyBench(
	label: string,
	capture: () => void,
	n = 50,
	warmup = 2,
	deps: BenchDeps = realDeps,
	gapMs = 0,
): Promise<LatencyResult> {
	const warmupMs: number[] = [];
	const samples: number[] = [];
	let failures = 0;
	let firstError: string | undefined;
	const run = () => {
		const t0 = deps.now();
		try {
			capture();
		} catch (e) {
			failures++;
			firstError ??= String((e as Error)?.message ?? e);
			return null;
		}
		return deps.now() - t0;
	};
	for (let i = 0; i < warmup; i++) {
		const t = run();
		if (t !== null) warmupMs.push(t);
	}
	for (let i = 0; i < n; i++) {
		const t = run();
		if (t !== null) samples.push(t);
		if (gapMs > 0) await deps.sleep(gapMs);
	}
	return { label, warmupMs, summary: summarize(samples), failures, firstError };
}

export interface LoopResult {
	label: string;
	fps: number;
	durationMs: number;
	ticksScheduled: number;
	framesCaptured: number;
	/** Ticks skipped because the previous capture overran its slot. */
	dropped: number;
	failures: number;
	/** Captures whose pixels were identical to the previous capture. */
	unchanged: number;
	latency: LatencySummary;
	/** Average CPU over the loop as % of one core. */
	cpuPercent: number;
	firstError?: string;
}

/**
 * Fixed-rate loop: tick k is due at t0 + k*period. If a capture finishes after
 * the *next* tick's due time, the missed ticks are counted as dropped and the
 * loop resynchronises to the schedule (it never bursts to catch up).
 * `capture` returns a content hash (or null) so unchanged frames are counted.
 */
export async function fixedRateLoop(
	label: string,
	capture: () => number | null,
	fps = 4,
	durationMs = 30_000,
	deps: BenchDeps = realDeps,
): Promise<LoopResult> {
	const period = 1000 / fps;
	const total = Math.floor(durationMs / period);
	const lat: number[] = [];
	let dropped = 0;
	let failures = 0;
	let captured = 0;
	let unchanged = 0;
	let lastHash: number | null = null;
	let firstError: string | undefined;

	const cpu0 = deps.cpuMicros();
	const t0 = deps.now();
	let k = 0;
	while (k < total) {
		const due = t0 + k * period;
		const wait = due - deps.now();
		if (wait > 0) await deps.sleep(wait);
		const s = deps.now();
		try {
			const h = capture();
			captured++;
			if (h !== null && h === lastHash) unchanged++;
			lastHash = h;
		} catch (e) {
			failures++;
			firstError ??= String((e as Error)?.message ?? e);
		}
		const end = deps.now();
		lat.push(end - s);
		// Next tick index that is still in the future (or exactly now).
		const next = Math.max(k + 1, Math.ceil((end - t0) / period - 1e-9));
		dropped += Math.min(next, total) - (k + 1);
		k = next;
	}
	const wall = deps.now() - t0;
	const cpu = deps.cpuMicros() - cpu0;
	return {
		label,
		fps,
		durationMs: wall,
		ticksScheduled: total,
		framesCaptured: captured,
		dropped,
		failures,
		unchanged,
		latency: summarize(lat),
		cpuPercent: wall > 0 ? (cpu / 1000 / wall) * 100 : 0,
		firstError,
	};
}
