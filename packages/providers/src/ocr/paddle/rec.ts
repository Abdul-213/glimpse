// PP-OCR text recognition (SVTR, CTC) pre- and post-processing. Pure.
// Ported from spikes/inference/src/ocr/rec.ts.

import { type Quad, type Raster, resizeNormalizeBGR, rotate90ccw, warpQuad } from "./image.ts";

export const REC_HEIGHT = 48;
/** `(x / 255 - 0.5) / 0.5`. */
export const REC_MEAN = [0.5, 0.5, 0.5] as const;
export const REC_STD = [0.5, 0.5, 0.5] as const;

/**
 * Class list as PaddleOCR builds it: index 0 is the CTC blank, then the dictionary, then " "
 * (`use_space_char`). PP-OCRv5 rec outputs have dictionary size + 2 classes.
 */
export function buildCharset(dictText: string): string[] {
	const lines = dictText.split(/\r?\n/);
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	return ["", ...lines, " "];
}

export interface CtcResult {
	readonly text: string;
	/** Mean max-probability over emitted characters, 0..1. */
	readonly score: number;
}

/**
 * Greedy CTC decode of one sequence: argmax per step, collapse repeats, drop blanks.
 * `probs` is [T, C] row-major starting at `offset` (the PP-OCRv5 export already applies softmax).
 */
export function ctcDecode(
	probs: Float32Array,
	T: number,
	C: number,
	charset: readonly string[],
	offset = 0,
): CtcResult {
	let prev = -1;
	let text = "";
	let sum = 0;
	let n = 0;
	for (let t = 0; t < T; t++) {
		const base = offset + t * C;
		let best = 0;
		let bestV = probs[base] as number;
		for (let c = 1; c < C; c++) {
			const v = probs[base + c] as number;
			if (v > bestV) {
				bestV = v;
				best = c;
			}
		}
		if (best !== 0 && best !== prev) {
			text += charset[best] ?? "";
			sum += bestV;
			n++;
		}
		prev = best;
	}
	return { text, score: n ? sum / n : 0 };
}

// Characters that keep left-to-right order inside right-to-left text: Latin letters, European
// and Arabic-Indic digits, and the punctuation that binds to numbers (12.5%, 10:30, 1/2, +3).
const LTR = /[0-9A-Za-zÀ-ɏ٠-٩۰-۹.,:%/+\-#@_]/u;

/**
 * The Arabic recogniser reads left to right, so it emits right-to-left text in visual order.
 * Reverse to logical order, keeping runs of LTR characters (digits, Latin words, separated by
 * single spaces) in their original direction. Same idea as PaddleOCR's `pred_reverse`.
 */
export function visualToLogicalRtl(s: string): string {
	const chars = [...s];
	const parts: string[] = [];
	let run = "";
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] as string;
		const joinsRun = ch === " " && run !== "" && LTR.test(chars[i + 1] ?? "");
		if (LTR.test(ch) || joinsRun) {
			run += ch;
			continue;
		}
		if (run) parts.push(run);
		run = "";
		parts.push(ch);
	}
	if (run) parts.push(run);
	return parts.reverse().join("");
}

/** Tensor width for a crop scaled to height 48, capped at `maxW`. */
export function recWidth(w: number, h: number, maxW: number): number {
	return Math.max(8, Math.min(maxW, Math.ceil((REC_HEIGHT * w) / Math.max(1, h))));
}

/** Width and height of a quad's upright crop. */
export function quadSize(q: Quad): { w: number; h: number } {
	return {
		w: Math.max(1, Math.round(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]))),
		h: Math.max(1, Math.round(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]))),
	};
}

/** Tall crops (vertical text) are rotated before recognition, as PaddleOCR does. */
export const isTallQuad = (q: Quad): boolean => {
	const { w, h } = quadSize(q);
	return h / w >= 1.5;
};

/** Upright crop of a detected quad; tall crops (h/w >= 1.5) are rotated 90 degrees counter-clockwise. */
export function cropQuad(img: Raster, q: Quad): Raster {
	const { w, h } = quadSize(q);
	const c = warpQuad(img, q, w, h);
	return h / w >= 1.5 ? rotate90ccw(c) : c;
}

/** Round a tensor width up to a multiple of `bucket` so ORT sees few distinct shapes. */
export function bucketWidth(w: number, bucket: number): number {
	return bucket > 1 ? Math.ceil(w / bucket) * bucket : w;
}

/** Batch crops into one [N, 3, 48, W] tensor, right-padded with zeros to the widest. */
export function recBatch(
	crops: readonly Raster[],
	maxW: number,
	bucket = 1,
): { readonly data: Float32Array; readonly width: number } {
	const widths = crops.map((c) => recWidth(c.width, c.height, maxW));
	const W = bucketWidth(Math.max(8, ...widths), bucket);
	const per = 3 * REC_HEIGHT * W;
	const data = new Float32Array(crops.length * per);
	crops.forEach((c, i) => {
		resizeNormalizeBGR(c, widths[i] as number, REC_HEIGHT, REC_MEAN, REC_STD, W, data, i * per);
	});
	return { data, width: W };
}
