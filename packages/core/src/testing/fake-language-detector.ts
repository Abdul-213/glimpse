// A scripted LanguageDetector for tests: answers from a table keyed by detection copy, else
// a default. Counts calls so tests can check the script pass and caches skip the detector.
//
//   const d = new FakeLanguageDetector({ "Hola amigos": [["es", 0.8]] }, { languages: ["es", "pt"] });

import { type LanguageCode, languageCode } from "../language/code.ts";
import type { DetectorResult, DetectorTuning, LanguageDetector } from "../language/detect/detector.ts";

export type FakeDetection = readonly (readonly [string, number])[];

export class FakeLanguageDetector implements LanguageDetector {
	readonly id: string;
	readonly languages: readonly LanguageCode[];
	readonly tuning?: DetectorTuning;
	readonly calls: string[] = [];
	readonly #table: Readonly<Record<string, FakeDetection>>;
	readonly #fallback: FakeDetection;
	readonly #reliable: (text: string) => boolean;

	constructor(
		table: Readonly<Record<string, FakeDetection>> = {},
		options: {
			readonly id?: string;
			readonly languages?: readonly string[];
			readonly fallback?: FakeDetection;
			/** Default: reliable when the text has at least 8 characters. */
			readonly reliable?: (text: string) => boolean;
			/** The detector's own thresholds (GLIM-104); none by default (rule 4w off). */
			readonly tuning?: DetectorTuning;
		} = {},
	) {
		if (options.tuning) this.tuning = options.tuning;
		this.#table = table;
		this.id = options.id ?? "fake-lid";
		this.languages = (options.languages ?? ["en", "de", "fr", "es", "pt", "it", "ru", "uk", "zh", "ja"]).map(
			languageCode,
		);
		this.#fallback = options.fallback ?? [];
		this.#reliable = options.reliable ?? ((t) => t.length >= 8);
	}

	detect(text: string): DetectorResult {
		this.calls.push(text);
		const rows = this.#table[text] ?? this.#fallback;
		return {
			candidates: rows.map(([lang, score]) => ({ lang: languageCode(lang), score })),
			reliable: rows.length > 0 && this.#reliable(text),
		};
	}
}
