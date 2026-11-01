// Cloud Vision `AnnotateImageResponse` -> core `OcrBlock`s. Pure, so it is tested against
// recorded responses (test/fixtures/google/).
//
// Vision's `fullTextAnnotation` is a hierarchy: pages > blocks > paragraphs > words >
// symbols, each with a `boundingBox` polygon (vertices may omit a 0 coordinate), an optional
// `confidence` (DOCUMENT_TEXT_DETECTION fills it; TEXT_DETECTION often leaves it 0) and
// `property.detectedLanguages`. Line breaks are only marked on symbols
// (`property.detectedBreak.type`: SPACE, SURE_SPACE, EOL_SURE_SPACE, HYPHEN, LINE_BREAK).
//
// Mapping (GLIM-22 "Map fullTextAnnotation blocks to GLIM-21 blocks"):
// - one OcrBlock per Vision block (or per paragraph with `unit: "paragraph"`), with its
//   `lines` rebuilt from the word breaks, so core's grouper passes it through as grouped;
// - `languageHints` from the unit's `detectedLanguages` (else the page's), as a prior for
//   GLIM-21 detection, never the decision;
// - boxes are axis-aligned bounds of the polygons, clamped to the image.

import {
	isPlainObject,
	type LanguageCode,
	type LanguageHint,
	type OcrBlock,
	type OcrLine,
	type Rect,
} from "@glimpse/core";

export type VisionUnit = "block" | "paragraph";

export interface ParseOptions {
	readonly width: number;
	readonly height: number;
	readonly unit: VisionUnit;
	/** Google code -> Glimpse language (core's `fromGoogle`). */
	readonly fromGoogle: (code: string) => LanguageCode | null;
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (isPlainObject(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Bounds of a `BoundingPoly` (`vertices` in px; `normalizedVertices` scaled), clamped. */
export function polyBounds(poly: unknown, width: number, height: number): Rect | null {
	const p = obj(poly);
	if (!p) return null;
	let pts = list(p["vertices"]).map((v) => [num(obj(v)?.["x"]) ?? 0, num(obj(v)?.["y"]) ?? 0] as const);
	if (pts.length === 0) {
		pts = list(p["normalizedVertices"]).map(
			(v) => [(num(obj(v)?.["x"]) ?? 0) * width, (num(obj(v)?.["y"]) ?? 0) * height] as const,
		);
	}
	if (pts.length === 0) return null;
	const xs = pts.map((q) => q[0]);
	const ys = pts.map((q) => q[1]);
	const x = Math.max(0, Math.min(width, Math.floor(Math.min(...xs))));
	const y = Math.max(0, Math.min(height, Math.floor(Math.min(...ys))));
	const x2 = Math.max(x, Math.min(width, Math.ceil(Math.max(...xs))));
	const y2 = Math.max(y, Math.min(height, Math.ceil(Math.max(...ys))));
	return { x, y, width: x2 - x, height: y2 - y };
}

function union(a: Rect | null, b: Rect | null): Rect | null {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

/** `property.detectedLanguages` -> hints, best first; `und` and unknown codes dropped. */
export function languageHintsOf(property: unknown, fromGoogle: ParseOptions["fromGoogle"]): LanguageHint[] {
	const hints: LanguageHint[] = [];
	for (const d of list(obj(property)?.["detectedLanguages"])) {
		const code = obj(d)?.["languageCode"];
		if (typeof code !== "string" || code === "" || code === "und") continue;
		const lang = fromGoogle(code);
		if (!lang || hints.some((h) => h.lang === lang)) continue;
		const confidence = Math.max(0, Math.min(1, num(obj(d)?.["confidence"]) ?? 0));
		hints.push({ lang, confidence });
	}
	return hints.sort((a, b) => b.confidence - a.confidence);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface WordOut {
	readonly text: string;
	readonly box: Rect | null;
	readonly confidence: number | null;
	/** What follows the word: nothing, a space, or the end of the line (with a hyphen). */
	readonly after: "" | " " | "eol" | "hyphen";
}

function wordOf(word: Json, o: ParseOptions): WordOut {
	let text = "";
	let after: WordOut["after"] = "";
	const symbols = list(word["symbols"]);
	symbols.forEach((s, i) => {
		const sym = obj(s);
		if (!sym) return;
		text += typeof sym["text"] === "string" ? sym["text"] : "";
		const type = obj(obj(obj(sym["property"])?.["detectedBreak"]))?.["type"];
		if (type === undefined) return;
		const isLast = i === symbols.length - 1;
		if (type === "SPACE" || type === "SURE_SPACE") {
			if (isLast) after = " ";
			else text += " ";
		} else if (type === "EOL_SURE_SPACE" || type === "LINE_BREAK") after = "eol";
		else if (type === "HYPHEN") after = "hyphen";
	});
	const confidence = num(word["confidence"]);
	return { text, box: polyBounds(word["boundingBox"], o.width, o.height), confidence, after };
}

/** Lines of one paragraph, rebuilt from the word breaks. */
function linesOf(paragraph: Json, o: ParseOptions): { lines: OcrLine[]; confidences: number[] } {
	const lines: OcrLine[] = [];
	const confidences: number[] = [];
	let text = "";
	let box: Rect | null = null;
	let scores: number[] = [];
	const flush = () => {
		const trimmed = text.trim();
		if (trimmed !== "" && box) {
			const confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 1;
			lines.push({ box, text: trimmed, confidence: clamp01(confidence) });
		}
		text = "";
		box = null;
		scores = [];
	};
	for (const w of list(paragraph["words"])) {
		const word = obj(w);
		if (!word) continue;
		const out = wordOf(word, o);
		text += out.text;
		box = union(box, out.box);
		if (out.confidence !== null && out.confidence > 0) {
			scores.push(out.confidence);
			confidences.push(out.confidence);
		}
		if (out.after === " ") text += " ";
		else if (out.after === "hyphen") {
			text += "-";
			flush();
		} else if (out.after === "eol") flush();
	}
	flush();
	return { lines, confidences };
}

/** Parse one `AnnotateImageResponse` (already checked for `error`). */
export function parseVisionResponse(response: unknown, o: ParseOptions): OcrBlock[] {
	const full = obj(obj(response)?.["fullTextAnnotation"]);
	if (!full) return [];
	const blocks: OcrBlock[] = [];
	for (const p of list(full["pages"])) {
		const page = obj(p);
		if (!page) continue;
		const pageHints = languageHintsOf(page["property"], o.fromGoogle);
		for (const b of list(page["blocks"])) {
			const block = obj(b);
			if (!block) continue;
			const type = block["blockType"];
			if (type !== undefined && type !== "TEXT") continue; // TABLE, PICTURE, RULER, BARCODE
			const units: { readonly node: Json; readonly paragraphs: Json[] }[] =
				o.unit === "paragraph"
					? list(block["paragraphs"])
							.map(obj)
							.filter((x): x is Json => x !== null)
							.map((para) => ({ node: para, paragraphs: [para] }))
					: [
							{
								node: block,
								paragraphs: list(block["paragraphs"])
									.map(obj)
									.filter((x): x is Json => x !== null),
							},
						];
			for (const unit of units) {
				const lines: OcrLine[] = [];
				const confidences: number[] = [];
				for (const para of unit.paragraphs) {
					const r = linesOf(para, o);
					lines.push(...r.lines);
					confidences.push(...r.confidences);
				}
				if (lines.length === 0) continue;
				const box =
					polyBounds(unit.node["boundingBox"], o.width, o.height) ??
					lines.reduce<Rect | null>((acc, l) => union(acc, l.box), null);
				if (!box) continue;
				const own = num(unit.node["confidence"]);
				const confidence =
					own !== null && own > 0
						? own
						: confidences.length > 0
							? confidences.reduce((a, c) => a + c, 0) / confidences.length
							: 1;
				const unitHints = languageHintsOf(unit.node["property"], o.fromGoogle);
				const hints = unitHints.length > 0 ? unitHints : pageHints;
				blocks.push({
					id: `v${blocks.length}`,
					box,
					text: lines.map((l) => l.text).join("\n"),
					confidence: clamp01(confidence),
					lines,
					...(hints.length > 0 ? { languageHints: hints } : {}),
				});
			}
		}
	}
	return blocks;
}

/**
 * The `error` of a per-image response (`google.rpc.Status`: numeric `code`, `message`), or
 * null. Vision reports bad images this way with HTTP 200.
 */
export function responseError(response: unknown): { code: number; message: string } | null {
	const error = obj(obj(response)?.["error"]);
	if (!error) return null;
	return { code: num(error["code"]) ?? 2, message: typeof error["message"] === "string" ? error["message"] : "" };
}
