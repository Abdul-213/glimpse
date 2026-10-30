import { describe, expect, test } from "bun:test";
import type { DisplayInfo } from "../src/shared/geometry";
import { DEFAULT_PICKER_OPTIONS, initialPickerState, keyDown, pointerDown, pointerMove, pointerUp } from "../src/shared/picker";

const displays: DisplayInfo[] = [
	{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 }, scaleFactor: 2, isPrimary: true, physicalBounds: null },
];
const k = (key: string, shift = false, alt = false) => ({ key, shift, alt });

describe("picker state machine", () => {
	test("drag then release confirms (spec default)", () => {
		let s = initialPickerState();
		s = pointerDown(s, { x: 100, y: 100 }, displays);
		expect(s.phase).toBe("dragging");
		s = pointerMove(s, { x: 50, y: 300 }, displays);
		expect(s.selection).toEqual({ x: 50, y: 100, width: 50, height: 200 });
		s = pointerUp(s, { x: 40, y: 310 }, displays);
		expect(s.phase).toBe("done");
		expect(s.selection).toEqual({ x: 40, y: 100, width: 60, height: 210 });
	});
	test("click without drag is ignored and picking continues", () => {
		let s = pointerDown(initialPickerState(), { x: 10, y: 10 }, displays);
		s = pointerUp(s, { x: 11, y: 10 }, displays);
		expect(s.phase).toBe("idle");
		expect(s.selection).toBeNull();
	});
	test("Esc cancels from any non-final phase", () => {
		expect(keyDown(initialPickerState(), k("Escape"), displays).phase).toBe("cancelled");
		const dragging = pointerDown(initialPickerState(), { x: 1, y: 1 }, displays);
		expect(keyDown(dragging, k("Escape"), displays).phase).toBe("cancelled");
	});
	test("drags are clamped to the desktop", () => {
		let s = pointerDown(initialPickerState(), { x: 900, y: 700 }, displays);
		s = pointerMove(s, { x: 5000, y: 5000 }, displays);
		expect(s.selection).toEqual({ x: 900, y: 700, width: 100, height: 100 });
	});
	test("confirmOnRelease=false leaves an adjustable selection; arrows move/resize; Enter confirms", () => {
		const opts = { ...DEFAULT_PICKER_OPTIONS, confirmOnRelease: false };
		let s = pointerDown(initialPickerState(), { x: 100, y: 100 }, displays);
		s = pointerUp(s, { x: 200, y: 150 }, displays, opts);
		expect(s.phase).toBe("adjusting");
		s = keyDown(s, k("ArrowRight"), displays, opts);
		s = keyDown(s, k("ArrowDown", true), displays, opts);
		expect(s.selection).toEqual({ x: 101, y: 110, width: 100, height: 50 });
		s = keyDown(s, k("ArrowRight", true, true), displays, opts);
		s = keyDown(s, k("ArrowUp", false, true), displays, opts);
		expect(s.selection).toEqual({ x: 101, y: 110, width: 110, height: 49 });
		s = keyDown(s, k("Enter"), displays, opts);
		expect(s.phase).toBe("done");
	});
	test("keyboard-only: arrow creates a default box at the cursor, Enter confirms", () => {
		let s = pointerMove(initialPickerState(), { x: 300, y: 300 }, displays);
		expect(keyDown(s, k("Enter"), displays).phase).toBe("idle");
		s = keyDown(s, k("ArrowLeft"), displays);
		expect(s.phase).toBe("adjusting");
		expect(s.selection).toEqual({ x: 299, y: 300, width: 240, height: 120 });
		expect(keyDown(s, k("Enter"), displays).phase).toBe("done");
	});
	test("final states are sticky", () => {
		const done = { ...initialPickerState(), phase: "done" as const };
		expect(pointerDown(done, { x: 1, y: 1 }, displays)).toBe(done);
		expect(keyDown(done, k("Escape"), displays)).toBe(done);
	});
});
