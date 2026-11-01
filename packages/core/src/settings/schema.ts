// GLIM-53: the settings schema and its defaults. Pure: `(unknown json) -> Settings`.
//
// Every field has a default, so any input (missing file, old file, hand-edited file with
// typos) parses to complete settings plus a list of repairs. Defaults that depend on the
// machine (hotkeys per OS, target language from the OS locale, installed providers) come
// in through `SettingsEnv`; core never looks at the platform itself.
//
// Changing the shape: bump SETTINGS_VERSION and add a migration (migrations.ts) when old
// files would otherwise lose data. Adding a field with a default needs no migration.

import { type LanguageCode, languageCode, parseLanguageCode } from "../language.ts";
import type { ProvidersConfig } from "../providers/registry.ts";
import {
	array,
	boolean,
	type Issue,
	languageCodeSchema,
	number,
	object,
	oneOf,
	parseOrDefault,
	type Schema,
	withDefault,
} from "../schema/index.ts";
import { type HotkeyBindings, hotkeyBindingsSchema } from "./hotkeys.ts";

export const SETTINGS_VERSION = 1;

export interface Settings {
	readonly language: {
		/** The language results are shown in. */
		readonly target: LanguageCode;
		/** Source-language subset: only blocks in these are translated. Empty = every language. */
		readonly sources: readonly LanguageCode[];
	};
	readonly hotkeys: HotkeyBindings;
	/** Provider per task: OCR, translation chain, per-provider options (GLIM-43). */
	readonly providers: ProvidersConfig;
	readonly appearance: {
		/** `system` follows the OS light/dark appearance. */
		readonly theme: "system" | "light" | "dark";
		/** `system` follows the OS reduced-motion setting (PRODUCT.md). */
		readonly motion: "system" | "reduced" | "full";
	};
	readonly live: {
		/** Capture rate while a region is pinned (PRODUCT.md: about 2–4 fps). */
		readonly fps: number;
		/** Fraction of pixels (0..1) that must change before re-OCR. GLIM-56 tunes it. */
		readonly diffThreshold: number;
		/** The region must be stable this long before re-OCR (PRODUCT.md: about 300 ms). */
		readonly stabilityMs: number;
	};
	readonly privacy: {
		/** Start every Snip/Live session in Private mode (its own cache, discarded after; GLIM-20). */
		readonly privateByDefault: boolean;
		/** Wipe the translation cache after this many idle minutes; 0 = only on quit (GLIM-20: 15). */
		readonly clearCacheAfterIdleMinutes: number;
		/** Wipe the cache on screen lock and system sleep (GLIM-20). */
		readonly clearCacheOnLock: boolean;
	};
	readonly system: {
		readonly launchAtLogin: boolean;
	};
	readonly onboarding: {
		readonly completed: boolean;
	};
}

export interface SettingsEnv {
	/** GLIM-23 defaults for this OS: `DEFAULT_HOTKEYS.windows` or `.macos`. */
	readonly hotkeys: HotkeyBindings;
	/** `registry.configSchema()`: validates provider ids and options against what's installed. */
	readonly providers: Schema<ProvidersConfig>;
	/** Default target language, usually `defaultTargetLanguage(<OS locale>)`. */
	readonly targetLanguage: LanguageCode;
}

export function settingsSchema(env: SettingsEnv): Schema<Settings> {
	return object({
		language: object({
			target: withDefault(languageCodeSchema(), env.targetLanguage),
			sources: withDefault(array(languageCodeSchema(), { maxLength: 256, uniqueBy: (c) => c }), []),
		}),
		hotkeys: hotkeyBindingsSchema(env.hotkeys),
		providers: env.providers,
		appearance: object({
			theme: withDefault(oneOf(["system", "light", "dark"] as const), "system"),
			motion: withDefault(oneOf(["system", "reduced", "full"] as const), "system"),
		}),
		live: object({
			fps: withDefault(number({ min: 0.5, max: 10 }), 3),
			diffThreshold: withDefault(number({ min: 0, max: 1 }), 0.02),
			stabilityMs: withDefault(number({ min: 0, max: 5000, integer: true }), 300),
		}),
		privacy: object({
			privateByDefault: withDefault(boolean(), false),
			clearCacheAfterIdleMinutes: withDefault(number({ min: 0, max: 24 * 60, integer: true }), 15),
			clearCacheOnLock: withDefault(boolean(), true),
		}),
		system: object({
			launchAtLogin: withDefault(boolean(), false),
		}),
		onboarding: object({
			completed: withDefault(boolean(), false),
		}),
	});
}

/** Settings for a first run. */
export const defaultSettings = (env: SettingsEnv): Settings => parseOrDefault(settingsSchema(env), {}).value;

/** Parse any JSON value into complete settings, with the repairs made. Never throws. */
export function parseSettings(input: unknown, env: SettingsEnv): { settings: Settings; issues: Issue[] } {
	const { value, issues } = parseOrDefault(settingsSchema(env), input);
	return { settings: value, issues };
}

/** The file contents: `{ "version": N, ...settings }`, pretty-printed, newline-terminated. */
export function serializeSettings(settings: Settings, version: number = SETTINGS_VERSION): string {
	return `${JSON.stringify({ version, ...settings }, null, 2)}\n`;
}

/**
 * A default target language from an OS locale (`de-AT` -> `de`, `zh-TW` -> `zh-Hant`,
 * `zh-CN` -> `zh-Hans`). Falls back to English. GLIM-39 may refine the mapping.
 */
export function defaultTargetLanguage(locale: string | undefined): LanguageCode {
	const code = locale ? parseLanguageCode(locale) : null;
	if (!code) return languageCode("en");
	let loc: Intl.Locale;
	try {
		loc = new Intl.Locale(code).maximize();
	} catch {
		return languageCode("en");
	}
	if (loc.language === "zh") return languageCode(loc.script === "Hant" ? "zh-Hant" : "zh-Hans");
	return parseLanguageCode(loc.language) ?? languageCode("en");
}

type DeepPartial<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { readonly [K in keyof T]?: DeepPartial<T[K]> }
		: T;
export type SettingsPatch = DeepPartial<Settings>;

const isMergeable = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isMergeable(base) || !isMergeable(patch)) return patch === undefined ? base : patch;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
	return out;
}

/**
 * Apply a change from the Settings UI: deep-merge (lists replace), then re-validate. An
 * invalid value in the patch is not applied (the field keeps its current value) and comes
 * back as an issue, so a view can never write a bad value.
 */
export function applySettingsPatch(
	current: Settings,
	patch: SettingsPatch,
	env: SettingsEnv,
): { settings: Settings; issues: Issue[] } {
	const { settings, issues } = parseSettings(deepMerge(current, patch), env);
	return { settings: issues.length === 0 ? settings : restoreRejected(settings, current, issues), issues };
}

/** Put back the current value at every path an issue was reported for (lists as a whole). */
function restoreRejected(next: Settings, current: Settings, issues: readonly Issue[]): Settings {
	let out: unknown = next;
	for (const { path } of issues) {
		const keys = path
			.replace(/\[\d+\]$/, "")
			.split(".")
			.filter(Boolean);
		if (keys.length === 0) continue;
		let src: unknown = current;
		for (const k of keys) src = isMergeable(src) ? src[k] : undefined;
		if (src === undefined) continue;
		out = setPath(out, keys, src);
	}
	return out as Settings;
}

function setPath(target: unknown, keys: readonly string[], value: unknown): unknown {
	const [head, ...rest] = keys;
	if (head === undefined) return value;
	const obj = isMergeable(target) ? target : {};
	return { ...obj, [head]: setPath(obj[head], rest, value) };
}
