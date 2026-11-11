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

/**
 * GLIM-154: numbers for a Live region, kept stable across updates. A block that is still
 * there keeps its number; new blocks take the smallest free numbers, in reading order. So a
 * bubble that stays on screen is "3" for as long as it stays, and once every block has been
 * replaced (a page turn) the numbers start again at 1. Neutral blocks get none.
 */
export function liveBlockNumbers(
	prev: ReadonlyMap<string, number>,
	blocks: readonly { readonly id: string; readonly cls: BlockClass }[],
): ReadonlyMap<string, number> {
	const kept = new Map<string, number>();
	const used = new Set<number>();
	for (const b of blocks) {
		const n = prev.get(b.id);
		if (b.cls === "neutral" || n === undefined || used.has(n)) continue;
		kept.set(b.id, n);
		used.add(n);
	}
	const out = new Map<string, number>();
	let next = 1;
	for (const b of blocks) {
		if (b.cls === "neutral") continue;
		let n = kept.get(b.id);
		if (n === undefined) {
			while (used.has(next)) next++;
			n = next;
			used.add(n);
		}
		out.set(b.id, n);
	}
	return out;
}
