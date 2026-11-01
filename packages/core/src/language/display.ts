// Language names for the UI, from the runtime's CLDR data (Intl.DisplayNames). No tables of
// our own: names follow the user's locale and stay current with the OS/runtime.

import type { LanguageCode } from "./code.ts";

export interface DisplayNameOptions {
	/**
	 * `dialect` (default) gives "Simplified Chinese", "Brazilian Portuguese";
	 * `standard` gives "Chinese (Simplified)", "Portuguese (Brazil)", which sorts better in lists.
	 */
	readonly style?: "dialect" | "standard";
}

const cache = new Map<string, Intl.DisplayNames | null>();

function displayNames(locale: string, style: "dialect" | "standard"): Intl.DisplayNames | null {
	const key = `${locale}|${style}`;
	let names = cache.get(key);
	if (names === undefined) {
		try {
			names = new Intl.DisplayNames([locale, "en"], { type: "language", languageDisplay: style, fallback: "none" });
		} catch {
			names = null;
		}
		cache.set(key, names);
	}
	return names;
}

/**
 * The name of `code` in `displayLocale` ("Japanese" in `en`, "japonais" in `fr`).
 * Falls back to English, then to the tag itself, so it never returns an empty string.
 */
export function displayName(code: LanguageCode, displayLocale = "en", options: DisplayNameOptions = {}): string {
	const style = options.style ?? "dialect";
	for (const locale of [displayLocale, "en"]) {
		try {
			const name = displayNames(locale, style)?.of(code);
			if (name && name !== code) return name;
		} catch {
			// `of` throws on tags the runtime rejects; try the next locale.
		}
	}
	return code;
}

/** The language's name in itself ("日本語", "Deutsch"), for pickers. */
export function nativeName(code: LanguageCode, options: DisplayNameOptions = {}): string {
	return displayName(code, code, options);
}
