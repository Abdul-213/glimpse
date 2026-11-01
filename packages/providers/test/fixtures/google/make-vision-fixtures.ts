// Writes the Cloud Vision response fixtures in this folder. Not part of the build; the JSON
// is committed. Run: bun packages/providers/test/fixtures/google/make-vision-fixtures.ts
//
// No Google key was available when these were made (GLIM-60), so they are built to the
// documented `AnnotateImageResponse` shape (docs.cloud.google.com/vision/docs/reference/rest/
// v1/AnnotateImageResponse) for the text in test/fixtures/ocr/region-*.png, with boxes
// measured from those images, rather than recorded from a live call. The quirks a real
// reply has are reproduced on purpose: vertices omit a coordinate that is 0, breaks live only
// on the last symbol of a word, TEXT_DETECTION leaves confidences at 0 (absent), page- and
// block-level `detectedLanguages`. Replace them with real recordings once a key exists;
// test/google/real-api.test.ts runs against the live API when GLIMPSE_GOOGLE_KEY is set.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

type Break = "SPACE" | "EOL_SURE_SPACE" | "LINE_BREAK" | "HYPHEN" | null;

interface Vertex {
	x?: number;
	y?: number;
}

const vertex = (x: number, y: number): Vertex => ({ ...(x === 0 ? {} : { x }), ...(y === 0 ? {} : { y }) });
const poly = (x: number, y: number, w: number, h: number) => ({
	vertices: [vertex(x, y), vertex(x + w, y), vertex(x + w, y + h), vertex(x, y + h)],
});

interface LineSpec {
	readonly text: string;
	readonly x: number;
	readonly y: number;
	readonly h: number;
	/** Average advance per character, px. */
	readonly cw: number;
	/** Split into words on spaces (Latin) or keep each run as one word (CJK). */
	readonly words?: readonly string[];
}

function words(line: LineSpec, document: boolean, lang: string, last: Break) {
	const ws = line.words ?? line.text.split(" ");
	let x = line.x;
	return ws.map((w, wi) => {
		const chars = [...w];
		const width = Math.round(chars.length * line.cw);
		const isLast = wi === ws.length - 1;
		const brk: Break = isLast ? last : line.words ? null : "SPACE";
		const symbols = chars.map((ch, ci) => {
			const sx = x + Math.round(ci * line.cw);
			const sym: Record<string, unknown> = {
				property: {
					detectedLanguages: [{ languageCode: lang }],
					...(ci === chars.length - 1 && brk ? { detectedBreak: { type: brk } } : {}),
				},
				boundingBox: poly(sx, line.y, Math.round(line.cw), line.h),
				text: ch,
			};
			if (document) sym["confidence"] = 0.99;
			return sym;
		});
		const word: Record<string, unknown> = {
			property: { detectedLanguages: [{ languageCode: lang }] },
			boundingBox: poly(x, line.y, width, line.h),
			symbols,
		};
		if (document) word["confidence"] = 0.98;
		x += width + (line.words ? 0 : Math.round(line.cw));
		return word;
	});
}

function block(lines: readonly LineSpec[], document: boolean, lang: string, confidence = 0.97) {
	const x = Math.min(...lines.map((l) => l.x));
	const y = Math.min(...lines.map((l) => l.y));
	const x2 = Math.max(...lines.map((l) => l.x + [...l.text].length * l.cw));
	const y2 = Math.max(...lines.map((l) => l.y + l.h));
	const box = poly(x, y, Math.round(x2 - x), y2 - y);
	const allWords = lines.flatMap((l, i) =>
		words(l, document, lang, i === lines.length - 1 ? "LINE_BREAK" : "EOL_SURE_SPACE"),
	);
	const langs = [{ languageCode: lang, ...(document ? { confidence: 1 } : {}) }];
	const paragraph: Record<string, unknown> = {
		property: { detectedLanguages: langs },
		boundingBox: box,
		words: allWords,
	};
	const out: Record<string, unknown> = {
		property: { detectedLanguages: langs },
		boundingBox: box,
		paragraphs: [paragraph],
		blockType: "TEXT",
	};
	if (document) {
		paragraph["confidence"] = confidence;
		out["confidence"] = confidence;
	}
	return out;
}

function response(blocks: unknown[], text: string, lang: string, width: number, height: number, document: boolean) {
	const fullTextAnnotation = {
		pages: [
			{
				property: { detectedLanguages: [{ languageCode: lang, ...(document ? { confidence: 1 } : {}) }] },
				width,
				height,
				blocks,
			},
		],
		text,
	};
	// textAnnotations[0] is the whole text; one entry per word follows (abridged to the first here).
	const textAnnotations = [{ locale: lang, description: text, boundingPoly: poly(16, 8, 410, 176) }];
	return { responses: [{ textAnnotations, fullTextAnnotation }] };
}

const dir = import.meta.dir;
const write = (name: string, value: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);

// region-en.png (600x200): four lines in one block, the error line in another.
{
	const en: LineSpec[] = [
		{ text: "Settings saved successfully.", x: 16, y: 10, h: 22, cw: 10 },
		{ text: "Do you want to install the update now?", x: 16, y: 47, h: 22, cw: 10.6 },
		{ text: "Your session will expire in 5 minutes.", x: 16, y: 84, h: 22, cw: 9.9 },
		{ text: "Click Continue to keep working.", x: 16, y: 121, h: 22, cw: 10.3 },
	];
	const err: LineSpec[] = [{ text: "Error 404: file not found", x: 16, y: 158, h: 22, cw: 9.8 }];
	const text = `${[...en, ...err].map((l) => l.text).join("\n")}\n`;
	write(
		"vision-document-en.json",
		response([block(en, true, "en", 0.98), block(err, true, "en", 0.96)], text, "en", 600, 200, true),
	);
}

// region-ja.png (600x200) with TEXT_DETECTION: no confidences anywhere.
{
	const ja: LineSpec[] = [
		{ text: "設定を保存しました。", x: 16, y: 8, h: 24, cw: 18, words: ["設定", "を", "保存", "しま", "した", "。"] },
		{
			text: "このアイテムを使用しますか？",
			x: 16,
			y: 45,
			h: 24,
			cw: 21,
			words: ["この", "アイテム", "を", "使用", "します", "か", "？"],
		},
		{
			text: "明日の会議は午後三時に始まります。",
			x: 16,
			y: 82,
			h: 24,
			cw: 21,
			words: ["明日", "の", "会議", "は", "午後", "三", "時", "に", "始まり", "ます", "。"],
		},
		{
			text: "ダウンロードが完了しました",
			x: 16,
			y: 119,
			h: 24,
			cw: 21,
			words: ["ダウンロード", "が", "完了", "しました"],
		},
	];
	const buttons: LineSpec[] = [{ text: "キャンセル", x: 16, y: 156, h: 24, cw: 21, words: ["キャンセル"] }];
	const next: LineSpec[] = [{ text: "次へ", x: 170, y: 156, h: 24, cw: 21, words: ["次へ"] }];
	const text = `${[...ja, ...buttons, ...next].map((l) => l.text).join("\n")}\n`;
	write(
		"vision-text-ja.json",
		response(
			[block(ja, false, "ja"), block(buttons, false, "ja"), block(next, false, "ja")],
			text,
			"ja",
			600,
			200,
			false,
		),
	);
}

// A per-image failure: HTTP 200, `error` inside the response (google.rpc.Status).
write("vision-bad-image.json", { responses: [{ error: { code: 3, message: "Bad image data." } }] });

// Nothing readable in the image: an empty response object.
write("vision-empty.json", { responses: [{}] });
