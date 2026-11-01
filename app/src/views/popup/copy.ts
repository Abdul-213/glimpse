// Snip popup copy (snip-popup.md §12). English for now; every string the popup shows
// comes from here, so the i18n layer can replace this table without touching components.
import type { SnipStatus } from "@glimpse/core";
import { languageName } from "@glimpse/ui";

export const COPY = {
	dialog: "Translation",
	list: "Translated text",
	reading: "Reading text",
	local: "On device",
	localTooltip: "Text was read and translated on this device. Nothing was sent.",
	private: "Private",
	privateTooltip: "Private is on. Nothing from this Snip is remembered.",
	close: "Close",
	actions: "Translation actions",
	failed: "Not translated",
	retry: "Retry",
	translateThese: "Translate these",
	editSources: "Edit source languages…",
} as const;

export const translatingText = (done: number, total: number) => `Translating ${done} of ${total}`;
export const partialText = (done: number, total: number) => `Translated ${done} of ${total}`;
export const alreadyIn = (target: string, uiLang: string) => `Already in ${languageName(target, uiLang)}`;

/** The visible footer status (§2.4). */
export function statusText(s: SnipStatus): string {
	switch (s.kind) {
		case "none":
			return "";
		case "reading":
			return COPY.reading;
		case "translating":
			return translatingText(s.done, s.total);
		case "partial":
			return partialText(s.done, s.total);
	}
}

/**
 * What the status region announces (§10): only "Reading text", "Translating" and the
 * final line, never each block.
 */
export function announcement(s: SnipStatus, translated: number, finished: boolean): string {
	if (s.kind === "reading") return COPY.reading;
	if (s.kind === "translating") return "Translating";
	if (!finished || translated === 0) return "";
	return `Translated ${translated} ${translated === 1 ? "block" : "blocks"}.`;
}
