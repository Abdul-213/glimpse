// GLIM-64: scoring for the OCR benchmark. Pure: ground truth + engine output in, numbers out.
//
// Recognition is scored per line so a grouping or reading-order mistake doesn't show up as
// a recognition error: each engine line is assigned to the ground-truth line whose ink box
// (grown by half a line height) contains its centre. Lines that land nowhere are false
// positives and count as insertions. CER = character edits / ground-truth characters, WER the
// same over whitespace-separated words (not defined for scripts written without spaces).
// Text is NFKC-normalised with whitespace collapsed on both sides, so full-width vs ASCII
// punctuation and double spaces don't count.
//
// Grouping is scored per block: a ground-truth block is "exact" when all its lines ended up in
// one engine block that holds nothing else. Reading order: the engine's blocks, mapped to the
// ground-truth block they mostly hold, must come out in ground-truth order. Detection: the
// GLIM-21 decision for the engine block that holds most of a ground-truth block's lines.

import type { BlockLanguage, OcrBlock, OcrLine, Rect } from "@glimpse/core";

export interface TruthLine {
	readonly text: string;
	readonly box: Rect;
	readonly vertical?: boolean;
}
export interface TruthBlock {
	/** BCP-47; the language detection should report. */
	readonly lang: string;
	readonly lines: readonly TruthLine[];
}
export interface CorpusCase {
	readonly id: string;
	readonly image: string;
	readonly width: number;
	readonly height: number;
	/** Script family the case is reported under (Latin, CJK, Arabic, Cyrillic, Devanagari, ...). */
	readonly script: string;
	readonly kind: "rendered" | "screenshot-like";
	/** The user's source subset for this case: passed to OCR (recogniser choice) and detection. */
	readonly sources: readonly string[];
	readonly note?: string;
	readonly jpeg?: number;
	/** Reading order. */
	readonly blocks: readonly TruthBlock[];
}
export interface Corpus {
	readonly schema: 1;
	readonly cases: readonly CorpusCase[];
}

/** Languages written without spaces between words: no WER. */
const NO_SPACES = new Set(["ja", "zh", "th", "lo", "km", "my"]);
const primary = (lang: string) => lang.split("-")[0] ?? lang;

export const normalise = (s: string): string => s.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** Levenshtein distance over two token arrays. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
			cur.push(Math.min(sub, (prev[j] as number) + 1, (cur[j - 1] as number) + 1));
		}
		prev = cur;
	}
	return prev[b.length] as number;
}

const chars = (s: string) => [...normalise(s)].filter((c) => c !== " ");
const words = (s: string) => normalise(s).split(" ").filter(Boolean);

/** Characters compared without spaces: a word-gap the engine missed or added isn't a character error. */
export function charEdits(truth: string, got: string): number {
	return editDistance(chars(truth), chars(got));
}
export function wordEdits(truth: string, got: string): number {
	return editDistance(words(truth), words(got));
}

/** Nearest-rank percentile, p in 0..1. */
export function percentile(xs: readonly number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}

const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);
function intersection(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}
function grow(r: Rect, vertical: boolean): Rect {
	const t = vertical ? r.width : r.height;
	return { x: r.x - t / 2, y: r.y - t / 2, width: r.width + t, height: r.height + t };
}

interface OutLine {
	readonly line: OcrLine;
	readonly block: number;
}

/** Engine lines of each block (blocks without `lines` are one line). */
export function engineLines(blocks: readonly OcrBlock[]): OutLine[] {
	return blocks.flatMap((b, block) =>
		(b.lines ?? [{ box: b.box, text: b.text, confidence: b.confidence }]).map((line) => ({ line, block })),
	);
}

export interface LineScore {
	readonly truth: string;
	readonly got: string;
	readonly charEdits: number;
	readonly chars: number;
	readonly wordEdits: number | null;
	readonly words: number | null;
}
export interface CaseScore {
	readonly lines: readonly LineScore[];
	/** Engine lines that matched no ground-truth line. */
	readonly extra: readonly string[];
	readonly charEdits: number;
	readonly chars: number;
	readonly wordEdits: number | null;
	readonly words: number | null;
	readonly cer: number;
	readonly wer: number | null;
	readonly blocks: {
		readonly truth: number;
		readonly got: number;
		readonly exact: number;
		readonly split: number;
		readonly merged: number;
		/** Human-readable grouping misses: which ground-truth blocks were split or merged. */
		readonly notes: readonly string[];
	};
	readonly orderCorrect: boolean;
	readonly detection: {
		readonly correct: number;
		readonly total: number;
		readonly misses: readonly { readonly text: string; readonly expected: string; readonly got: string }[];
	};
}

export function describeLanguage(l: BlockLanguage | undefined): string {
	if (!l) return "none";
	if (l.kind === "neutral") return "neutral";
	if (l.kind === "skipped") return `skipped(${l.lang ?? "?"})`;
	return l.lang;
}

export function scoreCase(
	c: CorpusCase,
	blocks: readonly OcrBlock[],
	languages: readonly BlockLanguage[] = [],
): CaseScore {
	const truth = c.blocks.flatMap((b, block) => b.lines.map((line) => ({ line, block, lang: b.lang })));
	const out = engineLines(blocks);
	// Assign each engine line to one ground-truth line.
	const assigned: number[][] = truth.map(() => []);
	const extra: string[] = [];
	out.forEach((o, i) => {
		const p = centre(o.line.box);
		let best = -1;
		let bestScore = 0;
		truth.forEach((t, j) => {
			const g = grow(t.line.box, t.line.vertical === true);
			if (p.x < g.x || p.x > g.x + g.width || p.y < g.y || p.y > g.y + g.height) return;
			const s = intersection(o.line.box, t.line.box) / Math.max(1, area(o.line.box)) + 1e-6;
			if (s > bestScore) {
				best = j;
				bestScore = s;
			}
		});
		if (best >= 0) (assigned[best] as number[]).push(i);
		else extra.push(o.line.text);
	});

	const noSpaces = (lang: string) => NO_SPACES.has(primary(lang));
	const rtl = (lang: string) => ["ar", "fa", "ur", "he"].includes(primary(lang));
	const lines: LineScore[] = truth.map((t, j) => {
		const parts = (assigned[j] as number[]).map((i) => (out[i] as OutLine).line);
		const vertical = t.line.vertical === true;
		parts.sort((a, b) => (vertical ? a.box.y - b.box.y : rtl(t.lang) ? b.box.x - a.box.x : a.box.x - b.box.x));
		const got = parts.map((l) => l.text).join(noSpaces(t.lang) ? "" : " ");
		const ws = noSpaces(t.lang) ? null : words(t.line.text).length;
		return {
			truth: t.line.text,
			got,
			charEdits: charEdits(t.line.text, got),
			chars: chars(t.line.text).length,
			wordEdits: ws === null ? null : wordEdits(t.line.text, got),
			words: ws,
		};
	});
	const extraChars = extra.reduce((n, s) => n + chars(s).length, 0);
	const extraWords = extra.reduce((n, s) => n + words(s).length, 0);
	const sum = (f: (l: LineScore) => number) => lines.reduce((n, l) => n + f(l), 0);
	const charE = sum((l) => l.charEdits) + extraChars;
	const charN = sum((l) => l.chars);
	const hasWords = lines.some((l) => l.words !== null);
	const wordE = hasWords ? sum((l) => l.wordEdits ?? 0) + extraWords : null;
	const wordN = hasWords ? sum((l) => l.words ?? 0) : null;

	// Grouping: which engine blocks hold each ground-truth block's lines.
	const blocksOfTruth = c.blocks.map(() => new Set<number>());
	const truthOfBlock = blocks.map(() => new Set<number>());
	const linesPerPair = new Map<string, number>();
	truth.forEach((t, j) => {
		for (const i of assigned[j] as number[]) {
			const ob = (out[i] as OutLine).block;
			(blocksOfTruth[t.block] as Set<number>).add(ob);
			(truthOfBlock[ob] as Set<number>).add(t.block);
			const k = `${t.block}:${ob}`;
			linesPerPair.set(k, (linesPerPair.get(k) ?? 0) + 1);
		}
	});
	let exact = 0;
	let split = 0;
	blocksOfTruth.forEach((set) => {
		if (set.size > 1) split++;
		const only = [...set][0];
		if (set.size === 1 && only !== undefined && (truthOfBlock[only] as Set<number>).size === 1) exact++;
	});
	const merged = truthOfBlock.filter((s) => s.size > 1).length;
	const first = (b: number) => `"${c.blocks[b]?.lines[0]?.text ?? ""}"`;
	const groupNotes = [
		...blocksOfTruth.flatMap((set, b) => (set.size > 1 ? [`${first(b)} split into ${set.size} blocks`] : [])),
		...truthOfBlock.flatMap((set) =>
			set.size > 1
				? [
						`merged into one block: ${[...set]
							.sort((a, b) => a - b)
							.map(first)
							.join(" + ")}`,
					]
				: [],
		),
	];

	// Reading order: each engine block stands for the ground-truth block it holds most of.
	const mainTruth = blocks.map((_, ob) => {
		let best = -1;
		let n = 0;
		for (const tb of truthOfBlock[ob] as Set<number>) {
			const k = linesPerPair.get(`${tb}:${ob}`) ?? 0;
			if (k > n) {
				best = tb;
				n = k;
			}
		}
		return best;
	});
	const seq = mainTruth.filter((t) => t >= 0);
	const orderCorrect = seq.every((t, i) => i === 0 || t >= (seq[i - 1] as number));

	// Detection: the decision for the engine block holding most of each ground-truth block.
	const misses: { text: string; expected: string; got: string }[] = [];
	let correct = 0;
	c.blocks.forEach((tb, b) => {
		let best = -1;
		let n = 0;
		for (const ob of blocksOfTruth[b] as Set<number>) {
			const k = linesPerPair.get(`${b}:${ob}`) ?? 0;
			if (k > n) {
				best = ob;
				n = k;
			}
		}
		const decision = best >= 0 ? languages[best] : undefined;
		if (decision?.kind === "language" && primary(decision.lang) === primary(tb.lang)) correct++;
		else
			misses.push({
				text: tb.lines.map((l) => l.text).join(" / "),
				expected: tb.lang,
				got: describeLanguage(decision),
			});
	});

	return {
		lines,
		extra,
		charEdits: charE,
		chars: charN,
		wordEdits: wordE,
		words: wordN,
		cer: charN > 0 ? charE / charN : 0,
		wer: wordE !== null && wordN ? wordE / wordN : null,
		blocks: { truth: c.blocks.length, got: blocks.length, exact, split, merged, notes: groupNotes },
		orderCorrect,
		detection: { correct, total: c.blocks.length, misses },
	};
}

// ---- aggregation and the regression gate ---------------------------------------------------

export interface CaseResult {
	readonly id: string;
	readonly script: string;
	readonly kind: CorpusCase["kind"];
	readonly score: CaseScore;
	/** Wall time of the first call (recogniser load + first run), ms. */
	readonly firstMs: number;
	/** Warm wall times, ms. */
	readonly runs: readonly number[];
}

export interface ScriptSummary {
	readonly cases: number;
	readonly cer: number;
	readonly wer: number | null;
	/** Fraction of ground-truth blocks grouped exactly. */
	readonly grouping: number;
	/** Fraction of cases whose block order is right. */
	readonly order: number;
	/** Fraction of ground-truth blocks detected as the right language. */
	readonly detection: number;
	readonly p50: number;
	readonly p90: number;
}

export interface Summary {
	readonly scripts: Readonly<Record<string, ScriptSummary>>;
	readonly all: ScriptSummary;
	/** Sum of the per-case warm p50s, ms: the latency figure the gate compares. */
	readonly totalP50: number;
}

function summarise(results: readonly CaseResult[]): ScriptSummary {
	const s = (f: (r: CaseResult) => number) => results.reduce((n, r) => n + f(r), 0);
	const chars = s((r) => r.score.chars);
	const withWords = results.filter((r) => r.score.words !== null);
	const words = withWords.reduce((n, r) => n + (r.score.words ?? 0), 0);
	const truthBlocks = s((r) => r.score.blocks.truth);
	const runs = results.flatMap((r) => r.runs);
	return {
		cases: results.length,
		cer: chars ? s((r) => r.score.charEdits) / chars : 0,
		wer: words ? withWords.reduce((n, r) => n + (r.score.wordEdits ?? 0), 0) / words : null,
		grouping: truthBlocks ? s((r) => r.score.blocks.exact) / truthBlocks : 1,
		order: results.length ? results.filter((r) => r.score.orderCorrect).length / results.length : 1,
		detection: truthBlocks ? s((r) => r.score.detection.correct) / truthBlocks : 1,
		p50: percentile(runs, 0.5),
		p90: percentile(runs, 0.9),
	};
}

export function summariseAll(results: readonly CaseResult[]): Summary {
	const scripts: Record<string, ScriptSummary> = {};
	for (const script of [...new Set(results.map((r) => r.script))]) {
		scripts[script] = summarise(results.filter((r) => r.script === script));
	}
	return {
		scripts,
		all: summarise(results),
		totalP50: results.reduce((n, r) => n + percentile(r.runs, 0.5), 0),
	};
}

/**
 * What counts as a large regression. CI runners are shared and noisy, and a different CPU
 * moves floating point a little, so the gate only trips on changes nobody would call noise.
 */
export interface Thresholds {
	/** Per-script CER may rise by max(cerAbs, cerRel x baseline). */
	readonly cerAbs: number;
	readonly cerRel: number;
	/** Per-script grouping / detection fractions may fall by this much. */
	readonly fractionDrop: number;
	/** The summed warm p50 may grow to this multiple of the baseline. */
	readonly latencyFactor: number;
}

export const THRESHOLDS: Thresholds = { cerAbs: 0.03, cerRel: 0.5, fractionDrop: 0.2, latencyFactor: 3 };

export interface Baseline {
	readonly machine: string;
	readonly scripts: Readonly<Record<string, Pick<ScriptSummary, "cer" | "grouping" | "detection">>>;
	readonly totalP50: number;
}

export function toBaseline(summary: Summary, machine: string): Baseline {
	const scripts: Record<string, Pick<ScriptSummary, "cer" | "grouping" | "detection">> = {};
	const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
	for (const [k, v] of Object.entries(summary.scripts)) {
		scripts[k] = { cer: r4(v.cer), grouping: r4(v.grouping), detection: r4(v.detection) };
	}
	return { machine, scripts, totalP50: Math.round(summary.totalP50) };
}

/** Regressions beyond the thresholds, as sentences. Empty: pass. */
export function regressions(
	summary: Summary,
	baseline: Baseline,
	t: Thresholds = THRESHOLDS,
	opts: { latency?: boolean } = {},
): string[] {
	const out: string[] = [];
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	for (const [script, base] of Object.entries(baseline.scripts)) {
		const cur = summary.scripts[script];
		if (!cur) {
			out.push(`${script}: no cases ran (baseline has it)`);
			continue;
		}
		const cerLimit = base.cer + Math.max(t.cerAbs, t.cerRel * base.cer);
		if (cur.cer > cerLimit)
			out.push(`${script}: CER ${pct(cur.cer)} > limit ${pct(cerLimit)} (baseline ${pct(base.cer)})`);
		if (cur.grouping < base.grouping - t.fractionDrop) {
			out.push(`${script}: grouping ${pct(cur.grouping)} < baseline ${pct(base.grouping)} - ${pct(t.fractionDrop)}`);
		}
		if (cur.detection < base.detection - t.fractionDrop) {
			out.push(`${script}: detection ${pct(cur.detection)} < baseline ${pct(base.detection)} - ${pct(t.fractionDrop)}`);
		}
	}
	if (opts.latency !== false && summary.totalP50 > t.latencyFactor * baseline.totalP50) {
		out.push(
			`latency: summed p50 ${Math.round(summary.totalP50)} ms > ${t.latencyFactor}x baseline ${baseline.totalP50} ms`,
		);
	}
	return out;
}
