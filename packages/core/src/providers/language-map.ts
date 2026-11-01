// The seam between Glimpse's canonical BCP-47 `LanguageCode`s and a provider's own
// scheme (FLORES-200 `jpn_Jpan`, Bergamot `zh_hant`, Google `zh-TW`, M2M ISO codes).
//
// Interfaces speak `LanguageCode` only. A provider converts at its own edge through a
// `LanguageCodeMap`. GLIM-39 owns the real tables (in `packages/core/src/language/`);
// until then providers can build one from a small table with `languageMapFromTable`.

import { type LanguageCode, parseLanguageCode } from "../language.ts";

export interface LanguageCodeMap {
	/** The provider's code for a Glimpse language, or null if the provider has none. */
	toProvider(code: LanguageCode): string | null;
	/** The Glimpse language for a provider code (e.g. a detected language), or null. */
	fromProvider(providerCode: string): LanguageCode | null;
}

/** Provider codes are BCP-47 already (most cloud APIs). Unparseable codes map to null. */
export const identityLanguageMap: LanguageCodeMap = {
	toProvider: (code) => code,
	fromProvider: (providerCode) => parseLanguageCode(providerCode),
};

/**
 * Build a map from `{ "<bcp47>": "<provider code>" }`. Lookups try the exact tag first,
 * then its primary subtag (`pt-BR` falls back to `pt`). The first entry for a provider
 * code wins when mapping back.
 */
export function languageMapFromTable(table: Readonly<Record<string, string>>): LanguageCodeMap {
	const forward = new Map<string, string>();
	const back = new Map<string, LanguageCode>();
	for (const [tag, providerCode] of Object.entries(table)) {
		const code = parseLanguageCode(tag);
		if (!code) throw new RangeError(`not a BCP-47 tag in language table: ${JSON.stringify(tag)}`);
		forward.set(code, providerCode);
		if (!back.has(providerCode)) back.set(providerCode, code);
	}
	return {
		toProvider(code) {
			const exact = forward.get(code);
			if (exact !== undefined) return exact;
			const primary = code.split("-")[0];
			return primary === undefined ? null : (forward.get(primary) ?? null);
		},
		fromProvider: (providerCode) => back.get(providerCode) ?? null,
	};
}
