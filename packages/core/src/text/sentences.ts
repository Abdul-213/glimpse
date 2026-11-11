// Sentence splitting for translation (GLIM-85 "split blocks into sentences before
// translating", GLIM-20 "one cache entry per sentence"). Sentence-trained models (Bergamot,
// SMaLL-100, NLLB) drop or merge sentences when handed a whole paragraph, so a block is
// translated sentence by sentence and the outputs are joined back with the source's own
// separators.
//
// Uses `Intl.Segmenter` (sentence granularity, ICU rules: CJK full stops, `!?`, line breaks)
// plus a small abbreviation fix-up, because ICU without locale suppressions breaks after
// "Mr." and "e.g.". `SEGMENTER_VERSION` is part of the translation cache key: bump it when
// the output of `splitSentences` changes for any input.

import type { LanguageCode } from "../language/code.ts";
import { scriptOf } from "../language/lookup.ts";

export const SEGMENTER_VERSION = 1;

/** One sentence of a block and the whitespace that followed it in the source. */
export interface SentencePiece {
	/** The sentence without surrounding whitespace. Never empty. */
	readonly text: string;
	/** Whitespace between this sentence and the next one in the source ("" for none). */
	readonly trailing: string;
}

/** Abbreviations that end in a full stop but don't end a sentence (Latin-script languages). */
const ABBREVIATION =
	/(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|approx|Nr|Fig|Vol|ca|bzw|z\.\s?B|d\.\s?h|u\.\s?a|e\.\s?g|i\.\s?e|[A-Z])\.$/;

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: LanguageCode | undefined): Intl.Segmenter {
	const key = lang ?? "";
	let segmenter = segmenters.get(key);
	if (!segmenter) {
		try {
			segmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
		} catch {
			segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
		}
		segmenters.set(key, segmenter);
	}
	return segmenter;
}

/**
 * Split text into sentences. Leading whitespace is dropped, whitespace between sentences is
 * kept in `trailing`, whitespace-only input gives `[]`. A line break ends a sentence (ICU
 * rule), which suits UI lists and subtitles; join wrapped lines before calling this.
 */
export function splitSentences(text: string, lang?: LanguageCode): SentencePiece[] {
	const raw: string[] = [];
	for (const { segment } of segmenterFor(lang).segment(text)) {
		const previous = raw.at(-1);
		// "Mr. " / "e.g. " followed by more text: glue it to the next segment.
		if (previous !== undefined && !/\n\s*$/.test(previous) && ABBREVIATION.test(previous.trimEnd())) {
			raw[raw.length - 1] = previous + segment;
		} else raw.push(segment);
	}
	const pieces: SentencePiece[] = [];
	for (const segment of raw) {
		const body = segment.trim();
		const trailing = segment.slice(segment.trimEnd().length);
		if (body === "") {
			// Whitespace-only segment: fold it into the previous separator.
			const last = pieces.at(-1);
			if (last) pieces[pieces.length - 1] = { text: last.text, trailing: last.trailing + segment };
			continue;
		}
		pieces.push({ text: body, trailing });
	}
	const last = pieces.at(-1);
	if (last) pieces[pieces.length - 1] = { text: last.text, trailing: "" };
	return pieces;
}

/** Scripts written without spaces between sentences. */
const UNSPACED_SCRIPTS = new Set(["Jpan", "Hani", "Hans", "Hant", "Hira", "Kana", "Thai", "Laoo", "Khmr", "Mymr"]);

/**
 * Join translated sentences with the source's separators. Line breaks are kept as they
 * were; plain spaces become "" for unspaced targets (Japanese, Chinese, Thai), and a missing
 * separator (Japanese source `。` with nothing after it) becomes one space for spaced targets.
 */
export function joinSentences(
	translated: readonly string[],
	pieces: readonly Pick<SentencePiece, "trailing">[],
	target: LanguageCode,
): string {
	const unspaced = UNSPACED_SCRIPTS.has(scriptOf(target));
	let out = "";
	translated.forEach((text, i) => {
		out += text.trim();
		if (i === translated.length - 1) return;
		const sep = pieces[i]?.trailing ?? "";
		if (sep.includes("\n")) out += sep.replace(/[^\S\n]+/g, "");
		else out += unspaced ? "" : " ";
	});
	return out;
}
