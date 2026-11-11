// Which PaddleOCR (PP-OCRv5 mobile) recogniser reads which language. One recogniser per script
// family; the detector is shared (spikes/inference/FINDINGS.md). Which model files ship in the
// installer and which download on demand is the model manifest's business (GLIM-37).

import type { LanguageCode } from "./code.ts";
import { lookupLanguage, scriptOf } from "./lookup.ts";
import { isHanScript, type ScriptCode } from "./script.ts";

/** PP-OCRv5 recogniser families, named as in RapidOCR's model files (`<family>_PP-OCRv5_rec_mobile.onnx`). */
export type OcrRecognizer =
	| "ch" // Simplified + Traditional Chinese, Japanese, plus basic Latin
	| "en"
	| "latin"
	| "korean"
	| "eslav" // Russian, Ukrainian, Belarusian
	| "cyrillic"
	| "arabic" // emits visual order: reverse to logical for RTL text
	| "devanagari"
	| "th"
	| "el"
	| "ta"
	| "te";

export const OCR_RECOGNIZERS: readonly OcrRecognizer[] = [
	"ch",
	"en",
	"latin",
	"korean",
	"eslav",
	"cyrillic",
	"arabic",
	"devanagari",
	"th",
	"el",
	"ta",
	"te",
];

const EAST_SLAVIC: ReadonlySet<string> = new Set(["ru", "uk", "be"]);

/** The recogniser for a script, or null when PP-OCRv5 has none (Hebrew, Bengali, Georgian, ...). */
export function recognizerForScript(script: ScriptCode): OcrRecognizer | null {
	if (isHanScript(script)) return "ch";
	switch (script) {
		case "Latn":
			return "latin";
		case "Hang":
		case "Kore":
			return "korean";
		case "Cyrl":
			return "cyrillic";
		case "Arab":
			return "arabic";
		case "Deva":
			return "devanagari";
		case "Thai":
			return "th";
		case "Grek":
			return "el";
		case "Taml":
			return "ta";
		case "Telu":
			return "te";
		default:
			return null;
	}
}

/**
 * Recognisers that can read `code`, best first. Empty when local OCR can't read the script
 * (the UI then offers cloud OCR or says the script isn't supported locally).
 *
 * - English prefers the small `en` model, then `latin`, then `ch` (which also reads English).
 * - Russian, Ukrainian and Belarusian prefer `eslav`, other Cyrillic languages `cyrillic`.
 */
export function recognizersFor(code: LanguageCode): readonly OcrRecognizer[] {
	const primary = (lookupLanguage(code)?.code ?? code).split("-")[0] ?? code;
	if (primary === "en") return ["en", "latin", "ch"];
	const script = scriptOf(code);
	if (script === "Cyrl") return EAST_SLAVIC.has(primary) ? ["eslav", "cyrillic"] : ["cyrillic", "eslav"];
	const family = recognizerForScript(script);
	return family ? [family] : [];
}

/**
 * Languages the local recognisers read only partly (GLIM-126). PP-OCRv5's `latin` dictionary
 * has 1 of the ~50 precomposed Vietnamese letters with a dot below, a hook, horn or breve
 * (ạ ả ặ ơ ư ...), so it reads "Bạn có muốn cài đặt" as "Ban có muôn cài dt" (GLIM-64: CER
 * 20 %, WER 61 %). No PP-OCRv5 or PP-OCRv6 recogniser has them (docs/benchmarks/ocr.md). The
 * UI says so and points to cloud OCR.
 */
const PARTIAL_LOCAL_OCR: ReadonlySet<string> = new Set(["vi"]);

/** True when local OCR reads `code`'s script but loses part of its letters (Vietnamese tones). */
export function localOcrIsPartial(code: LanguageCode): boolean {
	const primary = (lookupLanguage(code)?.code ?? code).split("-")[0] ?? code;
	return PARTIAL_LOCAL_OCR.has(primary) && recognizersFor(code).length > 0;
}

/** The single best recogniser for `code`, or null. */
export function recognizerFor(code: LanguageCode): OcrRecognizer | null {
	return recognizersFor(code)[0] ?? null;
}
