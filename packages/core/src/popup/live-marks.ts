// GLIM-154: what Live draws over the pinned region (live-popup.md §2.4, §2.6): a numbered
// badge on each block's box (the same number as its popup block) and, in overlay mode, an
// opaque card with the translation over its box. Pure: the Live view rasterises these
// (`app/src/views/live/marks.ts`, with core `fitText`) and the native frame window paints the
// bitmaps; tests run on Linux.
//
// Live rules on top of Snip's (snip-popup.md §2.3, §2.5):
// - Badges only when the region has two or more numbered blocks: one subtitle line needs no
//   matching, and a "1" on every subtitle would be churn over the video.
// - A card shows what the popup shows: the old translation while a changed block is held
//   (600 ms), nothing while its new source is pending (the source on screen shows through),
//   the new translation once it lands. Failed, waiting-for-pack, skipped, neutral and
//   target-language blocks get no card.
// - Cards in the latest change set carry the change mark and the resting change tint (no
//   flash on screen: the frame never animates).
// - Paused / stale: badges and cards stay, at 60 % like the ticks.
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import { directionOf } from "../language/lookup.ts";
import type { TextDirection } from "../language/script.ts";
import { type LivePopupState, liveShowsEmpty } from "./live-state.ts";
import { resultsBoxes } from "./results-layer.ts";

/** A badge on the pinned region. `rect` is its block's box (global logical); the badge sits on its top inline-start corner. */
export interface LiveMarkBadge {
	readonly id: string;
	readonly n: number;
	readonly rect: Rect;
	/** Skipped blocks: 60 %, like their dashed box in Snip. */
	readonly dashed: boolean;
	/** Linked (popup hover / focus, pointer on screen) or picked: accent. */
	readonly lit: boolean;
}

/** A translation card over its box (global logical) in overlay mode. */
export interface LiveMarkCard {
	readonly id: string;
	readonly rect: Rect;
	readonly text: string;
	readonly lang: LanguageCode | null;
	readonly dir: TextDirection;
	readonly lit: boolean;
	/** In the latest change set: change mark + resting change tint. */
	readonly changed: boolean;
}

export interface LiveMarks {
	readonly badges: readonly LiveMarkBadge[];
	readonly cards: readonly LiveMarkCard[];
	/** Paused or stale: everything at 60 %. */
	readonly stale: boolean;
}

export const NO_LIVE_MARKS: LiveMarks = { badges: [], cards: [], stale: false };

/** How far outside the region marks may reach (the frame window's margin, frame-layout.ts). */
export const LIVE_MARKS_MARGIN = 16;
/** Opacity of marks while Live is paused or stale (the ticks' 60 %). */
export const LIVE_MARKS_STALE_OPACITY = 0.6;
/** Opacity of a peeked card (original view, or the pointer over it): the source shows through. */
export const LIVE_CARD_PEEK_OPACITY = 0.08;

export interface LiveMarksOptions {
	/** The block hovered or focused in the popup. */
	readonly linkedId?: string | null;
	/** Overlay cards are wanted (the state's `overlay`, unless the view overrides it). */
	readonly overlay?: boolean;
	/** The translations' language (the session's target), for the cards' script and direction. */
	readonly target?: LanguageCode | null;
}

/** The marks for a Live state; empty when nothing is pinned, consent is pending, or the region is empty. */
export function liveMarks(state: LivePopupState, options: LiveMarksOptions = {}): LiveMarks {
	const { region, image } = state;
	if (state.sessionId === null || !region || !image || image.width <= 0) return NO_LIVE_MARKS;
	if (state.status === "consent" || state.status === "closed" || state.status === "stopped") return NO_LIVE_MARKS;
	if (liveShowsEmpty(state)) return NO_LIVE_MARKS;
	const scale = image.width / region.width;
	const lit = (id: string) =>
		id === options.linkedId || id === state.screenLinked || (state.selected !== null && id === state.selected.id);
	const numbered = state.blocks.filter((b) => b.badge !== undefined);
	const boxes = resultsBoxes(
		region,
		scale,
		state.blocks.map((b) => ({
			id: b.id,
			box: b.box,
			cls: b.cls,
			...(b.badge === undefined ? {} : { badge: b.badge }),
		})),
	);
	const boxOf = new Map(boxes.map((b) => [b.id, b]));
	const badges: LiveMarkBadge[] =
		numbered.length < 2
			? []
			: boxes.flatMap((b) =>
					b.badge === undefined
						? []
						: [{ id: b.id, n: b.badge, rect: b.rect, dashed: b.style === "dashed", lit: lit(b.id) }],
				);
	const overlay = options.overlay ?? state.overlay;
	const dir: TextDirection = options.target ? directionOf(options.target) : "ltr";
	const cards: LiveMarkCard[] = overlay
		? state.blocks.flatMap((b) => {
				const box = boxOf.get(b.id);
				if (!box || b.cls !== "translate" || b.pending || b.failed || b.waitingForPack) return [];
				if (b.translation === null || b.translation.trim() === "") return [];
				return [
					{
						id: b.id,
						rect: box.rect,
						text: b.translation,
						lang: options.target ?? null,
						dir,
						lit: lit(b.id),
						changed: b.changeId !== null && b.changeId === state.changeSeq,
					},
				];
			})
		: [];
	return { badges, cards, stale: state.stale };
}
