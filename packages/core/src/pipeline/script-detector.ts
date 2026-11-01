// A small stand-in for the GLIM-49 language detector: GLIM-21 rules 1-3 (neutral blocks,
// script outside the subset, single-language scripts) and a simple fallback for ambiguous
// scripts (the OCR engine's language hint, else the subset's language for that script, else
// the script's most common language). No statistical model; the real detector (ELD /
// fastText, rules 4-5) replaces it through the `LanguageDetector` port.

import type { BlockLanguage, OcrBlock } from "../block.ts";
import { type LanguageCode, languageCode } from "../language/code.ts";
import { sameLanguage, scriptOf } from "../language/lookup.ts";
import { isHanScript, type ScriptCode } from "../language/script.ts";
import type { DetectionContext, LanguageDetector } from "./ports.ts";

/** Scripts we can name from code points, with Unicode property regexes. */
const SCRIPTS: readonly (readonly [ScriptCode, RegExp])[] = [
	["Latn", /\p{Script=Latin}/u],
	["Cyrl", /\p{Script=Cyrillic}/u],
	["Arab", /\p{Script=Arabic}/u],
	["Hebr", /\p{Script=Hebrew}/u],
	["Grek", /\p{Script=Greek}/u],
	["Hang", /\p{Script=Hangul}/u],
	["Kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
	["Hani", /\p{Script=Han}/u],
	["Thai", /\p{Script=Thai}/u],
	["Laoo", /\p{Script=Lao}/u],
	["Khmr", /\p{Script=Khmer}/u],
	["Deva", /\p{Script=Devanagari}/u],
	["Beng", /\p{Script=Bengali}/u],
	["Geor", /\p{Script=Georgian}/u],
	["Armn", /\p{Script=Armenian}/u],
	["Ethi", /\p{Script=Ethiopic}/u],
	["Sinh", /\p{Script=Sinhala}/u],
	["Taml", /\p{Script=Tamil}/u],
	["Telu", /\p{Script=Telugu}/u],
	["Knda", /\p{Script=Kannada}/u],
	["Mlym", /\p{Script=Malayalam}/u],
	["Gujr", /\p{Script=Gujarati}/u],
	["Guru", /\p{Script=Gurmukhi}/u],
	["Orya", /\p{Script=Oriya}/u],
];

/** GLIM-21 rule 3: scripts used by exactly one language (Kana means Japanese, with or without Han). */
const SINGLE: Readonly<Record<string, string>> = {
	Hang: "ko",
	Kana: "ja",
	Thai: "th",
	Laoo: "lo",
	Khmr: "km",
	Grek: "el",
	Geor: "ka",
	Armn: "hy",
	Sinh: "si",
	Taml: "ta",
	Telu: "te",
	Knda: "kn",
	Mlym: "ml",
	Gujr: "gu",
	Guru: "pa",
	Orya: "or",
};

/** Ambiguous scripts: the language to assume when nothing else says (low confidence). */
const FALLBACK: Readonly<Record<string, string>> = {
	Latn: "en",
	Cyrl: "ru",
	Arab: "ar",
	Hebr: "he",
	Hani: "zh-Hans",
	Deva: "hi",
	Beng: "bn",
	Ethi: "am",
};

/** Whole-block tokens that are never translated (GLIM-21 rule 1). */
const TOKENS =
	/^(?:ok|esc|tab|enter|shift|ctrl|alt|cmd|del|hp|mp|sp|xp|lv\.?|lvl|f\d{1,2}|v?\d+(?:\.\d+)+[a-z]?|[a-z]\d+|am|pm|ui|id)$/i;

const LETTER = /\p{L}/u;
const CJK_HEAVY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

interface ScriptCount {
	readonly script: ScriptCode | null;
	/** GLIM-21 letter count: Han and kana count three each. */
	readonly letters: number;
	/** Share of letters in `script`. */
	readonly share: number;
}

function dominantScript(text: string): ScriptCount {
	const counts = new Map<ScriptCode, number>();
	let letters = 0;
	let total = 0;
	for (const ch of text) {
		if (!LETTER.test(ch)) continue;
		total++;
		letters += CJK_HEAVY.test(ch) ? 3 : 1;
		const script = SCRIPTS.find(([, re]) => re.test(ch))?.[0];
		if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
	}
	// Any kana makes the block Japanese, even when Han characters outnumber it.
	const kana = counts.get("Kana") ?? 0;
	if (kana > 0) counts.set("Kana", kana + (counts.get("Hani") ?? 0));
	if (kana > 0) counts.delete("Hani");
	let best: ScriptCode | null = null;
	let bestN = 0;
	for (const [script, n] of counts) {
		if (n > bestN) {
			best = script;
			bestN = n;
		}
	}
	return { script: best, letters, share: total === 0 ? 0 : bestN / total };
}

/** Does `lang` write in the detected script? */
function usesScript(lang: LanguageCode, script: ScriptCode): boolean {
	const own = scriptOf(lang);
	if (script === "Hani") return isHanScript(own);
	if (script === "Kana") return own === "Jpan";
	return own === script;
}

export interface ScriptDetectorOptions {
	/** Per ambiguous script, the language to assume. Default `FALLBACK` above. */
	readonly fallbacks?: Readonly<Record<string, string>>;
}

export function scriptLanguageDetector(options: ScriptDetectorOptions = {}): LanguageDetector {
	const fallbacks = { ...FALLBACK, ...options.fallbacks };
	const decide = (block: OcrBlock, ctx: DetectionContext): BlockLanguage => {
		const stripped = block.text.normalize("NFKC").trim();
		if (TOKENS.test(stripped)) return { kind: "neutral" };
		const { script, letters, share } = dominantScript(stripped);
		if (letters < 2 || script === null) return { kind: "neutral" };
		const subset = ctx.sources;
		const inSubset = (lang: LanguageCode) => subset.length === 0 || subset.some((s) => sameLanguage(s, lang));
		// Rule 2: a script no subset language uses.
		if (subset.length > 0 && share >= 0.7 && !subset.some((s) => usesScript(s, script))) {
			const single = SINGLE[script] ?? fallbacks[script];
			return { kind: "skipped", lang: single ? languageCode(single) : null, confidence: 0.9 };
		}
		// Rule 3: single-language scripts.
		const single = SINGLE[script];
		if (single) {
			const lang = languageCode(single);
			return inSubset(lang)
				? { kind: "language", lang, confidence: 0.95 }
				: { kind: "skipped", lang, confidence: 0.95 };
		}
		// Ambiguous: OCR hint for this script, then the subset's language, then the script default.
		const hint = block.languageHints?.find((h) => usesScript(h.lang, script));
		if (hint) {
			return inSubset(hint.lang)
				? { kind: "language", lang: hint.lang, confidence: hint.confidence }
				: { kind: "skipped", lang: hint.lang, confidence: hint.confidence };
		}
		const fromSubset = subset.find((s) => usesScript(s, script));
		if (fromSubset) return { kind: "language", lang: fromSubset, confidence: 0.5 };
		const fallback = fallbacks[script];
		if (!fallback) return { kind: "skipped", lang: null, confidence: 0 };
		const lang = languageCode(fallback);
		return inSubset(lang) ? { kind: "language", lang, confidence: 0.3 } : { kind: "skipped", lang, confidence: 0.3 };
	};
	return {
		id: "script-table",
		detect: (blocks, ctx) => blocks.map((b) => decide(b, ctx)),
	};
}
