import type { Rect } from "./geometry.ts";
import type { LanguageCode } from "./language.ts";
import type { Provenance } from "./providers/provenance.ts";

/** Stable within one capture result; Live mode matches blocks across frames by it. */
export type BlockId = string;

/** One text block as OCR returns it (a paragraph or a UI label, after line grouping). */
export interface OcrBlock {
	readonly id: BlockId;
	/** Bounding box in the region's device pixels (origin at the region's top-left). */
	readonly box: Rect;
	/** Recognised text, lines joined with "\n". */
	readonly text: string;
	/** Recognition confidence, 0..1. */
	readonly confidence: number;
	/**
	 * Languages the OCR engine itself reported for the block, best first (Google Vision's
	 * `detectedLanguages`). A prior for GLIM-21 detection, never the decision. Omitted when
	 * the engine reports none.
	 */
	readonly languageHints?: readonly LanguageHint[];
}

export interface LanguageHint {
	readonly lang: LanguageCode;
	/** 0..1. */
	readonly confidence: number;
}

/**
 * What language detection (GLIM-21) decided for a block.
 * - `language`: translate it (if it is in the user's source subset).
 * - `neutral`:  numbers, symbols, `OK`-style tokens. Shown as-is, never counted as skipped.
 * - `skipped`:  a real language outside the user's subset. Counted in "N blocks skipped".
 */
export type BlockLanguage =
	| { readonly kind: "language"; readonly lang: LanguageCode; readonly confidence: number }
	| { readonly kind: "neutral" }
	| { readonly kind: "skipped"; readonly lang: LanguageCode | null; readonly confidence: number };

/** A translated block or segment. `provider` says who produced it (indicator, cache key). */
export interface Translation {
	readonly text: string;
	readonly from: LanguageCode;
	readonly to: LanguageCode;
	/**
	 * Languages the text went through between `from` and `to`, in order. Empty for a direct
	 * model; `[en]` for a Bergamot English pivot (`ja -> en -> de`, GLIM-85).
	 */
	readonly via: readonly LanguageCode[];
	readonly provider: Provenance;
}
