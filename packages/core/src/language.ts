// Language identifiers. Glimpse uses BCP-47 tags everywhere (UI `lang` attributes,
// settings, cache keys, provider requests). Providers that want another scheme
// (FLORES-200 `jpn_Jpan`, Bergamot pair names) map from these at their own edge.

declare const languageCodeBrand: unique symbol;

/** A canonical BCP-47 tag such as `en`, `ja`, `zh-Hant`, `pt-BR`. Build with `parseLanguageCode`. */
export type LanguageCode = string & { readonly [languageCodeBrand]: true };

/**
 * Validate and canonicalise a BCP-47 tag (`EN` -> `en`, `zh-hant` -> `zh-Hant`).
 * Returns null for anything that is not a well-formed tag.
 */
export function parseLanguageCode(input: string): LanguageCode | null {
	const trimmed = input.trim().replaceAll("_", "-");
	if (trimmed === "") return null;
	try {
		const [canonical] = Intl.getCanonicalLocales(trimmed);
		return canonical ? (canonical as LanguageCode) : null;
	} catch {
		return null;
	}
}

/** Like `parseLanguageCode`, but throws. For literals in code and tests. */
export function languageCode(input: string): LanguageCode {
	const code = parseLanguageCode(input);
	if (!code) throw new RangeError(`not a BCP-47 language tag: ${JSON.stringify(input)}`);
	return code;
}

/** The primary language subtag: `zh-Hant` -> `zh`, `pt-BR` -> `pt`. */
export function primaryLanguage(code: LanguageCode): LanguageCode {
	return (code.split("-")[0] ?? code) as LanguageCode;
}

/** English name of a language for logs and fallbacks. UI uses the user's locale instead. */
export function languageName(code: LanguageCode, displayLocale = "en"): string {
	try {
		return new Intl.DisplayNames([displayLocale], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}
