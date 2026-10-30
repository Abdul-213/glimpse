// Latency statistics. Nearest-rank percentiles (no interpolation) so a p95 over
// 50 samples is an actual observed sample.

export interface LatencySummary {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	if (p <= 0) return sorted[0]!;
	if (p >= 100) return sorted[sorted.length - 1]!;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.max(0, rank - 1)]!;
}

export function summarize(samples: number[]): LatencySummary {
	const sorted = [...samples].sort((a, b) => a - b);
	const n = sorted.length;
	const mean = n === 0 ? Number.NaN : sorted.reduce((s, v) => s + v, 0) / n;
	return {
		n,
		min: n ? sorted[0]! : Number.NaN,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: n ? sorted[n - 1]! : Number.NaN,
		mean,
	};
}

export function fmtMs(v: number): string {
	return Number.isFinite(v) ? `${v.toFixed(2)} ms` : "n/a";
}

export function formatSummary(s: LatencySummary): string {
	return `n=${s.n} p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} min=${fmtMs(s.min)} max=${fmtMs(s.max)} mean=${fmtMs(s.mean)}`;
}
