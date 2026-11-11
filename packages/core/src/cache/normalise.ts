// The GLIM-20 normaliser: the one function that turns OCR text into translator input.
//
// The text that is hashed for the cache key is exactly the text that is sent to the
// provider, so normalisation can never make two inputs share an entry while translating
// differently. Steps: Unicode NFKC; strip zero-width and BiDi control characters; turn
// line breaks inside a block into spaces (removed between two characters of a script
// written without spaces, such as Japanese or Chinese); collapse whitespace runs; trim.
//
// Deliberately NOT applied, because each changes what a translator produces: case folding,
// punctuation removal, digit masking, homoglyph mapping.
//
// `NORMALISER_VERSION` is part of the cache key: bump it whenever the output changes for
// any input.

export const NORMALISER_VERSION = 1;

/** A regex character-class body from code point ranges (keeps invisible characters out of the source). */
const ranges = (...pairs: readonly (readonly [number, number])[]): string =>
	pairs
		.map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`))
		.join("");

/**
 * Zero-width characters and BiDi controls: ZWSP..RLM, LRE..RLO, word joiner and invisible
 * operators, LRI..PDI, BOM / ZWNBSP, soft hyphen, Arabic letter mark.
 */
const INVISIBLE = new RegExp(
	`[${ranges([0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xad, 0xad], [0x61c, 0x61c])}]`,
	"g",
);

/**
 * Characters of scripts written without spaces between words (a line break between two of
 * them is dropped): Han, kana, Thai, Lao, Khmer, Myanmar, CJK punctuation, full-width forms.
 */
const UNSPACED = new RegExp(
	`[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}${ranges([0x3000, 0x303f], [0xff00, 0xff9f])}]`,
	"u",
);

/** A line break (CRLF, LF, CR, VT, FF, NEL, line / paragraph separator) and the spaces around it. */
const LINE_BREAK = new RegExp(
	`[^\\S\\n]*(?:\\r\\n|[\\n\\r\\v\\f${ranges([0x85, 0x85], [0x2028, 0x2029])}])[^\\S\\n]*`,
	"g",
);

/** Normalise one block (or sentence) of OCR text into translator input. */
export function normaliseSegment(text: string): string {
	const nfkc = text.normalize("NFKC").replace(INVISIBLE, "");
	const joined = nfkc.replace(LINE_BREAK, (match: string, offset: number, whole: string) => {
		const before = whole[offset - 1] ?? "";
		const after = whole[offset + match.length] ?? "";
		return UNSPACED.test(before) && UNSPACED.test(after) ? "" : " ";
	});
	return joined.replace(/\s+/g, " ").trim();
}
