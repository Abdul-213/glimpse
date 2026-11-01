// GLIM-49: the ELD (Efficient Language Detector, Apache-2.0) implementation of core's
// `LanguageDetector` port, the primary detector chosen in GLIM-21. Medium database (GLIM-21
// open question 2: +104 MB RSS, 91% on short blocks; small saves ~15 MB for 1 point).
// Detects over ELD's full 60 languages (never `setLanguageSubset`, GLIM-21); core decides
// membership. Labels map to BCP-47 through core's catalogue (`eld` scheme), with Simplified vs
// Traditional Chinese chosen by character.
//
// Synchronous and ~0.05 ms per block (GLIM-21), so it runs on the orchestrating thread.
// The database loads on first use (module import), not at app start.

import {
	chineseVariant,
	type DetectorCandidate,
	type DetectorResult,
	fromScheme,
	type LanguageCode,
	type LanguageDetector,
} from "@glimpse/core";

/** The slice of ELD's API we use (its own typings ship in the package). */
interface EldLike {
	detect(text: string): { language: string; getScores(): Record<string, number>; isReliable(): boolean };
	info(): { Languages: Record<number, string> };
}

const toCode = (label: string, text: string): LanguageCode | null => {
	const hint = label === "zh" ? (chineseVariant(text) ?? "Hans") : undefined;
	return fromScheme("eld", label, hint);
};

export class EldLanguageDetector implements LanguageDetector {
	readonly id = "eld-medium";
	readonly languages: readonly LanguageCode[];
	readonly #eld: EldLike;

	constructor(eld: EldLike) {
		this.#eld = eld;
		const labels = Object.values(eld.info().Languages);
		const codes = labels.flatMap((l) =>
			l === "zh" ? [fromScheme("eld", l, "Hans"), fromScheme("eld", l, "Hant")] : [fromScheme("eld", l)],
		);
		this.languages = [...new Set(codes)].filter((c): c is LanguageCode => c !== null);
	}

	detect(text: string): DetectorResult {
		const r = this.#eld.detect(text);
		const candidates: DetectorCandidate[] = [];
		for (const [label, score] of Object.entries(r.getScores())) {
			const lang = toCode(label, text);
			if (lang && !candidates.some((c) => c.lang === lang)) candidates.push({ lang, score: clamp(score) });
		}
		candidates.sort((a, b) => b.score - a.score);
		return { candidates, reliable: r.language !== "" && r.isReliable() };
	}
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Load ELD's medium database and wrap it. */
export async function loadEldDetector(): Promise<EldLanguageDetector> {
	const { eld } = await import("eld/medium");
	return new EldLanguageDetector(eld);
}
