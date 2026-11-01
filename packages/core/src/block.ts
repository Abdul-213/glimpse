import type { Rect } from "./geometry.ts";
import type { LanguageCode } from "./language.ts";

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

/** Where a translation was produced. `cloud` means the text left the device (egress UI). */
export type ProviderKind = "local" | "cloud";

export interface ProviderRef {
	/** Stable id such as `bergamot`, `deepl`. Part of cache keys. */
	readonly id: string;
	readonly kind: ProviderKind;
	/** Human name for "Sent to <Provider>". */
	readonly name: string;
}

export interface Translation {
	readonly text: string;
	readonly from: LanguageCode;
	readonly to: LanguageCode;
	readonly provider: ProviderRef;
}
