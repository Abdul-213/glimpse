// The "detection copy" of a block's text (GLIM-21, short and low-confidence block rule): NFKC,
// with URLs, e-mail addresses, @handles, #tags, digits, units, punctuation and emoji removed.
// Plus the weighted letter count rule 1 uses and the known neutral tokens.

/** URLs, e-mails, @handles and #tags. Removed before anything else. */
const NON_TEXT = /(?:https?:\/\/|www\.)\S+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}|[@#][\p{L}\p{N}_]+/gu;
/** Numbers with an optional unit right after them: `12 MB`, `100%`, `3.5GHz`, `60fps`, `10:30`. */
const NUMBER_UNIT = /\p{N}+(?:[.,:]\p{N}+)*\s?(?:%|[\p{L}µ°]{1,3}(?![\p{L}]))?/gu;
/** Anything that isn't a letter, combining mark or space. */
const NOT_LETTER = /[^\p{L}\p{M}\s]+/gu;

export function detectionCopy(text: string): string {
	return text
		.normalize("NFKC")
		.replace(NON_TEXT, " ")
		.replace(NUMBER_UNIT, " ")
		.replace(NOT_LETTER, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const HEAVY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LETTER = /\p{L}/u;

/**
 * Letters in a detection copy. Han, hiragana and katakana count 3 each, so a two-character
 * Japanese word (`設定`) isn't "short" (GLIM-21).
 */
export function weightedLetters(copy: string): number {
	let n = 0;
	for (const ch of copy) {
		if (!LETTER.test(ch)) continue;
		n += HEAVY.test(ch) ? 3 : 1;
	}
	return n;
}

/**
 * Whole-block tokens with no language: keys, game stats, units, connectors. Compared upper-cased
 * against the block text with spaces and dots removed (`Lv.` -> `LV`).
 */
const NEUTRAL_TOKENS: ReadonlySet<string> = new Set([
	"OK",
	"ESC",
	"ENTER",
	"TAB",
	"SHIFT",
	"CTRL",
	"ALT",
	"CMD",
	"DEL",
	"DELETE",
	"HOME",
	"END",
	"PGUP",
	"PGDN",
	"FN",
	"LV",
	"LVL",
	"HP",
	"MP",
	"SP",
	"AP",
	"XP",
	"EXP",
	"ATK",
	"DEF",
	"STR",
	"DEX",
	"INT",
	"AGI",
	"DPS",
	"FPS",
	"KB",
	"MB",
	"GB",
	"TB",
	"KBPS",
	"MBPS",
	"GHZ",
	"MHZ",
	"PC",
	"ID",
	"URL",
	"USB",
	"USBC",
	"HDMI",
	"WIFI",
	"PDF",
	"JPG",
	"PNG",
	"GIF",
	"MP3",
	"MP4",
	"VS",
	"AM",
	"PM",
	"X",
]);

const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const VERSION = /^v?\d+(?:\.\d+)+[a-z0-9-]*$/i;

/** True when the whole block is a known token with no language (`OK`, `F5`, `Lv.`, `v1.2.3`). */
export function isNeutralToken(text: string): boolean {
	const t = text.normalize("NFKC").trim();
	if (VERSION.test(t)) return true;
	const key = t.replace(/[\s.\-_:/]+/g, "").toUpperCase();
	return NEUTRAL_TOKENS.has(key) || FUNCTION_KEY.test(key);
}

/** Key for the Live text cache (rule 5a): the detection copy, case-folded. */
export const textKey = (copy: string): string => copy.toLowerCase();
