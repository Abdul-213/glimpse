// GLIM-115: the boxes the results layer draws on screen under the Snip popup
// (snip-popup.md §2.3, region-picker.md §2 row L). Pure: the popup controller turns the
// pipeline's boxes (region-local device px) into global logical rects with a style per block
// class, and the picker overlays draw them.
//
// GLIM-152 adds numbered badges (one per boxed block, the same number as its popup block), the
// block picked from the screen (`selectedId`) and the on-screen overlay: opaque cards with each
// translation painted over its box (snip-popup.md §2.5).
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import { directionOf } from "../language/lookup.ts";
import type { TextDirection } from "../language/script.ts";
import type { BlockClass } from "../pipeline/events.ts";

/** `solid`: translate and target-language blocks (and every box before classes are known). `dashed`: skipped, 60 %. */
export type ResultsBoxStyle = "solid" | "dashed";

export interface ResultsBox {
	readonly id: string;
	/** Global logical px. */
	readonly rect: Rect;
	readonly style: ResultsBoxStyle;
	/** The block's number (GLIM-152), drawn as a badge on the box's top inline-start corner. */
	readonly badge?: number;
}

/** One translation painted over its box in overlay mode (GLIM-152). Its box has the same id. */
export interface ResultsCard {
	readonly id: string;
	readonly text: string;
	/** The translation's language (the target), for its script stack. */
	readonly lang: LanguageCode | null;
	readonly dir: TextDirection;
}

export interface ResultsOverlay {
	readonly cards: readonly ResultsCard[];
	/** Every card steps aside to show the source under it (held key, or original view). */
	readonly peek: boolean;
}

export interface ResultsLayerState {
	/** The Snip popup request the boxes belong to. */
	readonly requestId: string;
	readonly boxes: readonly ResultsBox[];
	/** The block hovered or focused in the popup: its box gets `box-linked-fill`. One at a time. */
	readonly linkedId: string | null;
	/** The block picked by clicking its box or badge (GLIM-152): its badge stays lit. */
	readonly selectedId?: string | null;
	/** Overlay mode (GLIM-152); null or absent: boxes only. */
	readonly overlay?: ResultsOverlay | null;
	/** Popup chrome direction: badges sit on the inline-start corner. */
	readonly uiDir?: "ltr" | "rtl";
	/** Glimpse's motion setting resolved (the overlay also honours the OS setting). */
	readonly reducedMotion?: boolean;
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
	blocks: readonly {
		readonly id: string;
		readonly box: Rect;
		readonly cls: BlockClass | null;
		readonly badge?: number;
	}[],
): ResultsBox[] {
	const out: ResultsBox[] = [];
	for (const b of blocks) {
		const style = boxStyleFor(b.cls);
		if (!style) continue;
		const r = clip(boxToGlobal(region, scale, b.box), region);
		if (r) out.push({ id: b.id, rect: r, style, ...(b.badge !== undefined ? { badge: b.badge } : {}) });
	}
	return out;
}

/**
 * The overlay's cards: every translate-class block with a final translation. Pending, failed
 * and waiting blocks keep their plain box (and badge) until there is something to paint.
 */
export function overlayCards(
	blocks: readonly {
		readonly id: string;
		readonly cls: BlockClass;
		readonly state: string;
		readonly translation: string | null;
	}[],
	target: LanguageCode | null,
): ResultsCard[] {
	const dir = target ? directionOf(target) : "ltr";
	return blocks.flatMap((b) =>
		b.cls === "translate" && b.state === "done" && b.translation
			? [{ id: b.id, text: b.translation, lang: target, dir }]
			: [],
	);
}

/** Largest and smallest overlay card text (px) before script scaling: the popup's translation size, and the floor. */
export const CARD_MAX_PX = 15;
export const CARD_MIN_PX = 11;
/** Widest a card may grow (px) to fit one long word in a narrow (vertical) box. */
export const CARD_MAX_WIDTH = 240;

/** Badge hit radius (px): a 20px badge plus a little slop. */
export const BADGE_HIT_RADIUS = 12;

/** Where a box's badge is centred: its top inline-start corner (global logical px). */
export function badgeAnchor(r: Rect, uiDir: "ltr" | "rtl" = "ltr"): { x: number; y: number } {
	return { x: uiDir === "rtl" ? r.x + r.width : r.x, y: r.y };
}

/**
 * The block under a point on the results layer (GLIM-152): a badge first (badges sit over box
 * corners), else the smallest box containing the point within `slop` px. Null: a click outside
 * every box, which dismisses the popup as before (snip-popup.md §5).
 */
export function hitResultsBox(
	state: Pick<ResultsLayerState, "boxes" | "uiDir">,
	p: { readonly x: number; readonly y: number },
	slop = 2,
): string | null {
	for (const b of state.boxes) {
		if (b.badge === undefined) continue;
		const a = badgeAnchor(b.rect, state.uiDir);
		if (Math.hypot(p.x - a.x, p.y - a.y) <= BADGE_HIT_RADIUS) return b.id;
	}
	let best: ResultsBox | null = null;
	for (const b of state.boxes) {
		const r = b.rect;
		const inside =
			p.x >= r.x - slop && p.x <= r.x + r.width + slop && p.y >= r.y - slop && p.y <= r.y + r.height + slop;
		if (inside && (!best || r.width * r.height < best.rect.width * best.rect.height)) best = b;
	}
	return best?.id ?? null;
}

function clip(r: Rect, to: Rect): Rect | null {
	const x = Math.max(r.x, to.x);
	const y = Math.max(r.y, to.y);
	const right = Math.min(r.x + r.width, to.x + to.width);
	const bottom = Math.min(r.y + r.height, to.y + to.height);
	return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
