// GLIM-151: moving the docked Live popup: clamping on screen, the height limit below a moved
// popup, display changes, keyboard steps and the remembered offset per display.
import { describe, expect, test } from "bun:test";
import {
	type Display,
	displayKey,
	forgetOffset,
	LIVE_MOVE_STEP,
	LIVE_MOVE_STEP_LARGE,
	LIVE_OFFSETS_MAX,
	type LivePopupOffset,
	liveMoveStep,
	livePopupFrame,
	movedOrigin,
	moveLivePopup,
	offsetFor,
	placeLivePopup,
	rect,
	rememberOffset,
} from "../src/index.ts";

const MAIN: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 25, 1440, 875),
	scaleFactor: 2,
	isPrimary: true,
};
const SIDE: Display = {
	id: 2,
	bounds: rect(1440, 0, 1920, 1080),
	workArea: rect(1440, 0, 1920, 1040),
	scaleFactor: 1,
	isPrimary: false,
};
const REGION = rect(120, 700, 1200, 100);

function docked() {
	const p = placeLivePopup(REGION, [MAIN]);
	if (!p) throw new Error("no placement");
	return p;
}

describe("moveLivePopup", () => {
	test("goes where asked, anchored at the top, width kept", () => {
		const m = moveLivePopup(docked(), { x: 300, y: 200 }, [MAIN], 120);
		expect(m?.edges).toEqual([]);
		expect(m?.placement).toMatchObject({ x: 300, y: 200, anchor: "top", width: docked().width, displayId: 1 });
	});

	test("clamped 8px inside the work area, reporting the edges it stopped at", () => {
		const p = docked();
		const tl = moveLivePopup(p, { x: -500, y: -40 }, [MAIN], 120);
		expect(tl?.placement.x).toBe(8);
		expect(tl?.placement.y).toBe(25 + 8);
		expect(tl?.edges).toEqual(["left", "top"]);
		const br = moveLivePopup(p, { x: 5000, y: 5000 }, [MAIN], 120);
		expect(br?.placement.x).toBe(1440 - 8 - p.width);
		expect(br?.placement.y).toBe(900 - 8 - 120);
		expect(br?.edges).toEqual(["right", "bottom"]);
	});

	test("the height limit is the room below, so growing never moves the top-left or leaves the screen", () => {
		const m = moveLivePopup(docked(), { x: 100, y: 700 }, [MAIN], 100);
		if (!m) throw new Error("no move");
		expect(m.placement.maxHeight).toBe(900 - 8 - 700);
		const grown = livePopupFrame(m.placement, 600);
		expect(grown.y).toBe(700);
		expect(grown.x).toBe(100);
		expect(grown.y + grown.height).toBeLessThanOrEqual(900 - 8);
	});

	test("high up, the limit is the larger of the docked limit and 40% of the work area", () => {
		const p = docked();
		const m = moveLivePopup(p, { x: 100, y: 40 }, [MAIN], 100);
		expect(m?.placement.maxHeight).toBe(Math.max(p.maxHeight, 0.4 * 875));
	});

	test("dragged onto another display: that display's grid, work area and edges", () => {
		const m = moveLivePopup(docked(), { x: 2000, y: 1000 }, [MAIN, SIDE], 120);
		expect(m?.placement.displayId).toBe(2);
		expect(m?.placement.scale).toBe(1);
		expect(m?.placement.origin).toEqual({ x: 1440, y: 0 });
		expect(m?.placement.y).toBe(1040 - 8 - 120);
		expect(m?.edges).toEqual(["bottom"]);
	});

	test("narrowed only when the display is narrower than the popup", () => {
		const tiny: Display = { ...MAIN, bounds: rect(0, 0, 300, 600), workArea: rect(0, 0, 300, 600) };
		const m = moveLivePopup({ ...docked(), width: 640 }, { x: 0, y: 0 }, [tiny], 100);
		expect(m?.placement.width).toBe(284);
	});

	test("bad numbers fall back to the docked position; no displays: null", () => {
		const p = docked();
		expect(moveLivePopup(p, { x: Number.NaN, y: Number.POSITIVE_INFINITY }, [MAIN], 100)?.placement.x).toBe(p.x);
		expect(moveLivePopup(p, { x: 0, y: 0 }, [], 100)).toBeNull();
	});
});

describe("keyboard steps", () => {
	test("10 px, 50 px with Shift, physical directions", () => {
		expect(liveMoveStep("left", false)).toEqual({ x: -LIVE_MOVE_STEP, y: 0 });
		expect(liveMoveStep("right", true)).toEqual({ x: LIVE_MOVE_STEP_LARGE, y: 0 });
		expect(liveMoveStep("up", false)).toEqual({ x: 0, y: -10 });
		expect(liveMoveStep("down", true)).toEqual({ x: 0, y: 50 });
		expect(movedOrigin({ x: 5, y: 5 }, { x: 10, y: -5 })).toEqual({ x: 15, y: 0 });
	});
});

describe("remembered offset", () => {
	test("display key: arrangement and scale", () => {
		expect(displayKey(MAIN)).toBe("0,0,1440x900@2");
		expect(displayKey(SIDE)).toBe("1440,0,1920x1080@1");
	});

	test("remember, look up for another region on the same display, forget", () => {
		const list = rememberOffset([], REGION, [MAIN, SIDE], { x: 400, y: 300 });
		expect(list).toEqual([{ display: displayKey(MAIN), dx: 280, dy: -400 }]);
		expect(offsetFor(rect(200, 650, 400, 80), [MAIN, SIDE], list)).toEqual({ x: 480, y: 250 });
		// Another display has its own (none yet).
		expect(offsetFor(rect(1600, 500, 400, 80), [MAIN, SIDE], list)).toBeNull();
		expect(forgetOffset(list, REGION, [MAIN, SIDE])).toEqual([]);
		const none: readonly LivePopupOffset[] = [];
		expect(forgetOffset(none, REGION, [MAIN])).toBe(none);
	});

	test("replaces the display's entry, newest last, capped", () => {
		let list: readonly LivePopupOffset[] = Array.from({ length: LIVE_OFFSETS_MAX }, (_, i) => ({
			display: `d${i}`,
			dx: i,
			dy: i,
		}));
		list = rememberOffset(list, REGION, [MAIN], { x: 120, y: 690 });
		expect(list).toHaveLength(LIVE_OFFSETS_MAX);
		expect(list.at(-1)).toEqual({ display: displayKey(MAIN), dx: 0, dy: -10 });
		expect(list[0]?.display).toBe("d1");
		list = rememberOffset(list, REGION, [MAIN], { x: 130, y: 690 });
		expect(list.filter((e) => e.display === displayKey(MAIN))).toEqual([
			{ display: displayKey(MAIN), dx: 10, dy: -10 },
		]);
	});
});
