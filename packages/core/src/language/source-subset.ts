// The source-language subset (GLIM-68): which languages a user can pick in Settings and how the
// picker groups them by script. The filter itself is the pipeline's `classifyBlock`
// (pipeline/pipeline.ts: empty subset = every language, loose matching). Pure.
//
// - Settings stores catalogue tags (`language.sources`); an empty list means every language.
// - A language is offered when Glimpse can do something useful with it: detect it (ELD or
//   fastText label, GLIM-21) or translate it locally (a Bergamot pack). Languages that can be
//   translated but not detected are still offered, flagged, because detection may improve
//   (the UI says "can't be detected reliably").

import type { LanguageCode } from "./code.ts";
import { displayName, nativeName } from "./display.ts";
import { allLanguages, type LanguageInfo, lookupLanguage } from "./lookup.ts";
import { localOcrIsPartial, recognizersFor } from "./ocr.ts";
import type { ScriptCode } from "./script.ts";

/** One language in the source-language picker. Plain data, safe to send over RPC. */
export interface SourceLanguageChoice {
	readonly code: LanguageCode;
	/** Name in the UI language ("Japanese"). */
	readonly name: string;
	/** The language's own name ("日本語"). */
	readonly nativeName: string;
	readonly script: ScriptCode;
	/** Group key for the picker (`Latn`, `Cyrl`, `Hani`, ... or `other`). */
	readonly group: string;
	/** A detector label exists (ELD or fastText). */
	readonly detectable: boolean;
	/** A local translation pack exists for it (Bergamot), installed or not. */
	readonly localTranslation: boolean;
	/** Bundled/downloadable local OCR can read its script. */
	readonly localOcr: boolean;
	/** ...but loses part of its letters (Vietnamese tone marks, GLIM-126): cloud OCR reads it fully. */
	readonly localOcrPartial: boolean;
}

export interface SourceLanguageGroup {
	readonly key: string;
	/** Script name in the UI language ("Latin", "Cyrillic"); "Other scripts" for the rest. */
	readonly label: string;
	readonly languages: readonly SourceLanguageChoice[];
}

/** Han-based scripts share one group: a reader of one usually wants the others close by. */
function groupScript(script: ScriptCode): ScriptCode {
	return script === "Hans" || script === "Hant" ? "Hani" : script;
}

const OTHER = "other";

function scriptLabel(script: ScriptCode, displayLocale: string): string {
	for (const locale of [displayLocale, "en"]) {
		try {
			const name = new Intl.DisplayNames([locale], { type: "script", fallback: "none" }).of(script);
			if (name) return name;
		} catch {
			// Unknown locale or script in this runtime; try the next.
		}
	}
	return script;
}

const offered = (e: LanguageInfo) => e.bergamot !== undefined || e.eld !== undefined || e.fasttext !== undefined;

/** Every language the picker offers, sorted by UI name. */
export function sourceLanguageChoices(displayLocale = "en"): SourceLanguageChoice[] {
	const collator = new Intl.Collator(displayLocale, { sensitivity: "base" });
	return allLanguages()
		.filter(offered)
		.map((e) => ({
			code: e.code,
			name: displayName(e.code, displayLocale, { style: "standard" }),
			nativeName: nativeName(e.code, { style: "standard" }),
			script: e.script,
			group: groupScript(e.script),
			detectable: e.eld !== undefined || e.fasttext !== undefined,
			localTranslation: e.bergamot !== undefined,
			localOcr: recognizersFor(e.code).length > 0,
			localOcrPartial: localOcrIsPartial(e.code),
		}))
		.sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * Group choices by script for the picker. Scripts with at least `minGroupSize` languages get
 * their own group, largest first; the rest share "Other scripts" at the end. Within a group
 * the input order (by name) is kept.
 */
export function groupSourceLanguages(
	choices: readonly SourceLanguageChoice[],
	displayLocale = "en",
	minGroupSize = 3,
): SourceLanguageGroup[] {
	const byScript = new Map<string, SourceLanguageChoice[]>();
	for (const c of choices) {
		const list = byScript.get(c.group);
		if (list) list.push(c);
		else byScript.set(c.group, [c]);
	}
	const big: SourceLanguageGroup[] = [];
	const other: SourceLanguageChoice[] = [];
	for (const [key, languages] of byScript) {
		if (languages.length >= minGroupSize) big.push({ key, label: scriptLabel(key, displayLocale), languages });
		else other.push(...languages);
	}
	big.sort((a, b) => b.languages.length - a.languages.length || a.label.localeCompare(b.label));
	if (other.length > 0) {
		const collator = new Intl.Collator(displayLocale, { sensitivity: "base" });
		other.sort((a, b) => collator.compare(a.name, b.name));
		big.push({ key: OTHER, label: "Other scripts", languages: other });
	}
	return big;
}

/** The catalogue tag for a user-entered code, or null when Glimpse doesn't offer it. */
export function sourceLanguageFor(code: string): LanguageCode | null {
	const entry = lookupLanguage(code);
	return entry && offered(entry) ? entry.code : null;
}
