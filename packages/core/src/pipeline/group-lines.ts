// GLIM-56: group OCR lines into blocks (paragraphs, dialogue boxes, menu items, columns) and put
// the blocks in reading order, so translation gets sensible chunks. Pure geometry + text.
//
// 1. Same-row fragments that the detector split (a wide word gap) are joined into one line.
// 2. Lines stack into a block when the upper one plausibly wraps into the lower one: similar
//    text size, a small gap, aligned edges (left for LTR, right for RTL, or centred), and the
//    upper line is long (a short line is a label, menu item or a paragraph's last line).
//    This keeps menu items, buttons and a dialogue's speaker name as their own blocks.
// 3. Vertical CJK (tall boxes, `vertical-rl`) runs the same rules in a rotated frame: columns
//    read top to bottom, and columns stack right to left.
// 4. Blocks are ordered by recursive XY-cut: split at full-width horizontal gaps (top to
//    bottom), else at full-height vertical gaps (columns: left to right, or right to left when
//    most text is RTL or vertical), else top-to-bottom.
//
// Thresholds are fractions of the line height (the text size), so they hold at any DPI.

import type { OcrBlock, OcrLine, WritingMode } from "../block.ts";
import type { Rect } from "../geometry.ts";
import { scriptDirection } from "../language/script.ts";
import { dominantScript } from "../language/script-count.ts";

export interface GroupOptions {
	/** Largest gap between stacked lines of one block, x line height. */
	readonly lineGap: number;
	/** The same for vertical columns (x column width): column spacing is wider than leading. */
	readonly columnGap: number;
	/** Largest ratio between the heights of stacked lines. */
	readonly sizeRatio: number;
	/** Edge alignment tolerance, x line height. */
	readonly alignTolerance: number;
	/** A line wraps into the next only if it is at least this many line heights long... */
	readonly minWrapLength: number;
	/** ...and at least this fraction of the next line's length. */
	readonly wrapRatio: number;
	/** Same-row fragments closer than this (x line height) are one line. */
	readonly wordGap: number;
	/** Block ids are `<prefix><n>` in reading order. */
	readonly idPrefix: string;
}

export const GROUP_DEFAULTS: GroupOptions = {
	lineGap: 0.6,
	columnGap: 1,
	sizeRatio: 1.5,
	alignTolerance: 1.5,
	minWrapLength: 6,
	wrapRatio: 0.6,
	wordGap: 0.6,
	idPrefix: "b",
};

/** True when a line should be treated as a vertical column. */
export function isVerticalLine(line: OcrLine): boolean {
	if (line.vertical !== undefined) return line.vertical;
	return line.box.height >= 1.5 * line.box.width && [...line.text].length >= 2;
}

// ---- frames ---------------------------------------------------------------------------
// Grouping works on horizontal "rows". Vertical columns are rotated into that frame: the
// column's top-to-bottom axis becomes x, and right-to-left column order becomes top to bottom.

interface Frame {
	to(r: Rect): Rect;
	from(r: Rect): Rect;
}
const horizontal: Frame = { to: (r) => r, from: (r) => r };
const verticalRl: Frame = {
	to: (r) => ({ x: r.y, y: -(r.x + r.width), width: r.height, height: r.width }),
	from: (r) => ({ x: -(r.y + r.height), y: r.x, width: r.height, height: r.width }),
};

interface Item {
	readonly lines: OcrLine[];
	/** In the working frame. */
	box: Rect;
	text: string;
	readonly rtl: boolean;
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const union = (a: Rect, b: Rect): Rect => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
};
const overlap1d = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

const isRtlText = (text: string) => {
	const d = dominantScript(text);
	return d !== null && scriptDirection(d.script) === "rtl";
};

// Scripts written without spaces between words: join fragments directly.
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}　-〿＀-￯]/u;

function joinFragments(a: string, b: string): string {
	const last = [...a].at(-1) ?? "";
	const first = [...b][0] ?? "";
	return NO_SPACE.test(last) && NO_SPACE.test(first) ? a + b : `${a} ${b}`;
}

/** Step 1: join same-row fragments with a small gap. */
function mergeRows(items: Item[], o: GroupOptions): Item[] {
	const sorted = [...items].sort((a, b) => a.box.x - b.box.x);
	const rows: Item[] = [];
	for (const it of sorted) {
		const h = it.box.height;
		const row = rows.find((r) => {
			const rh = r.box.height;
			const minH = Math.min(h, rh);
			if (Math.max(h, rh) / Math.max(1, minH) > o.sizeRatio) return false;
			if (overlap1d(r.box.y, bottom(r.box), it.box.y, bottom(it.box)) < 0.6 * minH) return false;
			const gap = it.box.x - right(r.box);
			return gap <= o.wordGap * Math.max(h, rh) && gap >= -0.5 * minH;
		});
		if (!row) {
			rows.push({ ...it, lines: [...it.lines] });
			continue;
		}
		// Sorted by x, so `it` is to the right; RTL rows read right to left.
		row.text = row.rtl && it.rtl ? joinFragments(it.text, row.text) : joinFragments(row.text, it.text);
		row.lines.push(...it.lines);
		row.box = union(row.box, it.box);
	}
	return rows;
}

/** Step 2: stack wrapped lines into blocks. Returns groups of rows, top to bottom. */
function stackRows(rows: Item[], o: GroupOptions): Item[][] {
	const sorted = [...rows].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
	/** The nearest row below `a` that overlaps it horizontally. */
	const below = (a: Item): Item | null => {
		let best: Item | null = null;
		for (const b of sorted) {
			if (b === a || b.box.y < a.box.y + 0.5 * a.box.height) continue;
			if (overlap1d(a.box.x, right(a.box), b.box.x, right(b.box)) <= 0) continue;
			if (!best || b.box.y < best.box.y) best = b;
		}
		return best;
	};
	const above = (b: Item): Item | null => {
		let best: Item | null = null;
		for (const a of sorted) {
			if (a === b || b.box.y < a.box.y + 0.5 * a.box.height) continue;
			if (overlap1d(a.box.x, right(a.box), b.box.x, right(b.box)) <= 0) continue;
			if (!best || a.box.y > best.box.y) best = a;
		}
		return best;
	};
	const wraps = (a: Item, b: Item): boolean => {
		const ha = a.box.height;
		const hb = b.box.height;
		const h = (ha + hb) / 2;
		if (Math.max(ha, hb) / Math.max(1, Math.min(ha, hb)) > o.sizeRatio) return false;
		const gap = b.box.y - bottom(a.box);
		if (gap > o.lineGap * h || gap < -0.4 * h) return false;
		const tol = o.alignTolerance * h;
		const leftAligned = Math.abs(a.box.x - b.box.x) <= tol;
		const rightAligned = Math.abs(right(a.box) - right(b.box)) <= tol;
		// Centred text (subtitles, dialogs) wraps around one centre line, so it gets a tighter tolerance.
		const centred = Math.abs(a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2)) <= 0.5 * h;
		const aligned = a.rtl ? rightAligned || centred : leftAligned || centred;
		if (!aligned) return false;
		return a.box.width >= o.minWrapLength * ha && a.box.width >= o.wrapRatio * b.box.width;
	};
	const next = new Map<Item, Item>();
	const hasPrev = new Set<Item>();
	for (const a of sorted) {
		const b = below(a);
		if (b && above(b) === a && wraps(a, b)) {
			next.set(a, b);
			hasPrev.add(b);
		}
	}
	const groups: Item[][] = [];
	for (const a of sorted) {
		if (hasPrev.has(a)) continue;
		const g: Item[] = [a];
		for (let n = next.get(a); n; n = next.get(n)) g.push(n);
		groups.push(g);
	}
	return groups;
}

interface Draft {
	readonly box: Rect;
	readonly text: string;
	readonly confidence: number;
	readonly lines: readonly OcrLine[];
	readonly writing: WritingMode;
	readonly rtl: boolean;
}

function groupInFrame(lines: readonly OcrLine[], frame: Frame, writing: WritingMode, o: GroupOptions): Draft[] {
	const items: Item[] = lines.map((l) => ({ lines: [l], box: frame.to(l.box), text: l.text, rtl: isRtlText(l.text) }));
	const stackOptions = writing === "vertical-rl" ? { ...o, lineGap: o.columnGap } : o;
	const groups = stackRows(mergeRows(items, o), stackOptions);
	return groups.map((rows) => {
		const all = rows.flatMap((r) => r.lines);
		const weight = (l: OcrLine) => Math.max(1, [...l.text].length);
		const total = all.reduce((n, l) => n + weight(l), 0);
		const confidence = all.reduce((n, l) => n + l.confidence * weight(l), 0) / total;
		const box = frame.from(rows.map((r) => r.box).reduce(union));
		return {
			box,
			text: rows.map((r) => r.text).join("\n"),
			confidence,
			lines: all,
			writing,
			rtl: rows.some((r) => r.rtl),
		};
	});
}

// ---- reading order (recursive XY-cut) -----------------------------------------------------

function cut(drafts: readonly Draft[], axis: "x" | "y"): Draft[][] {
	const start = (d: Draft) => (axis === "y" ? d.box.y : d.box.x);
	const end = (d: Draft) => (axis === "y" ? bottom(d.box) : right(d.box));
	const sorted = [...drafts].sort((a, b) => start(a) - start(b));
	const groups: Draft[][] = [];
	let reach = Number.NEGATIVE_INFINITY;
	for (const d of sorted) {
		const current = groups.at(-1);
		if (!current || start(d) >= reach - 1) groups.push([d]);
		else current.push(d);
		reach = Math.max(reach, end(d));
	}
	return groups;
}

function readingOrder(drafts: readonly Draft[], rtlColumns: boolean): Draft[] {
	if (drafts.length <= 1) return [...drafts];
	const rows = cut(drafts, "y");
	if (rows.length > 1) return rows.flatMap((g) => readingOrder(g, rtlColumns));
	const cols = cut(drafts, "x");
	if (cols.length > 1) {
		const ordered = rtlColumns ? [...cols].reverse() : cols;
		return ordered.flatMap((g) => readingOrder(g, rtlColumns));
	}
	return [...drafts].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/**
 * Group lines into blocks in reading order. Block ids are `b0`, `b1`, ... in that order
 * (unique within the result; use `BlockIdTracker` for ids that stay stable across Live frames).
 */
export function groupLines(lines: readonly OcrLine[], options: Partial<GroupOptions> = {}): OcrBlock[] {
	const o = { ...GROUP_DEFAULTS, ...options };
	const kept = lines.filter((l) => l.text.trim() !== "" && l.box.width > 0 && l.box.height > 0);
	const vertical = kept.filter(isVerticalLine);
	const flat = kept.filter((l) => !isVerticalLine(l));
	const drafts = [
		...groupInFrame(flat, horizontal, "horizontal-tb", o),
		...groupInFrame(vertical, verticalRl, "vertical-rl", o),
	];
	const letters = (d: Draft) => [...d.text].length;
	const rtlish = drafts.filter((d) => d.rtl || d.writing === "vertical-rl").reduce((n, d) => n + letters(d), 0);
	const all = drafts.reduce((n, d) => n + letters(d), 0);
	const ordered = readingOrder(drafts, rtlish * 2 > all);
	return ordered.map((d, i) => ({
		id: `${o.idPrefix}${i}`,
		box: roundRect(d.box),
		text: d.text,
		confidence: d.confidence,
		lines: d.lines,
		writing: d.writing,
	}));
}

function roundRect(r: Rect): Rect {
	const x = Math.floor(r.x);
	const y = Math.floor(r.y);
	return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}
