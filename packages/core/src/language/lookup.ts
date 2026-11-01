// Lookups over the catalogue: BCP-47 <-> every external scheme, and per-language script,
// direction and canonical form. Providers call `toScheme` at their edge and `fromScheme` on
// whatever comes back; everything in between uses `LanguageCode`.

import { CATALOG, type CatalogEntry, LANGUAGE_SCHEMES, type LanguageScheme } from "./catalog.ts";
import { type LanguageCode, parseLanguageCode } from "./code.ts";
import { type ScriptCode, scriptDirection, type TextDirection } from "./script.ts";

export interface LanguageInfo extends CatalogEntry {
	readonly code: LanguageCode;
	readonly direction: TextDirection;
}

const entries: readonly LanguageInfo[] = CATALOG.map((e) => ({
	...e,
	code: e.code as LanguageCode,
	direction: scriptDirection(e.script),
}));

const byCode = new Map<string, LanguageInfo>(entries.map((e) => [e.code, e]));

/** scheme -> scheme code (lower-cased) -> rows using it, in catalogue order. */
const byScheme = new Map<LanguageScheme, Map<string, LanguageInfo[]>>(
	LANGUAGE_SCHEMES.map((scheme) => {
		const index = new Map<string, LanguageInfo[]>();
		for (const e of entries) {
			const key = e[scheme]?.toLowerCase();
			if (key === undefined) continue;
			const list = index.get(key);
			if (list) list.push(e);
			else index.set(key, [e]);
		}
		return [scheme, index];
	}),
);

/**
 * Inputs that canonicalise to a tag the catalogue spells differently. `Intl` already folds
 * deprecated tags (`iw` -> `he`, `in` -> `id`, `ji` -> `yi`); these are the ones it keeps.
 */
const ALIASES: Readonly<Record<string, string>> = {
	no: "nb",
	fil: "tl",
	sh: "hr", // Serbo-Croatian in Latin script; NLLB has no Latin Serbian (GLIM-21)
	cmn: "zh-Hans",
	arb: "ar",
	zsm: "ms",
	pes: "fa",
	prs: "fa-AF",
	lvs: "lv",
	als: "sq",
	azj: "az",
	khk: "mn",
	npi: "ne",
	ory: "or",
	pbt: "ps",
	plt: "mg",
	quy: "qu",
	swh: "sw",
	uzn: "uz",
	ydd: "yi",
	gaz: "om",
	kmr: "ku",
};

/** Every catalogued language, in catalogue order (Bergamot languages first). */
export function allLanguages(): readonly LanguageInfo[] {
	return entries;
}

/**
 * Find the catalogue row for a tag, falling back the way a user would expect:
 * exact tag, then alias (`no` -> `nb`), then language + likely script (`zh-TW` -> `zh-Hant`,
 * `zh` -> `zh-Hans`), then the bare language when its script agrees (`pt-BR` -> `pt`,
 * but not `sr-Latn` -> `sr`, which is Cyrillic).
 */
export function lookupLanguage(code: LanguageCode | string): LanguageInfo | undefined {
	const canonical = parseLanguageCode(code);
	if (!canonical) return undefined;
	const exact = byCode.get(canonical) ?? byCode.get(ALIASES[canonical] ?? "");
	if (exact) return exact;

	let locale: Intl.Locale;
	try {
		locale = new Intl.Locale(canonical).maximize();
	} catch {
		return undefined;
	}
	const language = ALIASES[locale.language] ?? locale.language;
	const script = locale.script;
	if (script) {
		const withScript = byCode.get(`${language}-${script}`);
		if (withScript) return withScript;
	}
	const bare = byCode.get(language);
	if (bare && (!script || bare.script === script)) return bare;
	return undefined;
}

/** The catalogue's tag for `code` (`zh-TW` -> `zh-Hant`), or the input when it isn't catalogued. */
export function normalizeLanguage(code: LanguageCode): LanguageCode {
	return lookupLanguage(code)?.code ?? code;
}

/** True when two tags name the same catalogued language (`pt-BR` ~ `pt`, `zh-TW` ~ `zh-Hant`). */
export function sameLanguage(a: LanguageCode, b: LanguageCode): boolean {
	if (a === b) return true;
	const la = lookupLanguage(a);
	return la !== undefined && la === lookupLanguage(b);
}

/** Script of a language: the catalogue's, else `Intl`'s likely script, else `Zyyy` (unknown). */
export function scriptOf(code: LanguageCode): ScriptCode {
	const entry = lookupLanguage(code);
	if (entry) return entry.script;
	try {
		return new Intl.Locale(code).maximize().script ?? "Zyyy";
	} catch {
		return "Zyyy";
	}
}

/** Writing direction of a language, for `dir` attributes and overlay layout. */
export function directionOf(code: LanguageCode): TextDirection {
	return scriptDirection(scriptOf(code));
}

/** The code `scheme` uses for this language, or null if that scheme doesn't have it. */
export function toScheme(code: LanguageCode, scheme: LanguageScheme): string | null {
	return lookupLanguage(code)?.[scheme] ?? null;
}

/**
 * Map a code from an external scheme back to a `LanguageCode`.
 * `scriptHint` chooses between rows that share a code (ELD `zh` + `Hant` -> `zh-Hant`).
 * Codes the catalogue doesn't list fall back to plain BCP-47 parsing (fastText's long tail
 * like `nds` or `wuu` are valid tags), except for FLORES, whose codes aren't BCP-47.
 */
export function fromScheme(scheme: LanguageScheme, value: string, scriptHint?: ScriptCode): LanguageCode | null {
	const key = value
		.trim()
		.toLowerCase()
		.replace(/^__label__/, "");
	const rows = byScheme.get(scheme)?.get(scheme === "flores" ? floresAlias(key) : key);
	if (rows && rows.length > 0) {
		const hinted = scriptHint ? rows.find((r) => r.script === scriptHint) : undefined;
		return (hinted ?? rows[0])?.code ?? null;
	}
	if (scheme === "flores") return null;
	const parsed = parseLanguageCode(key);
	return parsed ? normalizeLanguage(parsed) : null;
}

/** FLORES-200 spells Santali `sat_Olck`; NLLB's tokenizer spells it `sat_Beng`. */
function floresAlias(key: string): string {
	return key === "sat_olck" ? "sat_beng" : key;
}

/**
 * A provider-edge code map for one scheme. Structurally the `LanguageCodeMap` from
 * `providers/language-map.ts` (GLIM-32/33), so a provider can pass `schemeLanguageMap("bergamot")`
 * wherever that interface is expected. (Not imported, to keep language/ free of providers/.)
 */
export function schemeLanguageMap(scheme: LanguageScheme): {
	toProvider(code: LanguageCode): string | null;
	fromProvider(providerCode: string): LanguageCode | null;
} {
	return {
		toProvider: (code) => toScheme(code, scheme),
		fromProvider: (providerCode) => fromScheme(scheme, providerCode),
	};
}

// Convenience wrappers for the schemes providers use most.

export const toFlores = (code: LanguageCode): string | null => toScheme(code, "flores");
export const fromFlores = (value: string): LanguageCode | null => fromScheme("flores", value);
export const toBergamot = (code: LanguageCode): string | null => toScheme(code, "bergamot");
export const fromBergamot = (value: string): LanguageCode | null => fromScheme("bergamot", value);
export const toM2m = (code: LanguageCode): string | null => toScheme(code, "m2m");
export const fromM2m = (value: string, scriptHint?: ScriptCode): LanguageCode | null =>
	fromScheme("m2m", value, scriptHint);
export const toGoogle = (code: LanguageCode): string | null => toScheme(code, "google");
export const fromGoogle = (value: string): LanguageCode | null => fromScheme("google", value);
