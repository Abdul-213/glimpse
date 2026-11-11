// Which PP-OCRv5 recognisers to run for a request, and when to re-read a line with another one.
// Pure. PP-OCRv5 has one recogniser per script family (core `recognizersFor`), so a capture
// with Japanese and German lines needs `ch` for one and `latin` for the other.
//
// Strategy (measured against the spike samples; see the GLIM-46 PR):
// 1. Candidates come from the request's languages (the user's source subset): the fewest
//    installed recognisers that read them all (`ch` also reads English, so {ja, en} needs only
//    `ch`). `ch` goes first when present: it reads CJK and basic Latin, the best first pass.
//    Without `ch`, non-Latin recognisers go before `latin` / `en` (GLIM-125): every PP-OCRv5
//    recogniser's dictionary has basic Latin and reads English well, but the Latin ones (and
//    `ch`) read Cyrillic and Greek as Latin look-alikes ("Сохранить" -> "CoxpaHnTb") with
//    scores of 0.8-0.95, which rule 4 never questions. English only breaks the tie towards
//    `ch` when a CJK language needs `ch` anyway.
// 2. Every line is read by the first candidate.
// 3a. Look-alikes (GLIM-125): Latin text with the marks of misread Cyrillic or Greek (mixed
//    scripts or digits inside a word, a capital after a lowercase letter, an all-capitals word
//    made of look-alike capitals) is re-read by a Cyrillic or Greek candidate, which wins
//    when it reads its own script with a score that isn't clearly worse.
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
	// `ch` is needed when some language reads best (CJK: only) with it.
	const needsCh = remaining.some((l) => l[0] === "ch");
	const chosen: OcrRecognizer[] = [];
	// Greedy set cover: the recogniser that reads the most remaining languages; ties go to
	// `ch` (the widest reader) when it is needed anyway, then to the one a language prefers
	// most, then to request order.
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
				const key = [cover, needsCh && r === "ch" ? 1 : 0, -rank, -order];
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
	// First pass: `ch`, then non-Latin recognisers, then the Latin ones (stable otherwise).
	const tier = (r: OcrRecognizer) => (r === "ch" ? 0 : LATIN_RECOGNIZERS.has(r) ? 2 : 1);
	return chosen
		.map((r, i) => ({ r, i }))
		.sort((a, b) => tier(a.r) - tier(b.r) || a.i - b.i)
		.map((x) => x.r);
}

const LATIN_RECOGNIZERS: ReadonlySet<OcrRecognizer> = new Set(["latin", "en"]);

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

// ---- look-alikes (rule 3a) ---------------------------------------------------------------

/** Recognisers that read a script whose letters look like Latin ones, by script. */
const LOOKALIKE_READERS: readonly (readonly [string, readonly OcrRecognizer[]])[] = [
	["Cyrl", ["eslav", "cyrillic"]],
	["Grek", ["el"]],
];

const NON_LATIN_LETTER = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
/** Latin capitals with a Cyrillic or Greek twin (А В Е К М Н О Р С Т Х У, Α Β Ε Η Ι Κ Μ Ν Ο Ρ Τ Χ Υ Ζ). */
const LOOKALIKE_CAPITALS = /^[ABCEHIKMNOPTXYZ]{2,}$/;

/**
 * True when Latin text has the marks of Cyrillic or Greek read by a Latin-only reader: a word
 * that mixes Latin with Cyrillic/Greek letters, mixes digits and letters ("3akpbiTb", "6e3"),
 * has a capital after a lowercase letter ("CoxpaHnTb") or a lowercase letter after capitals
 * ("PMMEHNTb"), or is all look-alike capitals ("OTMEHA"). English has some of these too
 * ("iPhone", "B2B", "URLs", "TAKE"); that costs one extra read, not accuracy, because the
 * re-read only wins if it comes back in its own script.
 */
export function looksLikeLookalikes(text: string): boolean {
	for (const raw of text.split(/\s+/)) {
		const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
		if (word.length < 2) continue;
		if (NON_LATIN_LETTER.test(word) && LATIN_LETTER.test(word)) return true;
		if (/\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(word)) return true;
		if (/\p{L}/u.test(word) && /\p{N}/u.test(word) && !/^\p{N}+(st|nd|rd|th|s)$/iu.test(word)) return true;
		if (LOOKALIKE_CAPITALS.test(word)) return true;
	}
	return false;
}

/**
 * Rule 3a: the Cyrillic or Greek candidate (other than `used`) to re-read Latin look-alike text
 * with, or null. Greek letters in the text pick a Greek reader first.
 */
export function lookalikeReaderFor(
	text: string,
	used: OcrRecognizer,
	candidates: readonly OcrRecognizer[],
): OcrRecognizer | null {
	const d = dominantScript(text);
	// Latin text, or Greek/Cyrillic so mixed with Latin that rule 3 doesn't take it.
	if (!d || (d.script !== "Latn" && d.share >= 0.6) || !looksLikeLookalikes(text)) return null;
	const order = /\p{Script=Greek}/u.test(text) ? [...LOOKALIKE_READERS].reverse() : LOOKALIKE_READERS;
	for (const [, readers] of order) {
		const r = readers.find((x) => x !== used && candidates.includes(x));
		if (r) return r;
	}
	return null;
}

/** The script a look-alike reader specialises in. */
function lookalikeScript(r: OcrRecognizer): string | null {
	return LOOKALIKE_READERS.find(([, readers]) => readers.includes(r))?.[0] ?? null;
}

/**
 * Pick between a Latin first pass and a look-alike reader's re-read (rule 3a): the re-read wins
 * when most of its letters are in its own script and its score isn't clearly worse.
 */
export function preferLookalike(first: LineReading, again: LineReading): LineReading {
	const script = lookalikeScript(again.recognizer);
	const d = dominantScript(again.text);
	if (!script || !d || d.script !== script || d.share < 0.6) return first;
	return again.score >= first.score - SPECIALIST_MARGIN ? again : first;
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
