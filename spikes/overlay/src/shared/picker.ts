// Region-picker state machine. Pure: takes global logical points and key
// events, returns the next state. The Bun main process owns one instance and
// broadcasts its state to every overlay window.
//
// In-picker keys follow docs/decisions/GLIM-23-default-hotkeys.md:
//   Esc cancel · Enter confirm · Arrows move 1 px (Shift: 10 px)
//   Alt/Option+Arrows resize 1 px (Alt+Shift: 10 px)

import { clampToDesktop, type DisplayInfo, type Point, type Rect, rectFromPoints } from "./geometry";

export type PickerPhase = "idle" | "dragging" | "adjusting" | "done" | "cancelled";

export interface PickerState {
	phase: PickerPhase;
	anchor: Point | null;
	cursor: Point | null;
	selection: Rect | null;
}

export interface PickerKey {
	key: string;
	shift: boolean;
	alt: boolean;
}

export interface PickerOptions {
	/** Spec behaviour: confirm as soon as the mouse is released. */
	confirmOnRelease: boolean;
	/** Ignore drags smaller than this (logical px) in either dimension. */
	minSize: number;
	/** Size of the box created when the user starts with the keyboard. */
	keyboardDefaultSize: { width: number; height: number };
}

export const DEFAULT_PICKER_OPTIONS: PickerOptions = {
	confirmOnRelease: true,
	minSize: 2,
	keyboardDefaultSize: { width: 240, height: 120 },
};

export function initialPickerState(): PickerState {
	return { phase: "idle", anchor: null, cursor: null, selection: null };
}

function isFinal(s: PickerState): boolean {
	return s.phase === "done" || s.phase === "cancelled";
}

export function pointerMove(s: PickerState, p: Point, displays: DisplayInfo[]): PickerState {
	if (isFinal(s)) return s;
	const cursor = clampToDesktop(displays, p);
	if (s.phase === "dragging" && s.anchor) {
		return { ...s, cursor, selection: rectFromPoints(s.anchor, cursor) };
	}
	return { ...s, cursor };
}

export function pointerDown(s: PickerState, p: Point, displays: DisplayInfo[]): PickerState {
	if (isFinal(s)) return s;
	const anchor = clampToDesktop(displays, p);
	return { phase: "dragging", anchor, cursor: anchor, selection: { x: anchor.x, y: anchor.y, width: 0, height: 0 } };
}

export function pointerUp(
	s: PickerState,
	p: Point,
	displays: DisplayInfo[],
	opts: PickerOptions = DEFAULT_PICKER_OPTIONS,
): PickerState {
	if (s.phase !== "dragging") return s;
	const moved = pointerMove(s, p, displays);
	const sel = moved.selection;
	if (!sel || sel.width < opts.minSize || sel.height < opts.minSize) {
		// A click without a drag: discard and keep picking.
		return { phase: "idle", anchor: null, cursor: moved.cursor, selection: null };
	}
	return { ...moved, anchor: null, phase: opts.confirmOnRelease ? "done" : "adjusting" };
}

export function keyDown(
	s: PickerState,
	k: PickerKey,
	displays: DisplayInfo[],
	opts: PickerOptions = DEFAULT_PICKER_OPTIONS,
): PickerState {
	if (isFinal(s)) return s;
	if (k.key === "Escape") return { ...s, phase: "cancelled" };
	if (k.key === "Enter") {
		if (s.selection && s.selection.width >= opts.minSize && s.selection.height >= opts.minSize) {
			return { ...s, phase: "done" };
		}
		return s;
	}
	const dir: Record<string, [number, number]> = {
		ArrowLeft: [-1, 0],
		ArrowRight: [1, 0],
		ArrowUp: [0, -1],
		ArrowDown: [0, 1],
	};
	const d = dir[k.key];
	if (!d || s.phase === "dragging") return s;
	const step = k.shift ? 10 : 1;
	let sel = s.selection;
	if (!sel) {
		const c = s.cursor ?? { x: 0, y: 0 };
		sel = { x: c.x, y: c.y, ...opts.keyboardDefaultSize };
	}
	if (k.alt) {
		sel = {
			x: sel.x,
			y: sel.y,
			width: Math.max(opts.minSize, sel.width + d[0] * step),
			height: Math.max(opts.minSize, sel.height + d[1] * step),
		};
	} else {
		const tl = clampToDesktop(displays, { x: sel.x + d[0] * step, y: sel.y + d[1] * step });
		sel = { ...sel, x: tl.x, y: tl.y };
	}
	return { phase: "adjusting", anchor: null, cursor: s.cursor, selection: sel };
}

/** Explicit cancel (e.g. an overlay window lost focus or was closed by the OS). */
export function cancel(s: PickerState): PickerState {
	return isFinal(s) ? s : { ...s, phase: "cancelled" };
}
