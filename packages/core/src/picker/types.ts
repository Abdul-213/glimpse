// Region-picker vocabulary (docs/design/specs/region-picker.md 3, 9.4). Plain data only:
// these cross the RPC boundary to the overlay views and the event bus to Snip / Live.
import type { Rect } from "../geometry.ts";
import type { SelectionPiece } from "./geometry.ts";

export type PickerMode = "snip" | "live";

export type PickerPhase = "hidden" | "idle" | "dragging" | "adjusting" | "confirmed" | "cancelled";

/** Corner and edge-midpoint handles in `adjusting` (spec 2 E). Screen directions, never mirrored. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** How the confirmed rect was made (spec 9.4 `PickerConfirmed.source`). */
export type SelectionSource = "drag" | "window" | "keyboard" | "repin" | "snipAgain";

/** Why the picker closed without a selection. */
export type CancelReason =
	| "escape"
	| "right-click"
	/** The current mode's global hotkey toggles the picker off (spec 6). */
	| "hotkey"
	/** Another app took focus (spec 7.7): focus is NOT handed back. */
	| "focus-lost"
	/** The display set changed (spec 7.8). */
	| "display-change"
	/** Quit, a Snip popup replacing it, or any other caller. */
	| "external";

export interface Modifiers {
	readonly shift: boolean;
	readonly alt: boolean;
	readonly ctrl: boolean;
	readonly meta: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };

/** A snap guide line, global logical (spec 2 H). */
export interface Guide {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

/** What the hint bar says (spec 11 `picker.hint.*`). */
export type HintKey = "idle" | "dragging" | "adjusting" | "tooSmall" | "liveOneScreen";

/**
 * The event Snip (GLIM-65) and Live (GLIM-59) consume: the user picked an area. The rect
 * is device-pixel snapped on the display holding its top-left corner, and is exactly
 * what the overlay outlined.
 */
export interface RegionSelected {
	readonly mode: PickerMode;
	/** Global logical. */
	readonly rect: Rect;
	/** One piece per display the rect touches; capture works per piece across mixed DPI. */
	readonly pieces: readonly SelectionPiece[];
	readonly source: SelectionSource;
	/** The window that was clicked to select it, if any. */
	readonly window: { readonly appName: string; readonly pid: number } | null;
	/** Epoch ms of the confirming input. */
	readonly at: number;
}

export type PickerOutcome =
	| { readonly kind: "confirmed"; readonly region: RegionSelected }
	| { readonly kind: "cancelled"; readonly reason: CancelReason };
