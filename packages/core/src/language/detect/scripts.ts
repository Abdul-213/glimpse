// The script pass of GLIM-21 (rules 2 and 3): which languages write a script, which scripts
// settle the language on their own, and Simplified vs Traditional Chinese.

import { type LanguageCode, languageCode, primaryLanguage } from "../code.ts";
import { allLanguages, lookupLanguage, scriptOf } from "../lookup.ts";
import type { ScriptCode } from "../script.ts";

/**
 * Scripts that map to exactly one language Glimpse can translate (GLIM-21 rule 3). `Jpan` is
 * text with kana (folded by `writingSystems`), `Kore` Hangul with Han.
 */
const UNIQUE: ReadonlyMap<ScriptCode, string> = new Map([
	["Hang", "ko"],
	["Kore", "ko"],
	["Jpan", "ja"],
	["Thai", "th"],
	["Laoo", "lo"],
	["Khmr", "km"],
	["Grek", "el"],
	["Geor", "ka"],
	["Armn", "hy"],
	["Sinh", "si"],
	["Taml", "ta"],
	["Telu", "te"],
	["Knda", "kn"],
	["Mlym", "ml"],
	["Gujr", "gu"],
	["Guru", "pa"],
	["Orya", "or"],
	["Olck", "sat"],
]);

/** The one language a script settles (rule 3), or null for ambiguous scripts. */
export function uniqueScriptLanguage(script: ScriptCode): LanguageCode | null {
	const code = UNIQUE.get(script);
	return code ? languageCode(code) : null;
}

/** Han-family scripts: text written only in Han can be Chinese or Japanese (kanji-only words). */
const HAN_WRITERS: ReadonlySet<ScriptCode> = new Set(["Hans", "Hant", "Hani", "Jpan"]);

/** True when `lang` is written in `script` (as the writing system `dominantScript` reports). */
export function languageUsesScript(lang: LanguageCode, script: ScriptCode): boolean {
	const own = scriptOf(lang);
	if (own === script) return true;
	if (script === "Hani") return HAN_WRITERS.has(own);
	if (script === "Kore" || script === "Hang") return own === "Hang" || own === "Kore";
	return false;
}

/** Catalogued languages written in `script`. */
export function languagesWritingScript(script: ScriptCode): LanguageCode[] {
	return allLanguages()
		.filter((l) => languageUsesScript(l.code, script))
		.map((l) => l.code);
}

/**
 * Membership in the user's subset. Lenient on regional and script variants of the same
 * language (`zh-Hant` text with `zh-Hans` picked, `pt-BR` with `pt`): a false skip hides
 * content, a false translate is cheap and visible (GLIM-21, rule 5c rationale).
 */
export function inSubset(lang: LanguageCode, subset: readonly LanguageCode[]): boolean {
	const canonical = lookupLanguage(lang)?.code ?? lang;
	const primary = primaryLanguage(canonical);
	return subset.some((s) => {
		const c = lookupLanguage(s)?.code ?? s;
		return c === canonical || primaryLanguage(c) === primary;
	});
}

// Common characters that differ between Simplified and Traditional Chinese, as pairs
// (simplified, traditional). Enough to tell UI strings and chat apart.
const PAIRS =
	"们們这這说說时時国國会會为為来來个個对對发發过過还還没沒么麼现現开開关關动動东東车車门門问問间間学學长長书書见見话話语語请請让讓认認设設载載号號页頁键鍵继繼续續输輸码碼钮鈕择擇选選网網络絡无無线線显顯帮幫务務级級终終结結经經种種实實样樣点點听聽乐樂电電视視频頻图圖档檔户戶钱錢买買卖賣员員热熱气氣边邊远遠这這进進运運还還连連处處备備报報将將难難数數据據";
const SIMPLIFIED = new Set<string>();
const TRADITIONAL = new Set<string>();
for (let i = 0; i + 1 < PAIRS.length; i += 2) {
	SIMPLIFIED.add(PAIRS[i] as string);
	TRADITIONAL.add(PAIRS[i + 1] as string);
}

/** `Hans` or `Hant` by counting characters unique to each, or null when undecided. */
export function chineseVariant(text: string): "Hans" | "Hant" | null {
	let s = 0;
	let t = 0;
	for (const ch of text) {
		if (SIMPLIFIED.has(ch)) s++;
		else if (TRADITIONAL.has(ch)) t++;
	}
	return s > t ? "Hans" : t > s ? "Hant" : null;
}
