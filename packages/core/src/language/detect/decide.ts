// GLIM-49: per-block language detection, implementing docs/decisions/GLIM-21-language-detection.md.
//
//   rule 1   neutral: < 2 weighted letters, or a known token (OK, F5, Lv., v1.2.3)
//   rule 2   dominant script (>= 70% of letters) written by no subset language -> skip (certain)
//   rule 3   script settles the language (Hangul, kana, Thai, Greek, Tamil, ...) -> that language
//   rule 4   ambiguous script, >= 8 letters, detector reliable and top score >= tau -> top-1
//            4w short block (< priorMaxLetters) whose top-1 only narrowly beats the capture's
//            script prior (GLIM-140) -> the prior
//   rule 5   uncertain (short, low confidence, low OCR confidence), in order:
//            5a Live: same text decided before -> reuse     5b inherit the capture's confident
//            majority if it writes this script               5c translate if a subset language
//            writing this script is in the detector's top 3, else skip
//   *        decided language == target -> keep it, don't translate
//
// The script prior (GLIM-140): the detector's top-1 over the capture's blocks of one ambiguous
// script joined together, when that is reliable and >= tau. Short same-script items (menus,
// buttons) are near-ties between related languages (Bulgarian "Нов прозорец": ru 0.842,
// bg 0.836, sr 0.831 in ELD), while the joined text carries the window's language. The prior
// breaks such near-ties (4w) and backs 5b when nothing in the capture was decided confidently.
//
// OCR language hints (Google Vision's per-block `detectedLanguages`, GLIM-22) are a prior,
// never the decision: they never trigger rules 2-4. They stand in for detector candidates
// when the detector has none for a block, and in 5c they are tried first.
//
// With no subset ("translate everything") detection only picks the source language: rules
// 1, 3, 4, 5a, 5b, then the detector's top-1.

import type { BlockId, BlockLanguage } from "../../block.ts";
import type { LanguageCode } from "../code.ts";
import { sameLanguage } from "../lookup.ts";
import { dominantScript } from "../script-count.ts";
import type { DetectorCandidate, LanguageDetector } from "./detector.ts";
import { detectionCopy, isNeutralToken, textKey, weightedLetters } from "./normalize.ts";
import { inSubset, languageUsesScript, uniqueScriptLanguage } from "./scripts.ts";

/** Which GLIM-21 rule decided. `hysteresis`: a Live block kept its previous language. */
export type DecisionRule = "1" | "2" | "3" | "4" | "4w" | "5a" | "5b" | "5c" | "hysteresis";

export interface LanguageDecision {
	readonly language: BlockLanguage;
	/** Send to translation: a language in the subset (or no subset) that isn't the target. */
	readonly translate: boolean;
	readonly rule: DecisionRule;
	/** Decided by rules 2-4: may override a Live block's previous language and seed 5b. */
	readonly confident: boolean;
}

export interface DetectOptions {
	/** The user's source subset; empty = translate everything. */
	readonly subset: readonly LanguageCode[];
	/** Translation target; blocks already in it are shown as-is. */
	readonly target: LanguageCode | null;
	/** From `planDetector`; null = script rules only. */
	readonly detector: LanguageDetector | null;
	/** Rule 4 score threshold (GLIM-21 starting value 0.5, to be calibrated). */
	readonly tau: number;
	/** Rule 4 minimum weighted letters. */
	readonly minLetters: number;
	/** Rule 2/3 script dominance. */
	readonly dominance: number;
	/** Blocks whose OCR confidence is below this skip rule 4 (straight to rule 5). */
	readonly minOcrConfidence: number;
	/** Rule 4w: blocks with fewer weighted letters than this may take the capture's script prior. */
	readonly priorMaxLetters: number;
	/**
	 * Rule 4w: the prior wins when the block scores it within this of its own top-1; null = rule
	 * 4w off. Score-scale specific, so it comes from the detector's `tuning` (GLIM-104): ELD's
	 * 0.01 (GLIM-140: Cyrillic near-ties are 0.004-0.007 apart; a clear Russian sentence leads
	 * by 0.026) means nothing on fastText's probabilities.
	 */
	readonly priorMargin: number | null;
}

export const DETECT_DEFAULTS: Omit<DetectOptions, "subset" | "target" | "detector"> = {
	tau: 0.5,
	minLetters: 8,
	dominance: 0.7,
	minOcrConfidence: 0.6,
	priorMaxLetters: 24,
	priorMargin: null,
};

/** Defaults, then the detector's own tuning, then explicit options (undefined ones ignored). */
function resolveOptions(
	options: Partial<DetectOptions> & Pick<DetectOptions, "subset" | "target" | "detector">,
): DetectOptions {
	const explicit = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
	return { ...DETECT_DEFAULTS, ...options.detector?.tuning, ...explicit } as DetectOptions;
}

export interface DetectInput {
	readonly id: BlockId;
	readonly text: string;
	/** OCR confidence, 0..1. */
	readonly confidence: number;
	/** Languages the OCR engine reported for the block, best first (`OcrBlock.languageHints`). */
	readonly hints?: readonly { readonly lang: LanguageCode; readonly confidence: number }[];
}

/** Rule 5a memory: decisions by detection-copy key (the Live session's text cache). */
export interface DecisionMemory {
	get(key: string): LanguageDecision | undefined;
}

type FirstPass =
	| { readonly done: LanguageDecision }
	| {
			readonly done: null;
			readonly key: string;
			readonly script: string | null;
			readonly candidates: readonly DetectorCandidate[];
			/** OCR hints consistent with the script, best first. */
			readonly hinted: readonly DetectorCandidate[];
	  };

/** Decide every block of one capture. Returns decisions by block id. */
export function detectCaptureLanguages(
	blocks: readonly DetectInput[],
	options: Partial<DetectOptions> & Pick<DetectOptions, "subset" | "target" | "detector">,
	memory?: DecisionMemory,
): Map<BlockId, LanguageDecision> {
	const o = resolveOptions(options);
	const priors = scriptPriors(blocks, o);
	const first = blocks.map((b) => firstPass(b, o, priors));

	// 5b input: the capture's confidently decided languages, by letters.
	const votes = new Map<LanguageCode, number>();
	first.forEach((f, i) => {
		if (!f.done?.confident || f.done.language.kind !== "language") return;
		const lang = f.done.language.lang;
		votes.set(lang, (votes.get(lang) ?? 0) + weightedLetters(detectionCopy(blocks[i]?.text ?? "", o.subset)));
	});
	const majority = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

	const out = new Map<BlockId, LanguageDecision>();
	first.forEach((f, i) => {
		const block = blocks[i];
		if (!block) return;
		out.set(block.id, f.done ?? uncertain(f, majority, priors, o, memory));
	});
	return out;
}

function decision(lang: LanguageCode, confidence: number, rule: DecisionRule, o: DetectOptions): LanguageDecision {
	const confident = rule === "2" || rule === "3" || rule === "4" || rule === "4w";
	if (o.subset.length > 0 && !inSubset(lang, o.subset)) {
		return { language: { kind: "skipped", lang, confidence }, translate: false, rule, confident };
	}
	const isTarget = o.target !== null && sameLanguage(lang, o.target);
	return { language: { kind: "language", lang, confidence }, translate: !isTarget, rule, confident };
}

const skip = (lang: LanguageCode | null, confidence: number, rule: DecisionRule): LanguageDecision => ({
	language: { kind: "skipped", lang, confidence },
	translate: false,
	rule,
	confident: rule === "2",
});

/** A script's prior for this capture (see the header): its language and the joined text's score. */
type ScriptPriors = ReadonlyMap<string, DetectorCandidate>;

const blockScript = (copy: string, o: DetectOptions): string | null => {
	const dom = dominantScript(copy);
	return dom && dom.share >= o.dominance ? dom.script : null;
};

/**
 * One detector call per ambiguous script that two or more blocks are written in, over their
 * detection copies joined. Low-OCR-confidence blocks and neutral ones don't contribute.
 */
function scriptPriors(blocks: readonly DetectInput[], o: DetectOptions): ScriptPriors {
	const priors = new Map<string, DetectorCandidate>();
	if (!o.detector || blocks.length < 2) return priors;
	const byScript = new Map<string, string[]>();
	for (const b of blocks) {
		if (b.confidence < o.minOcrConfidence || isNeutralToken(b.text)) continue;
		const copy = detectionCopy(b.text, o.subset);
		if (weightedLetters(copy) < 2) continue;
		const script = blockScript(copy, o);
		if (!script || uniqueScriptLanguage(script)) continue;
		byScript.set(script, [...(byScript.get(script) ?? []), copy]);
	}
	for (const [script, copies] of byScript) {
		if (copies.length < 2) continue;
		const r = o.detector.detect(copies.join(" "));
		const top = r.candidates.find((c) => languageUsesScript(c.lang, script));
		if (r.reliable && top && top.score >= o.tau) priors.set(script, top);
	}
	return priors;
}

const NEUTRAL: LanguageDecision = { language: { kind: "neutral" }, translate: false, rule: "1", confident: true };

function firstPass(block: DetectInput, o: DetectOptions, priors: ScriptPriors): FirstPass {
	const copy = detectionCopy(block.text, o.subset);
	const letters = weightedLetters(copy);
	// Rule 1.
	if (letters < 2 || isNeutralToken(block.text)) return { done: NEUTRAL };

	const script = blockScript(copy, o);
	const unique = script ? uniqueScriptLanguage(script) : null;
	const consistent = (c: DetectorCandidate) => !script || languageUsesScript(c.lang, script);
	const raw = unique ? null : (o.detector?.detect(copy) ?? null);
	const detected = raw ? raw.candidates.filter(consistent) : [];
	const hinted: DetectorCandidate[] = (block.hints ?? [])
		.map((h) => ({ lang: h.lang, score: Math.max(0, Math.min(1, h.confidence)) }))
		.filter(consistent);
	// Hints only fill in for a detector that has nothing to say (rule 4 still needs `raw`).
	const candidates = detected.length > 0 ? detected : hinted;

	// Rule 2: nobody in the subset writes this script.
	if (script && o.subset.length > 0 && !o.subset.some((l) => languageUsesScript(l, script))) {
		return { done: skip(unique ?? candidates[0]?.lang ?? null, 1, "2") };
	}
	// Rule 3: the script settles it.
	if (unique) return { done: decision(unique, 1, "3", o) };
	// Rule 4: long enough, detector confident, OCR trustworthy.
	const top = candidates[0];
	if (top && raw?.reliable && top.score >= o.tau && letters >= o.minLetters && block.confidence >= o.minOcrConfidence) {
		// 4w: a short block's near-tie goes to the capture's script prior.
		const prior = script ? priors.get(script) : undefined;
		const own = prior && prior.lang !== top.lang ? candidates.find((c) => c.lang === prior.lang) : undefined;
		if (own && o.priorMargin !== null && letters < o.priorMaxLetters && top.score - own.score <= o.priorMargin) {
			return { done: decision(own.lang, own.score, "4w", o) };
		}
		return { done: decision(top.lang, top.score, "4", o) };
	}
	return { done: null, key: textKey(copy), script, candidates, hinted };
}

function uncertain(
	f: Extract<FirstPass, { done: null }>,
	majority: LanguageCode | null,
	priors: ScriptPriors,
	o: DetectOptions,
	memory: DecisionMemory | undefined,
): LanguageDecision {
	// 5a: Live, decided before.
	const remembered = memory?.get(f.key);
	if (remembered) return { ...remembered, rule: "5a", confident: false };
	// 5b: the capture's confident majority if it writes this script, else the script prior.
	const inherited =
		majority && (!f.script || languageUsesScript(majority, f.script))
			? majority
			: f.script
				? (priors.get(f.script)?.lang ?? null)
				: null;
	if (inherited) {
		const conf = f.candidates.find((c) => c.lang === inherited)?.score ?? 0.5;
		return decision(inherited, Math.min(conf, 0.5), "5b", o);
	}
	const top3 = f.candidates.slice(0, 3);
	if (o.subset.length === 0) {
		const top = top3[0];
		return top ? decision(top.lang, top.score, "5c", o) : skip(null, 0, "5c");
	}
	// 5c: lean towards translating when a subset language writing this script is plausible.
	// Subset languages the detector can't return can't be ruled out, so they count as plausible.
	const known = new Set(o.detector?.languages ?? []);
	const writers = o.subset.filter((l) => !f.script || languageUsesScript(l, f.script));
	// The OCR engine's own guess first (a prior), then the detector's top 3.
	for (const c of [...f.hinted.slice(0, 1), ...top3]) {
		if (writers.some((w) => inSubset(c.lang, [w]))) return decision(c.lang, c.score, "5c", o);
	}
	const undetectable = writers.find((w) => ![...known].some((k) => inSubset(k, [w])));
	if (undetectable) return decision(undetectable, 0, "5c", o);
	return skip(top3[0]?.lang ?? null, top3[0]?.score ?? 0, "5c");
}
