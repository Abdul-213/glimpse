// GLIM-142: scoring for the detection calibration benchmark (run.ts). Pure: takes a detector
// and returns counts, so the tuning grid and the unit tests share it.
import {
	type DetectorResult,
	type DetectorTuning,
	detectCaptureLanguages,
	detectionCopy,
	inSubset,
	type LanguageCode,
	type LanguageDecision,
	type LanguageDetector,
	languageCode,
	sameLanguage,
	weightedLetters,
} from "@glimpse/core";
import type { DetectionCapture } from "./corpus.ts";

const TARGET = languageCode("en");

/** Letter buckets: rule 4's 8-letter floor and rule 4w's 24-letter limit split them. */
export type LengthBucket = "short" | "medium" | "long";
export const BUCKETS: readonly LengthBucket[] = ["short", "medium", "long"];
export const bucketOf = (text: string): LengthBucket => {
	const n = weightedLetters(detectionCopy(text));
	return n < 8 ? "short" : n < 24 ? "medium" : "long";
};

export interface Tally {
	correct: number;
	total: number;
}
const tally = (): Tally => ({ correct: 0, total: 0 });
const add = (t: Tally, ok: boolean) => {
	t.total++;
	if (ok) t.correct++;
};
/** Count into `map[key]`, creating it on first use. */
const addTo = (map: Record<string, Tally>, key: string, ok: boolean) => {
	const t = map[key] ?? tally();
	map[key] = t;
	add(t, ok);
};
export const pct = (t: Tally): number => (t.total === 0 ? 0 : t.correct / t.total);

/** fastText (or any detector) alone: top-1 of the block's detection copy against the truth. */
export interface AloneScore {
	readonly all: Tally;
	readonly byBucket: Record<LengthBucket, Tally>;
	readonly byKind: Record<string, Tally>;
	/** By the block's true language. */
	readonly byLang: Record<string, Tally>;
}

export function scoreAlone(corpus: readonly DetectionCapture[], detector: LanguageDetector): AloneScore {
	const all = tally();
	const byBucket = { short: tally(), medium: tally(), long: tally() };
	const byKind: Record<string, Tally> = {};
	const byLang: Record<string, Tally> = {};
	for (const c of corpus) {
		for (const block of c.blocks) {
			const top = detector.detect(detectionCopy(block.text, c.sources)).candidates[0]?.lang;
			const ok = top !== undefined && sameLanguage(top, languageCode(block.lang));
			add(all, ok);
			add(byBucket[bucketOf(block.text)], ok);
			addTo(byKind, c.kind, ok);
			addTo(byLang, block.lang, ok);
		}
	}
	return { all, byBucket, byKind, byLang };
}

/** What the user should see for a block: translated, shown as-is (already English), or skipped. */
export type Action = "translate" | "keep" | "skip";

export function expectedAction(truth: LanguageCode, subset: readonly LanguageCode[]): Action {
	if (!inSubset(truth, subset)) return "skip";
	return sameLanguage(truth, TARGET) ? "keep" : "translate";
}

const actionOf = (d: LanguageDecision): Action =>
	d.translate ? "translate" : d.language.kind === "language" ? "keep" : "skip";

/**
 * A block is right when its action is right and, if it is translated, the source language
 * is right too (a wrong source makes the translation model read the wrong language).
 */
export interface RulesScore {
	readonly all: Tally;
	readonly byBucket: Record<LengthBucket, Tally>;
	readonly byKind: Record<string, Tally>;
	/** By the block's true language. */
	readonly byLang: Record<string, Tally>;
	/** Should have been translated but was skipped or kept. */
	readonly missed: number;
	/** Translated, but from the wrong source language. */
	readonly wrongSource: number;
	/** Translated (or skipped) when it should have been kept, or translated when it should be skipped. */
	readonly otherWrong: number;
	/** Decisions by GLIM-21 rule. */
	readonly rules: Record<string, number>;
	/** Each wrong block, for the report. */
	readonly misses: readonly { capture: string; text: string; truth: string; got: string; rule: string }[];
}

export function scoreRules(corpus: readonly DetectionCapture[], detector: LanguageDetector): RulesScore {
	const all = tally();
	const byBucket = { short: tally(), medium: tally(), long: tally() };
	const byKind: Record<string, Tally> = {};
	const byLang: Record<string, Tally> = {};
	const rules: Record<string, number> = {};
	const misses: { capture: string; text: string; truth: string; got: string; rule: string }[] = [];
	let missed = 0;
	let wrongSource = 0;
	let otherWrong = 0;
	for (const c of corpus) {
		const subset = c.sources.map(languageCode);
		const inputs = c.blocks.map((b, i) => ({ id: `b${i}`, text: b.text, confidence: 0.95 }));
		const out = detectCaptureLanguages(inputs, { subset, target: TARGET, detector });
		c.blocks.forEach((block, i) => {
			const d = out.get(`b${i}`);
			if (!d) throw new Error(`no decision for ${c.id} b${i}`);
			const truth = languageCode(block.lang);
			const want = expectedAction(truth, subset);
			const got = actionOf(d);
			const lang = d.language.kind === "neutral" ? null : d.language.lang;
			const langOk = lang !== null && sameLanguage(lang, truth);
			const ok = got === want && (want !== "translate" || langOk);
			if (!ok) {
				if (want === "translate" && got !== "translate") missed++;
				else if (want === "translate") wrongSource++;
				else otherWrong++;
				misses.push({ capture: c.id, text: block.text, truth: block.lang, got: `${got} ${lang ?? "-"}`, rule: d.rule });
			}
			add(all, ok);
			add(byBucket[bucketOf(block.text)], ok);
			addTo(byKind, c.kind, ok);
			addTo(byLang, block.lang, ok);
			rules[d.rule] = (rules[d.rule] ?? 0) + 1;
		});
	}
	return { all, byBucket, byKind, byLang, missed, wrongSource, otherWrong, rules, misses };
}

/**
 * `detector` with other thresholds, for the tuning grid: its tuning replaced and `reliable`
 * recomputed as "top-1 >= tau" (fastText's reliability flag is its tau, GLIM-142). Detections
 * are memoised, so a grid costs one pass of the model.
 */
export function retuned(
	detector: LanguageDetector,
	tuning: DetectorTuning & { readonly tau: number },
	memo: Map<string, DetectorResult> = new Map(),
): LanguageDetector {
	return {
		id: detector.id,
		languages: detector.languages,
		tuning,
		detect(text) {
			let r = memo.get(text);
			if (!r) {
				r = detector.detect(text);
				memo.set(text, r);
			}
			return { candidates: r.candidates, reliable: (r.candidates[0]?.score ?? 0) >= tuning.tau };
		},
	};
}
