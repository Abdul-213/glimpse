// The region-picker state machine (region-picker spec 3, 4, 5, 6). Pure: global logical
// input in, next state out. The main process owns one instance per open picker
// (PickerSession) and broadcasts what it derives (view.ts) to every overlay. Extended
// from spikes/overlay/src/shared/picker.ts and the interactive mockup
// (docs/design/specs/mockups/region-picker.html).
import { type Point, type Rect, rectFromPoints } from "../geometry.ts";
import type { Display } from "../region.ts";
import {
	clampToDesktop,
	clampToRect,
	desktopBounds,
	displayAt,
	selectionPieces,
	snapToDevicePixels,
} from "./geometry.ts";
import type { ScreenWindow } from "./ports.ts";
import { candidateAt, snapEdges, snapPoint } from "./snap.ts";
import type {
	CancelReason,
	Guide,
	Handle,
	Modifiers,
	PickerMode,
	PickerOutcome,
	PickerPhase,
	SelectionSource,
} from "./types.ts";
import { NO_MODIFIERS } from "./types.ts";

/** A press becomes a drag after this many logical px (spec 4). */
export const DRAG_THRESHOLD = 4;
/** Smallest selection on either side (spec 4). */
export const MIN_SELECTION = 8;
/** How long the "too small" hint shows (spec 8). */
export const TOO_SMALL_MS = 2000;
/** Keyboard default box (spec 4). */
export const KEYBOARD_BOX = { width: 240, height: 120 } as const;
/** Handle hit area is 20 x 20 centred on the handle (spec 2 E). */
export const HANDLE_HIT = 10;
/** Edge-midpoint handles hide below this edge length (spec 2 E). */
export const MID_HANDLE_MIN = 48;

export type PickerOs = "macos" | "windows" | "linux";

/** What the picker knows about the desktop for one open. */
export interface PickerEnv {
	readonly displays: readonly Display[];
	/** Front to back. Empty until the window list arrives (or if it never does). */
	readonly windows: readonly ScreenWindow[];
	readonly os: PickerOs;
	/** Settings › "Translate as soon as I release the mouse". Off: release lands in `adjusting`. */
	readonly confirmOnRelease: boolean;
}

interface Grab {
	readonly kind: "move" | Handle;
	readonly start: Rect;
	readonly at: Point;
}

export interface PickerState {
	readonly env: PickerEnv;
	readonly mode: PickerMode;
	readonly phase: PickerPhase;
	/** Last pointer position, clamped to the desktop. */
	readonly cursor: Point | null;
	/** Modifiers of the last input. */
	readonly mods: Modifiers;
	/** Raw (not device-pixel snapped) selection. */
	readonly selection: Rect | null;
	readonly source: SelectionSource | null;
	/** The window whose rect is the selection (click-to-select), else null. */
	readonly window: ScreenWindow | null;
	/** A press that hasn't moved past the drag threshold yet. */
	readonly press: { readonly raw: Point; readonly snapped: Point } | null;
	/** Dragging: the fixed corner. */
	readonly anchor: Point | null;
	/** Adjusting: a handle or the whole selection being dragged. */
	readonly grab: Grab | null;
	/** Dragging with Space held: where the pointer was at the last move. */
	readonly spaceAt: Point | null;
	readonly guides: readonly Guide[];
	/** Epoch ms until which the "too small" hint shows. */
	readonly tooSmallUntil: number;
	readonly outcome: PickerOutcome | null;
}

export type PickerEvent =
	| {
			readonly type: "pointer";
			readonly phase: "down" | "move" | "up";
			/** Global logical. */
			readonly p: Point;
			/** 0 primary, 2 secondary (DOM `button`). Ignored for moves. */
			readonly button: number;
			readonly mods: Modifiers;
			/** Click count (DOM `detail`): 2 on the second click of a double-click. */
			readonly detail: number;
			readonly t: number;
	  }
	| {
			readonly type: "key";
			/** DOM `KeyboardEvent.key`. */
			readonly key: string;
			readonly down: boolean;
			readonly mods: Modifiers;
			readonly t: number;
	  }
	| { readonly type: "toggle-mode" }
	| { readonly type: "set-mode"; readonly mode: PickerMode }
	| { readonly type: "windows"; readonly windows: readonly ScreenWindow[] }
	| { readonly type: "cancel"; readonly reason: CancelReason }
	/** Re-pin (Live) and Snip again (Snip errors) open straight into `adjusting` (spec 3). */
	| { readonly type: "preset"; readonly rect: Rect; readonly source: "repin" | "snipAgain" };

export function initialPickerState(env: PickerEnv, mode: PickerMode, cursor: Point | null): PickerState {
	return {
		env: { ...env, windows: sortByZ(env.windows) },
		mode,
		phase: "idle",
		cursor: cursor ? clampToDesktop(env.displays, cursor) : null,
		mods: NO_MODIFIERS,
		selection: null,
		source: null,
		window: null,
		press: null,
		anchor: null,
		grab: null,
		spaceAt: null,
		guides: [],
		tooSmallUntil: 0,
		outcome: null,
	};
}

const sortByZ = (w: readonly ScreenWindow[]) => [...w].sort((a, b) => a.z - b.z);
const isFinal = (s: PickerState) => s.phase === "confirmed" || s.phase === "cancelled" || s.phase === "hidden";
const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const inside = (r: Rect | null, p: Point | null): boolean =>
	!!r && !!p && p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);
const bigEnough = (r: Rect | null): r is Rect => !!r && r.width >= MIN_SELECTION && r.height >= MIN_SELECTION;

/** Snapping is off while Ctrl (Windows/Linux) or ⌘ (macOS) is held (spec 4). */
export const snappingOff = (os: PickerOs, mods: Modifiers): boolean => (os === "macos" ? mods.meta : mods.ctrl);

/** Handles shown for a selection (spec 2 E): corners always, midpoints on edges ≥ 48 px. */
export function handlesOf(r: Rect): { handle: Handle; x: number; y: number }[] {
	const cx = r.x + r.width / 2;
	const cy = r.y + r.height / 2;
	const out: { handle: Handle; x: number; y: number }[] = [
		{ handle: "nw", x: r.x, y: r.y },
		{ handle: "ne", x: right(r), y: r.y },
		{ handle: "se", x: right(r), y: bottom(r) },
		{ handle: "sw", x: r.x, y: bottom(r) },
	];
	if (r.width >= MID_HANDLE_MIN) out.push({ handle: "n", x: cx, y: r.y }, { handle: "s", x: cx, y: bottom(r) });
	if (r.height >= MID_HANDLE_MIN) out.push({ handle: "e", x: right(r), y: cy }, { handle: "w", x: r.x, y: cy });
	return out;
}

export function handleAt(r: Rect | null, p: Point): Handle | null {
	if (!r) return null;
	const hit = handlesOf(r).find((h) => Math.abs(h.x - p.x) <= HANDLE_HIT && Math.abs(h.y - p.y) <= HANDLE_HIT);
	return hit?.handle ?? null;
}

/** The region a point may move in: the desktop (Snip), or `display` (Live). */
function boundsFor(s: PickerState, display: Display | null): Rect | null {
	if (s.mode === "live" && display) return display.bounds;
	return desktopBounds(s.env.displays);
}

/** Move `r` by the least amount so it lies inside `bounds` (as far as it fits). */
function keepInside(r: Rect, bounds: Rect | null): Rect {
	if (!bounds) return r;
	const width = Math.min(r.width, bounds.width);
	const height = Math.min(r.height, bounds.height);
	const x = Math.min(Math.max(r.x, bounds.x), right(bounds) - width);
	const y = Math.min(Math.max(r.y, bounds.y), bottom(bounds) - height);
	return { x, y, width, height };
}

/** Clamp a moving point: to the desktop; in Live, to the display holding `home` (spec 4 "Live: one display"). */
function constrain(s: PickerState, p: Point, home: Point | null): Point {
	const onDesktop = clampToDesktop(s.env.displays, p);
	if (s.mode !== "live" || !home) return onDesktop;
	const d = displayAt(s.env.displays, home);
	return d ? clampToRect(d.bounds, onDesktop) : onDesktop;
}

function snapped(s: PickerState, p: Point, mods: Modifiers): { p: Point; guides: readonly Guide[] } {
	if (snappingOff(s.env.os, mods)) return { p, guides: [] };
	return snapPoint(p, snapEdges(s.env.windows, s.env.displays, p));
}

function confirm(s: PickerState, source: SelectionSource, t: number): PickerState {
	const sel = s.selection;
	if (!bigEnough(sel)) return s;
	const d = displayAt(s.env.displays, { x: sel.x, y: sel.y });
	const rect = d ? snapToDevicePixels(sel, d) : sel;
	const window = s.window ? { appName: s.window.appName, pid: s.window.pid } : null;
	return {
		...s,
		phase: "confirmed",
		selection: rect,
		source,
		press: null,
		anchor: null,
		grab: null,
		spaceAt: null,
		guides: [],
		outcome: {
			kind: "confirmed",
			region: { mode: s.mode, rect, pieces: selectionPieces(rect, s.env.displays), source, window, at: t },
		},
	};
}

export function cancelPicker(s: PickerState, reason: CancelReason): PickerState {
	if (isFinal(s)) return s;
	return {
		...s,
		phase: "cancelled",
		press: null,
		anchor: null,
		grab: null,
		guides: [],
		outcome: { kind: "cancelled", reason },
	};
}

/** Select the snap candidate under the cursor. */
function selectCandidate(s: PickerState): PickerState | null {
	if (!s.cursor) return null;
	const c = candidateAt(s.env.windows, s.env.displays, s.cursor, s.mode);
	if (!c) return null;
	return { ...s, selection: c.rect, window: c.window, source: "window" };
}

function dragTo(s: PickerState, p: Point, mods: Modifiers): PickerState {
	if (!s.anchor) return s;
	let anchor = s.anchor;
	let spaceAt = s.spaceAt;
	if (spaceAt) {
		// Space held: the whole selection follows the pointer (macOS screenshot convention).
		const dx = p.x - spaceAt.x;
		const dy = p.y - spaceAt.y;
		anchor = constrain(s, { x: anchor.x + dx, y: anchor.y + dy }, anchor);
		spaceAt = p;
	}
	const target = constrain(s, p, anchor);
	const sp = spaceAt ? { p: target, guides: [] } : snapped(s, target, mods);
	return { ...s, anchor, spaceAt, selection: rectFromPoints(anchor, sp.p), guides: sp.guides };
}

function grabTo(s: PickerState, g: Grab, p: Point, mods: Modifiers): PickerState {
	const home = displayAt(s.env.displays, { x: g.start.x, y: g.start.y });
	if (g.kind === "move") {
		const moved = { ...g.start, x: g.start.x + p.x - g.at.x, y: g.start.y + p.y - g.at.y };
		return { ...s, selection: keepInside(moved, boundsFor(s, home)), guides: [] };
	}
	const target = constrain(s, p, home ? { x: home.bounds.x, y: home.bounds.y } : null);
	const sp = snapped(s, target, mods);
	let x1 = g.start.x;
	let y1 = g.start.y;
	let x2 = right(g.start);
	let y2 = bottom(g.start);
	if (g.kind.includes("w")) x1 = sp.p.x;
	if (g.kind.includes("e")) x2 = sp.p.x;
	if (g.kind.includes("n")) y1 = sp.p.y;
	if (g.kind.includes("s")) y2 = sp.p.y;
	// Crossing over flips the rect normally; there is no inverted state (spec 5).
	return { ...s, selection: rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 }), guides: sp.guides };
}

function pointer(s: PickerState, e: Extract<PickerEvent, { type: "pointer" }>): PickerState {
	const p = clampToDesktop(s.env.displays, e.p);
	if (e.phase === "down") {
		if (e.button === 2) return cancelPicker(s, "right-click");
		if (e.button !== 0) return s;
		const base = { ...s, cursor: p, mods: e.mods };
		if (s.phase === "adjusting" && s.selection) {
			const handle = handleAt(s.selection, p);
			if (handle) return { ...base, grab: { kind: handle, start: s.selection, at: p } };
			if (inside(s.selection, p)) return { ...base, grab: { kind: "move", start: s.selection, at: p } };
		}
		if (s.phase !== "idle" && s.phase !== "adjusting") return base;
		// The anchor snaps at press time (spec 4).
		return { ...base, press: { raw: p, snapped: snapped(s, p, e.mods).p } };
	}

	if (e.phase === "move") {
		let next: PickerState = { ...s, cursor: p, mods: e.mods };
		if (s.grab) return grabTo(next, s.grab, p, e.mods);
		if (s.press && s.phase !== "dragging") {
			const moved = Math.hypot(p.x - s.press.raw.x, p.y - s.press.raw.y);
			if (moved < DRAG_THRESHOLD) return next;
			next = { ...next, phase: "dragging", anchor: s.press.snapped, press: null, window: null, source: null };
		}
		if (next.phase === "dragging") return dragTo(next, p, e.mods);
		return next.guides.length > 0 ? { ...next, guides: [] } : next;
	}

	// up
	if (e.button !== 0) return s;
	if (s.grab) {
		const wasMove = s.grab.kind === "move";
		const released = { ...grabTo({ ...s, cursor: p, mods: e.mods }, s.grab, p, e.mods), grab: null, guides: [] };
		// Double-click inside the selection confirms (spec 5).
		if (wasMove && e.detail >= 2 && inside(released.selection, p)) {
			return confirm(released, released.source ?? "drag", e.t);
		}
		return released;
	}
	if (s.phase === "dragging") {
		const done = { ...dragTo({ ...s, cursor: p, mods: e.mods }, p, e.mods), anchor: null, spaceAt: null, guides: [] };
		if (!bigEnough(done.selection)) {
			return { ...done, phase: "idle", selection: null, source: null, tooSmallUntil: e.t + TOO_SMALL_MS };
		}
		if (e.mods.shift || !s.env.confirmOnRelease) return { ...done, phase: "adjusting", source: "drag" };
		return confirm({ ...done, source: "drag" }, "drag", e.t);
	}
	if (s.press) {
		// A click (moved < 4 px): select the snap candidate (spec 5).
		const clicked = selectCandidate({ ...s, cursor: p, mods: e.mods, press: null });
		if (!clicked) return { ...s, press: null };
		if (s.phase === "adjusting" || e.mods.shift) return { ...clicked, phase: "adjusting" };
		return confirm(clicked, "window", e.t);
	}
	return { ...s, cursor: p, mods: e.mods };
}

const ARROWS: Record<string, readonly [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

function keyboardBox(s: PickerState): Rect | null {
	const c = s.cursor ?? (s.env.displays[0] ? centre(s.env.displays[0].bounds) : null);
	if (!c) return null;
	const d = displayAt(s.env.displays, c);
	const box = { x: c.x - KEYBOARD_BOX.width / 2, y: c.y - KEYBOARD_BOX.height / 2, ...KEYBOARD_BOX };
	return keepInside(box, d?.bounds ?? null);
}

const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

function key(s: PickerState, e: Extract<PickerEvent, { type: "key" }>): PickerState {
	const base = { ...s, mods: e.mods };
	if (e.key === " " || e.key === "Spacebar") {
		if (!e.down) return { ...base, spaceAt: null };
		return s.phase === "dragging" && !s.spaceAt ? { ...base, spaceAt: s.cursor } : base;
	}
	if (!e.down) return base;
	if (e.key === "Escape") return cancelPicker(s, "escape");
	if (e.key === "Tab") return setMode(base, s.mode === "snip" ? "live" : "snip");
	if (e.key === "Enter") {
		if (s.phase === "adjusting") return confirm(base, s.source ?? "keyboard", e.t);
		if (s.phase === "idle") {
			const picked = selectCandidate(base);
			return picked ? confirm(picked, "window", e.t) : base;
		}
		return base;
	}
	const dir = ARROWS[e.key];
	if (!dir || s.phase === "dragging" || s.grab) return base;
	if (s.phase === "idle" || !s.selection) {
		const box = keyboardBox(base);
		return box ? { ...base, phase: "adjusting", selection: box, source: "keyboard", window: null, press: null } : base;
	}
	const step = e.mods.shift ? 10 : 1;
	const sel = s.selection;
	const home = displayAt(s.env.displays, { x: sel.x, y: sel.y });
	const bounds = boundsFor(s, home);
	if (e.mods.alt) {
		// Resize: Right/Down grow, Left/Up shrink; the top-left corner stays put (spec 6).
		let width = Math.max(MIN_SELECTION, sel.width + dir[0] * step);
		let height = Math.max(MIN_SELECTION, sel.height + dir[1] * step);
		if (bounds) {
			width = Math.min(width, right(bounds) - sel.x);
			height = Math.min(height, bottom(bounds) - sel.y);
		}
		return { ...base, selection: { ...sel, width, height }, window: null };
	}
	const moved = { ...sel, x: sel.x + dir[0] * step, y: sel.y + dir[1] * step };
	return { ...base, selection: keepInside(moved, bounds), window: null };
}

function setMode(s: PickerState, mode: PickerMode): PickerState {
	if (mode === s.mode) return s;
	let next: PickerState = { ...s, mode };
	// A Live selection lives on one display: switching keeps the part on the display of
	// its top-left corner.
	if (mode === "live" && s.selection) {
		const d = displayAt(s.env.displays, { x: s.selection.x, y: s.selection.y });
		const clipped = d ? keepInside(s.selection, d.bounds) : s.selection;
		next = { ...next, selection: clipped };
	}
	return next;
}

/** The next state. Final states (confirmed, cancelled) ignore everything. */
export function reducePicker(s: PickerState, e: PickerEvent): PickerState {
	if (isFinal(s)) return s;
	switch (e.type) {
		case "pointer":
			return pointer(s, e);
		case "key":
			return key(s, e);
		case "toggle-mode":
			return setMode(s, s.mode === "snip" ? "live" : "snip");
		case "set-mode":
			return setMode(s, e.mode);
		case "windows":
			return { ...s, env: { ...s.env, windows: sortByZ(e.windows) } };
		case "cancel":
			return cancelPicker(s, e.reason);
		case "preset": {
			const d = displayAt(s.env.displays, { x: e.rect.x, y: e.rect.y });
			const rect = keepInside(e.rect, s.mode === "live" && d ? d.bounds : desktopBounds(s.env.displays));
			return { ...s, phase: "adjusting", selection: rect, source: e.source, window: null };
		}
	}
}
