export interface Stats { n: number; p50: number; p90: number; min: number; max: number }

/** Nearest-rank percentiles, rounded to 0.1 ms. */
export function stats(xs: number[]): Stats {
  if (xs.length === 0) return { n: 0, p50: 0, p90: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(pick(0.5)), p90: r(pick(0.9)), min: r(s[0]!), max: r(s[s.length - 1]!) };
}
