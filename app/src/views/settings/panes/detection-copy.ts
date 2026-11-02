// Settings › Languages: what each source language's detection needs (GLIM-68, GLIM-104).
// Pure: unit-tested without a DOM.
import type { SourceLanguageChoice } from "@glimpse/core";
import type { ModelRow } from "../../../shared/settings-rpc.ts";

/** The fastText lid.176 model's id in app/models/manifest.json. */
export const LANGUAGE_IDENTIFIER_ID = "fasttext-lid176";

/**
 * The one note an option shows: what stops it working, most fundamental first. Missing packs
 * aren't noted (almost every language starts without one); Models and the popup offer them.
 * `identifier`: the language identifier's row, or undefined while the models aren't known.
 */
export function noteFor(l: SourceLanguageChoice, identifier: ModelRow | undefined): string | undefined {
	if (!l.detectable) return "Can't be detected reliably";
	if (l.detectedBy === "fasttext" && identifier && identifier.state.status !== "installed") {
		return "Needs the language identifier";
	}
	if (!l.localOcr) return "Can't be read on this computer";
	if (l.localOcrPartial) return "Tone marks often lost on this computer";
	if (!l.localTranslation) return "No offline translation";
	return undefined;
}

/** Chosen languages only the language identifier can detect, while it isn't installed. */
export function waitingForIdentifier(
	chosen: readonly SourceLanguageChoice[],
	identifier: ModelRow | undefined,
): SourceLanguageChoice[] {
	if (!identifier || identifier.state.status === "installed") return [];
	return chosen.filter((l) => l.detectedBy === "fasttext");
}

/** "Indonesian", "Indonesian and Swahili", "Indonesian, Swahili and Uzbek". */
export function nameList(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The row's description above its Download button. */
export function identifierPrompt(waiting: readonly SourceLanguageChoice[]): string {
	const names = nameList(waiting.map((l) => l.name));
	const verb = waiting.length === 1 ? "isn't" : "aren't";
	return `${names} ${verb} recognised by the built-in detector. Until the language identifier is downloaded, Glimpse may skip text in ${waiting.length === 1 ? "it" : "them"}.`;
}
