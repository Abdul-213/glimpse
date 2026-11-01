// GLIM-115: the boxes the results layer draws on screen under the Snip popup
// (snip-popup.md §2.3, region-picker.md §2 row L). Pure: the popup controller turns the
// pipeline's boxes (region-local device px) into global logical rects with a style per block
// class, and the picker overlays draw them.
import type { Rect } from "../geometry.ts";
import type { BlockClass } from "../pipeline/events.ts";

/** `solid`: translate and target-language blocks (and every box before classes are known). `dashed`: skipped, 60 %. */
export type ResultsBoxStyle = "solid" | "dashed";

export interface ResultsBox {
	readonly id: string;
	/** Global logical px. */
	readonly rect: Rect;
	readonly style: ResultsBoxStyle;
}

export interface ResultsLayerState {
	/** The Snip popup request the boxes belong to. */
	readonly requestId: string;
	readonly boxes: readonly ResultsBox[];
	/** The block hovered or focused in the popup: its box gets `box-linked-fill`. One at a time. */
	readonly linkedId: string | null;
}

/**
 * A box from the captured image (region-local device px) to global logical px. `scale` is
 * image px per logical unit (the capture's `scale`: image width / region width).
 */
export function boxToGlobal(region: Rect, scale: number, box: Rect): Rect {
	const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
	return {
		x: region.x + box.x / s,
		y: region.y + box.y / s,
		width: box.width / s,
		height: box.height / s,
	};
}

/** Style for a block class; neutral blocks get no box (§2.3). */
export function boxStyleFor(cls: BlockClass | null): ResultsBoxStyle | null {
	if (cls === "neutral") return null;
	return cls === "skip" ? "dashed" : "solid";
}

/**
 * The boxes for one Snip. `blocks` are the recognised blocks (with the popup's current class,
 * so a skipped block promoted by "Translate these" turns solid); before recognition, the
 * detected boxes with `cls: null` (all solid). Boxes are clipped to the region.
 */
export function resultsBoxes(
	region: Rect,
	scale: number,
	blocks: readonly { readonly id: string; readonly box: Rect; readonly cls: BlockClass | null }[],
): ResultsBox[] {
	const out: ResultsBox[] = [];
	for (const b of blocks) {
		const style = boxStyleFor(b.cls);
		if (!style) continue;
		const r = clip(boxToGlobal(region, scale, b.box), region);
		if (r) out.push({ id: b.id, rect: r, style });
	}
	return out;
}

function clip(r: Rect, to: Rect): Rect | null {
	const x = Math.max(r.x, to.x);
	const y = Math.max(r.y, to.y);
	const right = Math.min(r.x + r.width, to.x + to.width);
	const bottom = Math.min(r.y + r.height, to.y + to.height);
	return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
