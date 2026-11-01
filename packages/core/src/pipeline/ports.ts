// Narrow ports the pipeline needs from stages that are built elsewhere:
//
// - `BlockGrouper` (GLIM-56): OCR lines -> paragraph-level blocks.
// - `BlockLanguageDetector` (GLIM-49, GLIM-21 rules): one decision per block.
//
// The pipeline ships simple defaults (`identityGrouper`, `scriptLanguageDetector`) so it runs
// end to end before those land; the real implementations plug in through these interfaces
// (an adapter is fine if their own API differs).

import type { BlockLanguage, OcrBlock } from "../block.ts";
import type { LanguageCode } from "../language/code.ts";

export interface BlockGrouper {
	/** For logs and diagnostics. */
	readonly id: string;
	/**
	 * Merge OCR lines into blocks, in reading order. Output boxes are in the same image space
	 * as the input; output ids must be unique (they become the popup's block ids). Pure and
	 * fast (runs on the orchestrating worker).
	 */
	group(lines: readonly OcrBlock[], image: { readonly width: number; readonly height: number }): readonly OcrBlock[];
}

/** Treat every OCR block as a block of its own. */
export const identityGrouper: BlockGrouper = {
	id: "identity",
	group: (lines) => lines,
};

export interface DetectionContext {
	/** The user's source-language subset. Empty: translate every language. */
	readonly sources: readonly LanguageCode[];
	readonly target: LanguageCode;
	readonly mode: "snip" | "live";
	/**
	 * Live only: decisions from earlier frames of this session, keyed by the normalised block
	 * text (GLIM-21 rule 5a and hysteresis). The detector may read and write it. Dropped when
	 * the session ends or the source subset changes.
	 */
	readonly memo?: Map<string, BlockLanguage>;
}

export interface BlockLanguageDetector {
	readonly id: string;
	/**
	 * One decision per block, same order and length as `blocks`. Batch API because GLIM-21
	 * rule 5b looks at the other blocks of the capture. `skipped` means "a real language
	 * outside the subset"; the pipeline also re-checks the subset itself.
	 */
	detect(
		blocks: readonly OcrBlock[],
		context: DetectionContext,
	): readonly BlockLanguage[] | Promise<readonly BlockLanguage[]>;
}

/** A detector from a per-text function (tests, harness). `null` means "can't tell": skipped. */
export function functionDetector(
	detect: (text: string) => LanguageCode | null,
	id = "function",
): BlockLanguageDetector {
	return {
		id,
		detect: (blocks) =>
			blocks.map((b): BlockLanguage => {
				const lang = detect(b.text);
				return lang ? { kind: "language", lang, confidence: 1 } : { kind: "skipped", lang: null, confidence: 0 };
			}),
	};
}

/** Wall clock for timings and cache timestamps. */
export interface Clock {
	/** Epoch ms. */
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
