// The detector port (GLIM-21: "Detector libraries (ELD, fastText WASM) are injected"). Core
// owns the rules; an implementation in @glimpse/providers wraps the library and maps its labels
// to `LanguageCode`s at its edge.

import type { LanguageCode } from "../code.ts";
import { lookupLanguage } from "../lookup.ts";
import { uniqueScriptLanguage } from "./scripts.ts";

export interface DetectorCandidate {
	readonly lang: LanguageCode;
	/** The library's score, 0..1 (not a calibrated probability; GLIM-21 open question 1). */
	readonly score: number;
}

export interface DetectorResult {
	/** Best first. Empty when the library found nothing. */
	readonly candidates: readonly DetectorCandidate[];
	/** The library's own reliability flag (ELD `isReliable()`; fastText: p >= its threshold). */
	readonly reliable: boolean;
	/**
	 * The library recognised nothing in the text (fastText: its fixed bias-only answer, GLIM-145),
	 * so no language is ruled out. Rule 5c then treats every subset language writing the script
	 * as plausible. `candidates` is empty.
	 */
	readonly noEvidence?: boolean;
}

/**
 * Thresholds tuned to one library's score scale (GLIM-104). Scores aren't comparable across
 * libraries (ELD's are similarity scores packed near 0.8 for related languages; fastText's are
 * softmax probabilities), so a margin calibrated on one means nothing on the other.
 */
export interface DetectorTuning {
	/** Rule 4 score threshold; default GLIM-21's starting tau. */
	readonly tau?: number;
	/**
	 * Rule 4w (GLIM-140): the capture's script prior wins a short block's near-tie when the
	 * block scores it within this of its own top-1. Unset: rule 4w is off for this detector.
	 */
	readonly priorMargin?: number;
	/** Rule 4w: only blocks with fewer weighted letters than this. */
	readonly priorMaxLetters?: number;
}

export interface LanguageDetector {
	/** `eld-medium`, `fasttext-lid176`. Part of cache keys. */
	readonly id: string;
	/** Thresholds calibrated to this detector's scores; GLIM-21 defaults (and no rule 4w) otherwise. */
	readonly tuning?: DetectorTuning;
	/** Languages it can return. */
	readonly languages: readonly LanguageCode[];
	/** Detect over the full language set (never restricted to the subset, GLIM-21). */
	detect(text: string): DetectorResult;
}

/** Languages the script table settles without a detector (rule 3). */
const scriptDecided = (lang: LanguageCode) => {
	const script = lookupLanguage(lang)?.script;
	return script !== undefined && uniqueScriptLanguage(script) !== null;
};

export interface DetectorPlan<D> {
	readonly detector: D | null;
	/** Subset languages neither the chosen detector nor the script table can identify. */
	readonly undetectable: readonly LanguageCode[];
}

/**
 * GLIM-21 "detector choice is made when the subset changes": the first detector (in the order
 * given, ELD before fastText) that covers every subset language not settled by script; else the
 * one covering most. An empty subset ("translate everything") takes the first.
 */
export function planDetector<D extends Pick<LanguageDetector, "languages">>(
	subset: readonly LanguageCode[],
	detectors: readonly D[],
): DetectorPlan<D> {
	const covered = (d: D, lang: LanguageCode) => {
		const want = lookupLanguage(lang)?.code ?? lang;
		const primary = want.split("-")[0];
		return d.languages.some((l) => l === want || l.split("-")[0] === primary);
	};
	const needed = subset.filter((l) => !scriptDecided(l));
	let best: D | null = null;
	let bestMissing: LanguageCode[] = needed;
	for (const d of detectors) {
		const missing = needed.filter((l) => !covered(d, l));
		if (best === null || missing.length < bestMissing.length) {
			best = d;
			bestMissing = missing;
		}
		if (missing.length === 0) break;
	}
	return { detector: best, undetectable: best ? bestMissing : needed };
}
