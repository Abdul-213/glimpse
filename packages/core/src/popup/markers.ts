// GLIM-152: numbered markers. Every block that has a box on screen (translate, target-language
// and skipped blocks; neutral blocks have no box) gets a number in reading order, shown as a
// badge on its box and beside its block in the popup, so a reader can tell which translation
// belongs to which speech bubble. Pure.
//
// Numbers are given from recognition on and never change for the request: a skipped block
// promoted by "Translate these" keeps the number it already had, so nothing renumbers under
// the reader's eyes.
import type { BlockClass } from "../pipeline/events.ts";

/** Block id → its number (1-based), for blocks in reading order. Neutral blocks get none. */
export function blockNumbers(
	blocks: readonly { readonly id: string; readonly cls: BlockClass }[],
): ReadonlyMap<string, number> {
	const out = new Map<string, number>();
	for (const b of blocks) if (b.cls !== "neutral") out.set(b.id, out.size + 1);
	return out;
}

/** The badge's text: the number, in the UI locale's digits ("١٢" in Arabic). */
export function badgeLabel(n: number, locale?: string): string {
	try {
		return new Intl.NumberFormat(locale, { useGrouping: false }).format(n);
	} catch {
		return String(n);
	}
}
