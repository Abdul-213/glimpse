// Which languages Cloud Translation v2 serves, as Glimpse `LanguageCode` -> Google code.
//
// Starts from the snapshot in core's language catalogue (the `google` scheme, GLIM-39) and is
// replaced by the live list from `GET /language/translate/v2/languages` when a key is present
// (GLIM-22: Google adds languages without notice). The live list spells some languages two
// ways (`zh` and `zh-CN`, `iw` and `he`, `jw` and `jv`); the catalogue's spelling wins when
// Google lists it, so cache keys and requests stay stable across refreshes.

import { allLanguages, fromGoogle, isPlainObject, type LanguageCode, normalizeLanguage, toGoogle } from "@glimpse/core";

export class GoogleLanguageTable {
	#codes: ReadonlyMap<LanguageCode, string>;
	#source: "snapshot" | "live";

	constructor(codes?: ReadonlyMap<LanguageCode, string>) {
		this.#codes = codes ?? GoogleLanguageTable.snapshot();
		this.#source = codes ? "live" : "snapshot";
	}

	/** The catalogue's Google v2 codes (a documented-list snapshot). */
	static snapshot(): Map<LanguageCode, string> {
		const map = new Map<LanguageCode, string>();
		for (const l of allLanguages()) if (l.google) map.set(l.code, l.google);
		return map;
	}

	/** Build from the codes Google returned. Unknown spellings are kept as BCP-47 where they parse. */
	static fromCodes(googleCodes: Iterable<string>): Map<LanguageCode, string> {
		const listed = new Set(googleCodes);
		const map = new Map<LanguageCode, string>();
		for (const code of listed) {
			const lang = fromGoogle(code);
			if (!lang) continue;
			const canonical = normalizeLanguage(lang);
			const preferred = toGoogle(canonical);
			const chosen = preferred !== null && listed.has(preferred) ? preferred : code;
			if (!map.has(canonical) || chosen === preferred) map.set(canonical, chosen);
		}
		return map;
	}

	get source(): "snapshot" | "live" {
		return this.#source;
	}

	get size(): number {
		return this.#codes.size;
	}

	/** Replace with a live list. An empty list is ignored (keeps what we had). */
	replace(codes: ReadonlyMap<LanguageCode, string>): boolean {
		if (codes.size === 0) return false;
		this.#codes = codes;
		this.#source = "live";
		return true;
	}

	/** Google's code for a language, or null if v2 doesn't serve it. */
	codeFor(lang: LanguageCode): string | null {
		return this.#codes.get(normalizeLanguage(lang)) ?? this.#codes.get(lang) ?? null;
	}

	languages(): LanguageCode[] {
		return [...this.#codes.keys()];
	}
}

/** The `language` codes in a `/v2/languages` reply. Lenient: anything malformed is skipped. */
export function parseLanguagesReply(json: unknown): string[] {
	const data = isPlainObject(json) && isPlainObject(json["data"]) ? json["data"] : null;
	const list = data && Array.isArray(data["languages"]) ? data["languages"] : [];
	const codes: string[] = [];
	for (const entry of list) {
		const code = isPlainObject(entry) ? entry["language"] : undefined;
		if (typeof code === "string" && code.length > 0 && code.length <= 16) codes.push(code);
	}
	return codes;
}
