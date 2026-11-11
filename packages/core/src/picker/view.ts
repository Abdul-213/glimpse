// What every overlay view draws, derived from the machine state (region-picker spec 2,
// 3, 9.4 `PickerState`). Plain JSON: the main process sends it over RPC as is. Each view
// draws the parts on its own display.
import type { Point, Rect, Size } from "../geometry.ts";
import { displayAt, snapToDevicePixels } from "./geometry.ts";
import {
	estimateReadoutWidth,
	HINT_MARGIN,
	type HintPlacement,
	hintPlacement,
	hintRect,
	loupePosition,
	READOUT_HEIGHT,
	readoutPosition,
	type UiDir,
} from "./hud-layout.ts";
import { handleAt, type PickerState } from "./machine.ts";
import { candidateAt } from "./snap.ts";
import type { Guide, Handle, HintKey, PickerMode, PickerPhase } from "./types.ts";

/** CSS cursor names the view applies (spec 2, last paragraph). */
export type PickerCursor = "crosshair" | "move" | "default" | "nwse-resize" | "nesw-resize" | "ns-resize" | "ew-resize";

export interface PickerViewState {
	readonly seq: number;
	readonly mode: PickerMode;
	readonly phase: PickerPhase;
	/** Device-pixel snapped, exactly what will be captured. Null when there is none. */
	readonly selection: Rect | null;
	/** Snap candidate (idle). The label is the readout text. */
	readonly candidate: { readonly rect: Rect; readonly label: string } | null;
	readonly guides: readonly Guide[];
	readonly cursor: Point | null;
	/** The display under the pointer: it draws the crosshair, loupe and hint bar. */
	readonly pointerDisplayId: number | null;
	readonly crosshair: boolean;
	/** Top-left of the loupe chip, or null when the loupe is hidden. */
	readonly loupe: { readonly at: Point; readonly displayId: number } | null;
	readonly readout: { readonly text: string; readonly at: Point; readonly displayId: number } | null;
	readonly hint: {
		readonly key: HintKey;
		readonly displayId: number;
		readonly placement: HintPlacement;
		/** The bar's rect for that placement (global logical), for hit-testing and drawing. */
		readonly rect: Rect;
		/** The widest the bar may be (work area − 32); longer copy falls back to the short form. */
		readonly maxWidth: number;
		/** Egress notice text (spec 11 `picker.egress.*`), or null for a local pipeline. */
		readonly egress: string | null;
		readonly replacesLive: boolean;
	} | null;
	readonly handles: boolean;
	readonly cursorStyle: PickerCursor;
	/** False once a Snip is confirmed: the scrim goes and the selection edge stays (results layer). */
	readonly scrim: boolean;
}

export interface ViewOptions {
	readonly seq: number;
	readonly now: number;
	readonly dir?: UiDir;
	/** Settings › Show magnifier. */
	readonly showLoupe?: boolean;
	/** Measured hint bar size per display (the view reports it); estimated until then. */
	readonly hintSize?: Size;
	/** Measured readout chip size for its current text, if the view reported one. */
	readonly readoutSize?: { readonly text: string; readonly size: Size } | null;
	/** Hint bar placement last frame, for hysteresis. */
	readonly lastPlacement?: HintPlacement;
	readonly egress?: string | null;
	/** A Live session is running, so confirming in Live mode replaces it (spec 2 K). */
	readonly liveRunning?: boolean;
	/** The pointer is over the hint bar (view-reported): no crosshair there. */
	readonly overHint?: boolean;
}

export const DEFAULT_HINT_SIZE: Size = { width: 560, height: 28 };

const fmt = (n: number) => String(Math.round(n));
/** Readout text (spec 11 `picker.readout.*`). Logical px, also across mixed DPI (spec 4.1). */
export function readoutText(rect: Rect, appName?: string | null, screen = false): string {
	const size = `${fmt(rect.width)} × ${fmt(rect.height)}`;
	if (appName) return `${appName} · ${size}`;
	return screen ? `Screen · ${size}` : size;
}

const RESIZE: Record<Handle, PickerCursor> = {
	nw: "nwse-resize",
	se: "nwse-resize",
	ne: "nesw-resize",
	sw: "nesw-resize",
	n: "ns-resize",
	s: "ns-resize",
	e: "ew-resize",
	w: "ew-resize",
};

function hintKey(s: PickerState, now: number): HintKey {
	if (now < s.tooSmallUntil && s.phase === "idle") return "tooSmall";
	if (s.mode === "live" && s.phase === "dragging" && s.anchor && s.cursor) {
		const home = displayAt(s.env.displays, s.anchor);
		const here = displayAt(s.env.displays, s.cursor);
		if (home && here && home.id !== here.id) return "liveOneScreen";
	}
	if (s.phase === "dragging") return "dragging";
	if (s.phase === "adjusting") return "adjusting";
	return "idle";
}

/** Derive the broadcast view state. Pure; `now` only drives the "too small" hint. */
export function pickerView(s: PickerState, o: ViewOptions): PickerViewState {
	const displays = s.env.displays;
	const cursor = s.cursor;
	const here = cursor ? displayAt(displays, cursor) : null;
	const live = s.phase === "idle" || s.phase === "dragging" || s.phase === "adjusting";

	const selDisplay = s.selection ? displayAt(displays, { x: s.selection.x, y: s.selection.y }) : null;
	const selection = s.selection && selDisplay ? snapToDevicePixels(s.selection, selDisplay) : s.selection;

	const cand = s.phase === "idle" && cursor && !s.press ? candidateAt(s.env.windows, displays, cursor, s.mode) : null;
	const candidate = cand
		? { rect: cand.rect, label: readoutText(cand.rect, cand.window?.appName, cand.window === null) }
		: null;

	const handleDrag = !!s.grab && s.grab.kind !== "move";
	const overHandle = s.phase === "adjusting" && !s.grab && cursor ? handleAt(selection, cursor) : null;
	const crosshair =
		live && !!cursor && !o.overHint && !overHandle && (s.phase === "idle" || s.phase === "dragging" || handleDrag);
	const loupe = (o.showLoupe ?? true) && crosshair && cursor && here ? loupePosition(cursor, here) : null;

	let readout: PickerViewState["readout"] = null;
	const readoutRect = selection ?? candidate?.rect ?? null;
	if (live && readoutRect) {
		const text = selection ? readoutText(selection) : (candidate?.label ?? "");
		const measured = o.readoutSize && o.readoutSize.text === text ? o.readoutSize.size : null;
		const chip = measured ?? { width: estimateReadoutWidth(text), height: READOUT_HEIGHT };
		const place = readoutPosition(readoutRect, chip, displays, o.dir ?? "ltr");
		if (place) readout = { text, at: place.at, displayId: place.displayId };
	}

	let hint: PickerViewState["hint"] = null;
	if (live && here) {
		const bar = o.hintSize ?? DEFAULT_HINT_SIZE;
		// The pointer pushes the bar away only while it is drawing or resizing; in idle it can
		// reach the bar's mode switch (spec 4 says "pointer or selection"; see GLIM-44 PR).
		const pushing = s.phase === "dragging" || handleDrag;
		const placement = hintPlacement(here.workArea, bar, pushing ? cursor : null, selection, o.lastPlacement);
		hint = {
			key: hintKey(s, o.now),
			displayId: here.id,
			placement,
			rect: hintRect(here.workArea, bar, placement),
			maxWidth: Math.max(0, here.workArea.width - 2 * HINT_MARGIN),
			egress: o.egress ?? null,
			replacesLive: s.mode === "live" && !!o.liveRunning,
		};
	}

	let cursorStyle: PickerCursor = "crosshair";
	if (!live) cursorStyle = "default";
	else if (o.overHint) cursorStyle = "default";
	else if (s.grab) cursorStyle = s.grab.kind === "move" ? "move" : RESIZE[s.grab.kind];
	else if (overHandle) cursorStyle = RESIZE[overHandle];
	else if (s.phase === "adjusting" && selection && cursor && inside(selection, cursor)) cursorStyle = "move";

	return {
		seq: o.seq,
		mode: s.mode,
		phase: s.phase,
		selection,
		candidate,
		guides: s.guides,
		cursor,
		pointerDisplayId: here?.id ?? null,
		crosshair,
		loupe,
		readout,
		hint,
		handles: s.phase === "adjusting" && !!selection,
		cursorStyle,
		scrim: !(s.phase === "confirmed" && s.mode === "snip"),
	};
}

const inside = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
