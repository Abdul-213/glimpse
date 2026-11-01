// What the Snip popup puts on the clipboard (snip-popup.md §6). Pure.
//
// - Translation: blocks in reading order, one per line, as displayed in the translation
//   view: translations, neutral blocks, target-language blocks, and the source text of
//   failed (or still waiting) blocks. Skipped blocks are left out unless "Translate these"
//   promoted them.
// - Original: every non-skipped block's OCR text, reading order.
// - Plain text. Line breaks inside a block are kept; every break uses the OS's EOL
//   (`\r\n` on Windows). Text is copied as recognised, in logical order: no bidi marks are
//   added, so RTL text pastes the way it reads.
import type { SnipBlock, SnipPopupState } from "./snip-state.ts";

export type ClipboardWhat = "translation" | "original";
export type Eol = "\n" | "\r\n";

const blockText = (b: SnipBlock, what: ClipboardWhat): string | null => {
	if (b.cls === "skip") return null;
	if (what === "original") return b.source;
	if (b.cls === "translate") return b.state === "done" && b.translation !== null ? b.translation : b.source;
	return b.source;
};

/** The clipboard text for `what`, or "" when there is nothing to copy. */
export function clipboardText(state: Pick<SnipPopupState, "blocks">, what: ClipboardWhat, eol: Eol = "\n"): string {
	const lines: string[] = [];
	for (const b of [...state.blocks].sort((x, y) => x.order - y.order)) {
		const text = blockText(b, what);
		if (text === null) continue;
		const clean = text.replace(/\r\n?/g, "\n").trim();
		if (clean.length > 0) lines.push(clean);
	}
	return lines.join("\n").replace(/\n/g, eol);
}

/** Translate-class blocks that ended up translated. */
export const translatedCount = (state: Pick<SnipPopupState, "blocks">): number =>
	state.blocks.filter((b) => b.cls === "translate" && b.state === "done").length;
