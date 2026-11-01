import { describe, expect, test } from "bun:test";
import {
	type Display,
	displayForRegion,
	facingEdge,
	POPUP_GAP,
	POPUP_MARGIN,
	placeSnipPopup,
	type Rect,
	snipPopupFrame,
} from "../src/index.ts";

// The mockup's display: 1440 x 900 with a 48px taskbar at the bottom.
const MAIN: Display = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1440, height: 900 },
	workArea: { x: 0, y: 0, width: 1440, height: 852 },
	scaleFactor: 1.5,
	isPrimary: true,
};
// A 2x display to the right, top-aligned, with a 25px menu bar.
const RIGHT: Display = {
	id: 2,
	bounds: { x: 1440, y: 0, width: 1280, height: 800 },
	workArea: { x: 1440, y: 25, width: 1280, height: 775 },
	scaleFactor: 2,
	isPrimary: false,
};
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const place = (region: Rect, opts: Parameters<typeof placeSnipPopup>[2] = {}, displays = [MAIN]) => {
	const p = placeSnipPopup(region, displays, opts);
	if (!p) throw new Error("no placement");
	return p;
};

describe("placeSnipPopup: side order (snip-popup.md §3)", () => {
	test("below when there is comfortable room, inline-start edges aligned", () => {
		const p = place(r(100, 100, 400, 120));
		expect(p.side).toBe("below");
		expect(p.width).toBe(400);
		expect(p.x).toBe(100);
		expect(p.anchor).toBe("top");
		expect(p.y).toBe(100 + 120 + POPUP_GAP);
		// min(0.6 x work area, space below)
		expect(p.maxHeight).toBeCloseTo(0.6 * 852);
	});

	test("above when below is short; the bottom edge is anchored 8px above the region", () => {
		const p = place(r(300, 600, 500, 150));
		expect(p.side).toBe("above");
		expect(p.anchor).toBe("bottom");
		expect(p.y).toBe(600 - POPUP_GAP);
		expect(p.width).toBe(480);
	});

	test("inline-end side for a tall column with no room above or below", () => {
		const p = place(r(40, 60, 300, 760));
		expect(p.side).toBe("inline-end");
		expect(p.x).toBe(40 + 300 + POPUP_GAP);
		expect(p.y).toBe(60);
		expect(p.width).toBe(300);
	});

	test("inline-start side when the column is on the right edge", () => {
		const p = place(r(1000, 60, 400, 760));
		expect(p.side).toBe("inline-start");
		expect(p.x + p.width).toBe(1000 - POPUP_GAP);
	});

	test("the side narrows the popup to the room there", () => {
		const p = place(r(40, 60, 1060, 760));
		expect(p.side).toBe("inline-end");
		expect(p.width).toBe(1440 - (40 + 1060) - POPUP_GAP - POPUP_MARGIN);
	});

	test("a wide strip with little room either way takes the larger of below/above (≥ MIN_H)", () => {
		const p = place(r(0, 650, 1440, 80));
		expect(p.side).toBe("above");
		const q = place(r(0, 90, 1440, 650));
		expect(q.side).toBe("below");
		expect(q.maxHeight).toBe(852 - (90 + 650) - POPUP_GAP - POPUP_MARGIN);
	});

	test("a region that fills the screen gets the inside fallback, bottom inline-end corner", () => {
		const p = place(r(0, 0, 1440, 852));
		expect(p.side).toBe("inside");
		expect(p.anchor).toBe("bottom");
		expect(p.x + p.width).toBe(1440 - 8);
		expect(p.y).toBe(852 - 8);
		expect(p.maxHeight).toBeCloseTo(0.6 * 852);
	});

	test("width is clamped to 280-480", () => {
		expect(place(r(100, 100, 40, 20)).width).toBe(280);
		expect(place(r(100, 100, 900, 40)).width).toBe(480);
	});

	test("near the right edge the popup is clamped into the work area", () => {
		const p = place(r(1300, 100, 120, 40));
		expect(p.side).toBe("below");
		expect(p.x + p.width).toBe(1440 - POPUP_MARGIN);
	});
});

describe("placeSnipPopup: RTL UI", () => {
	test("below/above align the inline-start (right) edges", () => {
		const p = place(r(600, 100, 400, 100), { uiDir: "rtl" });
		expect(p.side).toBe("below");
		expect(p.x + p.width).toBe(1000);
	});

	test("inline-end is the left side", () => {
		const p = place(r(1000, 60, 400, 760), { uiDir: "rtl" });
		expect(p.side).toBe("inline-end");
		expect(p.x + p.width).toBe(1000 - POPUP_GAP);
	});

	test("inside sits in the bottom-left corner", () => {
		const p = place(r(0, 0, 1440, 852), { uiDir: "rtl" });
		expect(p.side).toBe("inside");
		expect(p.x).toBe(8);
	});
});

describe("displays", () => {
	test("the display whose work area overlaps most", () => {
		expect(displayForRegion(r(1300, 100, 300, 100), [MAIN, RIGHT])?.id).toBe(2);
		expect(displayForRegion(r(1300, 100, 200, 100), [MAIN, RIGHT])?.id).toBe(1);
	});

	test("a tie goes to the display under the pointer", () => {
		const tie = r(1340, 100, 200, 100);
		expect(displayForRegion(tie, [MAIN, RIGHT], { x: 1500, y: 150 })?.id).toBe(2);
		expect(displayForRegion(tie, [MAIN, RIGHT], { x: 1400, y: 150 })?.id).toBe(1);
	});

	test("the popup never spans displays: it is clamped into its own work area", () => {
		const p = place(r(1450, 100, 300, 60), {}, [MAIN, RIGHT]);
		expect(p.displayId).toBe(2);
		expect(p.x).toBeGreaterThanOrEqual(1440 + POPUP_MARGIN);
		expect(p.y).toBe(160 + POPUP_GAP);
	});

	test("no displays, no placement", () => {
		expect(placeSnipPopup(r(0, 0, 10, 10), [])).toBeNull();
	});
});

describe("snipPopupFrame: growth and device pixels", () => {
	test("below grows down from the anchored top, capped at maxHeight", () => {
		const p = place(r(100, 100, 400, 120));
		expect(snipPopupFrame(p, 140)).toEqual({ x: 100, y: 228, width: 400, height: 140 });
		expect(snipPopupFrame(p, 5000).height).toBeCloseTo(511.333, 2);
	});

	test("above grows up: the bottom edge stays 8px above the region", () => {
		const p = place(r(300, 600, 500, 150));
		const a = snipPopupFrame(p, 100);
		const b = snipPopupFrame(p, 300);
		expect(a.y + a.height).toBe(592);
		expect(b.y + b.height).toBe(592);
	});

	test("sides: the top lines up with the region's, clamped to the work-area margin", () => {
		const p = place(r(40, -30, 300, 900));
		expect(p.side).toBe("inline-end");
		expect(p.y).toBe(POPUP_MARGIN);
		const f = snipPopupFrame(p, 300);
		expect(f.y).toBe(POPUP_MARGIN);
		expect(f.y + f.height).toBeLessThanOrEqual(852 - POPUP_MARGIN);
	});

	test("origin and size land on the 1.5x device-pixel grid", () => {
		const p = place(r(100.3, 100.2, 400.4, 120.1));
		const f = snipPopupFrame(p, 123.4);
		for (const v of [f.x, f.y, f.width, f.height]) expect(Number.isInteger(Math.round(v * 1.5 * 1e6) / 1e6)).toBe(true);
	});

	test("the enter animation grows from the edge that faces the region", () => {
		expect(facingEdge("below")).toBe("top");
		expect(facingEdge("above")).toBe("bottom");
		expect(facingEdge("inline-end")).toBe("inline-start");
		expect(facingEdge("inline-start")).toBe("inline-end");
		expect(facingEdge("inside")).toBe("bottom");
	});
});
