// Which PP-OCRv5 recognisers to run for a request, and when to re-read a line with another one.
// Pure. PP-OCRv5 has one recogniser per script family (core `recognizersFor`), so a capture
// with Japanese and German lines needs `ch` for one and `latin` for the other.
//
// Strategy (measured against the spike samples; see the GLIM-46 PR):
// 1. Candidates come from the request's languages (the user's source subset): the fewest
//    installed recognisers that read them all (`ch` also reads English, so {ja, en} needs only
//    `ch`). `ch` goes first when present: it reads CJK and basic Latin, the best first pass.
// 2. Every line is read by the first candidate.
// 3. If the text it produced is in a script another candidate specialises in (Latin text from
//    `ch` when `latin` is a candidate), the line is re-read by the specialist, and the
//    specialist wins unless its score is clearly worse.
// 4. Lines that still score low are re-read by the remaining candidates; the best score wins.

import {
	dominantScript,
	type LanguageCode,
	OCR_RECOGNIZERS,
	type OcrRecognizer,
	recognizerForScript,
	recognizersFor,
} from "@glimpse/core";

/** Recognisers used when the request names no languages, in first-pass order. */
export const DEFAULT_RECOGNIZERS: readonly OcrRecognizer[] = ["ch", "latin"];

/** A specialist's score may be this much lower than the first pass and still win (rule 3). */
export const SPECIALIST_MARGIN = 0.05;

/** Below this score a line is re-read by the other candidates (rule 4). */
export const FALLBACK_SCORE = 0.8;

/**
 * Candidates for a request, first-pass first. Only installed recognisers are returned; when
 * none of the languages can be read with what is installed, the result is empty.
 */
export function planRecognizers(
	languages: readonly LanguageCode[] | undefined,
	installed: ReadonlySet<OcrRecognizer>,
	defaults: readonly OcrRecognizer[] = DEFAULT_RECOGNIZERS,
): OcrRecognizer[] {
	if (!languages || languages.length === 0) {
		const picked = defaults.filter((r) => installed.has(r));
		if (picked.length > 0) return picked;
		return OCR_RECOGNIZERS.filter((r) => installed.has(r)).slice(0, 1);
	}
	let remaining = languages.map((l) => recognizersFor(l).filter((r) => installed.has(r))).filter((l) => l.length > 0);
	const chosen: OcrRecognizer[] = [];
	// Greedy set cover: the recogniser that reads the most remaining languages; ties go to
	// `ch` (the widest reader), then to the one a language prefers most, then to request order.
	while (remaining.length > 0) {
		let best: OcrRecognizer | null = null;
		let bestKey: readonly number[] = [];
		const seen = new Set<OcrRecognizer>();
		remaining.forEach((list, order) => {
			for (const r of list) {
				if (seen.has(r)) continue;
				seen.add(r);
				const cover = remaining.filter((l) => l.includes(r)).length;
				const rank = Math.min(...remaining.map((l) => (l.includes(r) ? l.indexOf(r) : 99)));
				const key = [cover, r === "ch" ? 1 : 0, -rank, -order];
				if (!best || compareKeys(key, bestKey) > 0) {
					best = r;
					bestKey = key;
				}
			}
		});
		if (!best) break;
		const pick: OcrRecognizer = best;
		chosen.push(pick);
		remaining = remaining.filter((l) => !l.includes(pick));
	}
	const ch = chosen.indexOf("ch");
	if (ch > 0) chosen.unshift(...chosen.splice(ch, 1));
	return chosen;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < a.length; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Recognisers that specialise in a script, best first. */
function specialistsForScript(script: string): readonly OcrRecognizer[] {
	if (script === "Latn") return ["latin", "en"];
	if (script === "Cyrl") return ["eslav", "cyrillic"];
	const r = recognizerForScript(script);
	return r ? [r] : [];
}

/**
 * Rule 3: a candidate other than `used` that specialises in the script of `text`, or null.
 * `ch` is never a specialist for Latin text, and nothing replaces `ch` for Han or kana.
 */
export function specialistFor(
	text: string,
	used: OcrRecognizer,
	candidates: readonly OcrRecognizer[],
): OcrRecognizer | null {
	const d = dominantScript(text);
	if (!d || d.share < 0.6) return null;
	for (const r of specialistsForScript(d.script)) {
		if (r === used) return null;
		if (candidates.includes(r)) return r;
	}
	return null;
}

export interface LineReading {
	readonly text: string;
	readonly score: number;
	readonly recognizer: OcrRecognizer;
}

/** Pick between a first-pass reading and a specialist's (rule 3). */
export function preferSpecialist(first: LineReading, specialist: LineReading): LineReading {
	if (specialist.text.trim() === "") return first;
	return specialist.score >= first.score - SPECIALIST_MARGIN ? specialist : first;
}

/** Pick the best of several readings (rule 4): highest score, earlier wins ties. */
export function bestReading(readings: readonly LineReading[]): LineReading | null {
	let best: LineReading | null = null;
	for (const r of readings) {
		if (r.text.trim() === "") continue;
		if (!best || r.score > best.score) best = r;
	}
	return best;
}
