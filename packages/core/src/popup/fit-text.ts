// GLIM-152: fit a translation into the box of the text it translates, for the on-screen
// overlay (snip-popup.md §2.5). Pure: the view passes a `measure` function (canvas
// `measureText` with the card's real font), so this is tested on Linux with a fake one.
//
// Rule: the largest size from `maxPx` down to `minPx` (in `step`s) at which the wrapped text
// fits the box. If even `minPx` doesn't fit, the text stays at `minPx` and the card grows
// downward. A card is never narrower than `minWidth`, nor than the longest word at `minPx`
// (up to `maxWidth`): a tall, narrow manga column would otherwise put one letter per line.
// The extra width is shared on both sides of the box (`offsetX` < 0), keeping it centred.

export interface FitTextOptions {
	/** Largest text size (px): the popup's `translation` size, 15. */
	readonly maxPx: number;
	/** Smallest readable size (px) before the card grows instead. */
	readonly minPx: number;
	readonly step: number;
	/** Line height as a multiple of the size (per script: 1.5 Latin, 1.7 CJK…). */
	readonly lineHeight: number;
	/** Card padding (px) on each side, inline and block. */
	readonly padX: number;
	readonly padY: number;
	/** Narrowest card (px). */
	readonly minWidth: number;
	/** Widest a card may become to fit a long word (px); the box width wins if it is wider. */
	readonly maxWidth: number;
	/** BCP-47 tag of the text, for word segmentation (Thai, CJK). */
	readonly lang?: string;
}

export const FIT_DEFAULTS: FitTextOptions = {
	maxPx: 15,
	minPx: 11,
	step: 0.5,
	lineHeight: 1.5,
	padX: 6,
	padY: 4,
	minWidth: 72,
	maxWidth: 240,
};

/** Width of `text` at `px` (px). */
export type MeasureText = (text: string, px: number) => number;

export interface FitTextResult {
	/** Text size (px). */
	readonly px: number;
	/** Line height (px). */
	readonly linePx: number;
	readonly lines: readonly string[];
	/** Card size (px), padding included. */
	readonly width: number;
	readonly height: number;
	/** Card left edge relative to the box's (≤ 0: widened around the box). */
	readonly offsetX: number;
	/** The text is at `minPx` and the card is taller than the box. */
	readonly grew: boolean;
}

// Scripts written without spaces between words: every word (from the segmenter) is a break
// opportunity. Punctuation stays with the word before it.
const NO_SPACE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(lang: string | undefined, granularity: "word" | "grapheme"): Intl.Segmenter {
	const key = `${lang ?? ""}|${granularity}`;
	let s = segmenters.get(key);
	if (!s) {
		try {
			s = new Intl.Segmenter(lang, { granularity });
		} catch {
			s = new Intl.Segmenter(undefined, { granularity });
		}
		segmenters.set(key, s);
	}
	return s;
}

/**
 * Split a paragraph into unbreakable pieces ("atoms"), each with the whitespace that follows
 * it. Lines may break only between atoms.
 */
export function textAtoms(text: string, lang?: string): string[] {
	const atoms: string[] = [];
	let cur = "";
	for (const seg of segmenter(lang, "word").segment(text)) {
		const s = seg.segment;
		if (/^\s+$/u.test(s)) {
			atoms.push(cur + s);
			cur = "";
		} else if (cur !== "" && seg.isWordLike && NO_SPACE.test(s) && NO_SPACE.test([...cur].at(-1) ?? "")) {
			atoms.push(cur);
			cur = s;
		} else cur += s;
	}
	if (cur !== "") atoms.push(cur);
	return atoms;
}

/** Greedy wrap to `width` px at `px`. A word wider than a line is broken between graphemes. */
export function wrapText(text: string, width: number, px: number, measure: MeasureText, lang?: string): string[] {
	const lines: string[] = [];
	for (const para of text.split(/\r?\n/)) {
		let line = "";
		const fits = (s: string) => measure(s.trimEnd(), px) <= width + 0.01;
		const push = () => {
			lines.push(line.trimEnd());
			line = "";
		};
		for (const atom of textAtoms(para, lang)) {
			if (fits(line + atom)) {
				line += atom;
				continue;
			}
			if (line.trim() !== "") push();
			if (fits(atom)) {
				line = atom;
				continue;
			}
			// One word wider than the line: break it between graphemes.
			for (const { segment: g } of segmenter(lang, "grapheme").segment(atom)) {
				if (line !== "" && !fits(line + g)) push();
				line += g;
			}
		}
		push();
	}
	// Leading empty lines from whitespace-only paragraphs add nothing.
	while (lines.length > 1 && lines[0] === "") lines.shift();
	return lines;
}

/** Widest unbreakable piece of `text` at `px`. */
function longestAtom(text: string, px: number, measure: MeasureText, lang?: string): number {
	let w = 0;
	for (const para of text.split(/\r?\n/))
		for (const a of textAtoms(para, lang)) w = Math.max(w, measure(a.trimEnd(), px));
	return w;
}

/** Fit `text` into a box of `box` px (see the module comment). */
export function fitText(
	text: string,
	box: { readonly width: number; readonly height: number },
	measure: MeasureText,
	options: Partial<FitTextOptions> = {},
): FitTextResult {
	const o = { ...FIT_DEFAULTS, ...options };
	const boxW = Math.max(0, box.width);
	const boxH = Math.max(0, box.height);
	const widest = Math.max(boxW, o.maxWidth);
	const needed = Math.ceil(longestAtom(text, o.minPx, measure, o.lang) + 2 * o.padX);
	const width = Math.min(widest, Math.max(boxW, o.minWidth, needed));
	const inner = Math.max(1, width - 2 * o.padX);
	const layout = (px: number) => {
		const lines = wrapText(text, inner, px, measure, o.lang);
		const linePx = px * o.lineHeight;
		return { px, linePx, lines, height: Math.ceil(lines.length * linePx + 2 * o.padY) };
	};
	const step = o.step > 0 ? o.step : 0.5;
	let best: ReturnType<typeof layout> | null = null;
	for (let px = o.maxPx; px >= o.minPx - 1e-9; px -= step) {
		const l = layout(Math.round(px * 100) / 100);
		// A size at which a word would break mid-word only counts at the floor.
		if (l.height <= boxH && longestAtom(text, l.px, measure, o.lang) <= inner + 0.01) {
			best = l;
			break;
		}
	}
	const chosen = best ?? layout(o.minPx);
	return {
		px: chosen.px,
		linePx: chosen.linePx,
		lines: chosen.lines,
		width,
		height: Math.max(boxH, chosen.height),
		offsetX: Math.round((boxW - width) / 2),
		grew: best === null,
	};
}
