// Count the letters of a string per Unicode script. Used by OCR to route a line to the right
// recogniser (GLIM-46) and by language detection's script pass (GLIM-21, rules 2 and 3).
// Pure; regex property escapes only.

import type { ScriptCode } from "./script.ts";

/**
 * Scripts we tell apart, most common first (the loop stops at the first match). Han, Hiragana
 * and Katakana are kept apart here; `writingSystem` folds them for callers that want `Jpan`.
 */
const SCRIPTS: readonly (readonly [ScriptCode, RegExp])[] = [
	["Latn", /\p{Script=Latin}/u],
	["Hani", /\p{Script=Han}/u],
	["Hira", /\p{Script=Hiragana}/u],
	["Kana", /\p{Script=Katakana}/u],
	["Hang", /\p{Script=Hangul}/u],
	["Cyrl", /\p{Script=Cyrillic}/u],
	["Arab", /\p{Script=Arabic}/u],
	["Deva", /\p{Script=Devanagari}/u],
	["Thai", /\p{Script=Thai}/u],
	["Grek", /\p{Script=Greek}/u],
	["Hebr", /\p{Script=Hebrew}/u],
	["Beng", /\p{Script=Bengali}/u],
	["Taml", /\p{Script=Tamil}/u],
	["Telu", /\p{Script=Telugu}/u],
	["Knda", /\p{Script=Kannada}/u],
	["Mlym", /\p{Script=Malayalam}/u],
	["Gujr", /\p{Script=Gujarati}/u],
	["Guru", /\p{Script=Gurmukhi}/u],
	["Orya", /\p{Script=Oriya}/u],
	["Sinh", /\p{Script=Sinhala}/u],
	["Geor", /\p{Script=Georgian}/u],
	["Armn", /\p{Script=Armenian}/u],
	["Ethi", /\p{Script=Ethiopic}/u],
	["Khmr", /\p{Script=Khmer}/u],
	["Laoo", /\p{Script=Lao}/u],
	["Mymr", /\p{Script=Myanmar}/u],
	["Tibt", /\p{Script=Tibetan}/u],
	["Thaa", /\p{Script=Thaana}/u],
	["Syrc", /\p{Script=Syriac}/u],
	["Olck", /\p{Script=Ol_Chiki}/u],
	["Tfng", /\p{Script=Tifinagh}/u],
	["Mong", /\p{Script=Mongolian}/u],
	["Cher", /\p{Script=Cherokee}/u],
	["Cans", /\p{Script=Canadian_Aboriginal}/u],
	["Nkoo", /\p{Script=Nko}/u],
	["Adlm", /\p{Script=Adlam}/u],
];

// Letters plus combining marks, so Indic and Thai vowel signs count with their script.
const LETTER = /[\p{L}\p{M}]/u;
const MARK = /\p{M}/u;

export interface ScriptCounts {
	/** Letters per script (marks count with the script of their base letter). */
	readonly counts: ReadonlyMap<ScriptCode, number>;
	/** All counted letters. */
	readonly total: number;
}

/** Letters per script. `Zyyy` collects letters in scripts not listed above. */
export function countScripts(text: string): ScriptCounts {
	const counts = new Map<ScriptCode, number>();
	let total = 0;
	let last: ScriptCode | null = null;
	for (const ch of text) {
		if (!LETTER.test(ch)) {
			last = null;
			continue;
		}
		let script: ScriptCode | null = null;
		if (MARK.test(ch)) script = last;
		if (!script) script = SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? (MARK.test(ch) ? null : "Zyyy");
		if (!script) continue; // a stray combining mark with no base
		counts.set(script, (counts.get(script) ?? 0) + 1);
		total++;
		last = script;
	}
	return { counts, total };
}

/**
 * Fold the script counts into writing systems: kana + Han with any kana is `Jpan`, Hangul +
 * Han with Hangul is `Kore`, Han alone is `Hani`. Other scripts pass through.
 */
export function writingSystems(c: ScriptCounts): Map<ScriptCode, number> {
	const out = new Map(c.counts);
	const kana = (out.get("Hira") ?? 0) + (out.get("Kana") ?? 0);
	const han = out.get("Hani") ?? 0;
	const hangul = out.get("Hang") ?? 0;
	if (kana > 0) {
		out.delete("Hira");
		out.delete("Kana");
		out.delete("Hani");
		out.set("Jpan", kana + han);
	} else if (hangul > 0 && han > 0) {
		out.delete("Hang");
		out.delete("Hani");
		out.set("Kore", hangul + han);
	}
	return out;
}

export interface DominantScript {
	readonly script: ScriptCode;
	/** Share of all letters in this writing system, 0..1. */
	readonly share: number;
	readonly letters: number;
}

/**
 * The writing system with the most letters (after `writingSystems` folding), or null when the
 * text has no letters. Ties go to the script listed first above.
 */
export function dominantScript(text: string): DominantScript | null {
	const c = countScripts(text);
	if (c.total === 0) return null;
	let best: ScriptCode | null = null;
	let bestN = 0;
	for (const [script, n] of writingSystems(c)) {
		if (n > bestN) {
			best = script;
			bestN = n;
		}
	}
	return best ? { script: best, share: bestN / c.total, letters: c.total } : null;
}
