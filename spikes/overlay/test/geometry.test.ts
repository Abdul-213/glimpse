import { describe, expect, test } from "bun:test";
import {
	type DisplayInfo,
	clampToDesktop,
	describeSelection,
	displayForPoint,
	intersect,
	logicalToGlobalPhysical,
	rectFromPoints,
	sizeLabel,
	snapToDevicePixels,
} from "../src/shared/geometry";

// Fixtures mirror what Electrobun 2.0.6-beta.2 returns from Screen.getAllDisplays().

// macOS: 14" MacBook Pro (1512x982 pt @2x, primary) + 1080p external @1x to its
// right, top edge 200 pt higher. Global points are uniform across displays.
const mac: DisplayInfo[] = [
	{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 }, scaleFactor: 2, isPrimary: true, physicalBounds: null },
	{ id: 2, bounds: { x: 1512, y: -200, width: 1920, height: 1080 }, workArea: { x: 1512, y: -175, width: 1920, height: 1055 }, scaleFactor: 1, isPrimary: false, physicalBounds: null },
];

// Windows: 4K @150% primary (physical 3840x2160 at 0,0) + 1080p @100% to its
// right (physical 1920x1080 at 3840,0). Electrobun's Chromium-style layout puts
// the secondary at logical x = 2560 (primary logical width), not 3840.
const win: DisplayInfo[] = [
	{ id: 65537, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, scaleFactor: 1.5, isPrimary: true, physicalBounds: { x: 0, y: 0, width: 3840, height: 2160 } },
	{ id: 65539, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, workArea: { x: 2560, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, isPrimary: false, physicalBounds: { x: 3840, y: 0, width: 1920, height: 1080 } },
];

// Windows: 125% laptop as primary on the right, 100% monitor on the left
// (negative physical x).
const winLeft: DisplayInfo[] = [
	{ id: 10, bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 824 }, scaleFactor: 1.25, isPrimary: true, physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 } },
	{ id: 11, bounds: { x: -2560, y: 0, width: 2560, height: 1440 }, workArea: { x: -2560, y: 0, width: 2560, height: 1400 }, scaleFactor: 1, isPrimary: false, physicalBounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
];

describe("basic rect maths", () => {
	test("rectFromPoints normalises any drag direction", () => {
		expect(rectFromPoints({ x: 10, y: 20 }, { x: 4, y: 2 })).toEqual({ x: 4, y: 2, width: 6, height: 18 });
		expect(rectFromPoints({ x: -5, y: -5 }, { x: 5, y: 5 })).toEqual({ x: -5, y: -5, width: 10, height: 10 });
	});
	test("intersect returns null for touching edges", () => {
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
	});
	test("displayForPoint: edges belong to the display on the right/bottom", () => {
		expect(displayForPoint(mac, { x: 1511, y: 0 })?.id).toBe(1);
		expect(displayForPoint(mac, { x: 1512, y: 0 })?.id).toBe(2);
		// Dead zone above the laptop (external is taller and offset): nearest display.
		expect(displayForPoint(mac, { x: 100, y: -100 })?.id).toBe(1);
	});
	test("clampToDesktop pulls dead-zone points onto the nearest display", () => {
		expect(clampToDesktop(mac, { x: 100, y: -100 })).toEqual({ x: 100, y: 0 });
		expect(clampToDesktop(mac, { x: 2000, y: 500 })).toEqual({ x: 2000, y: 500 });
	});
});

describe("macOS Retina + 1x external", () => {
	test("selection inside the Retina display doubles in pixels", () => {
		const r = describeSelection({ x: 100, y: 50, width: 300, height: 200 }, mac);
		expect(r.pieces).toHaveLength(1);
		const p = r.pieces[0]!;
		expect(p.displayId).toBe(1);
		expect(p.localPhysical).toEqual({ x: 200, y: 100, width: 600, height: 400 });
		expect(p.globalPhysical).toBeNull();
		expect(r.globalPhysicalBounds).toBeNull();
		expect(r.spansMixedScale).toBe(false);
	});
	test("selection across the seam splits into two pieces of different scale", () => {
		const r = describeSelection({ x: 1400, y: 100, width: 300, height: 100 }, mac);
		expect(r.pieces.map((p) => p.displayId)).toEqual([1, 2]);
		expect(r.pieces[0]!.localLogical).toEqual({ x: 1400, y: 100, width: 112, height: 100 });
		expect(r.pieces[0]!.localPhysical).toEqual({ x: 2800, y: 200, width: 224, height: 200 });
		// External display origin is (1512, -200): local y = 100 - (-200) = 300.
		expect(r.pieces[1]!.localLogical).toEqual({ x: 0, y: 300, width: 188, height: 100 });
		expect(r.pieces[1]!.localPhysical).toEqual({ x: 0, y: 300, width: 188, height: 100 });
		expect(r.spansMixedScale).toBe(true);
	});
	test("half-point drag snaps to the 2x grid", () => {
		const s = snapToDevicePixels({ x: 10.3, y: 10.26, width: 5.1, height: 5 }, mac[0]!);
		expect(s.x).toBe(10.5);
		expect(s.y).toBe(10.5);
		expect(s.x + s.width).toBe(15.5);
	});
});

describe("Windows 150% + 100% (Chromium-style logical layout)", () => {
	test("primary piece maps to physical by x1.5", () => {
		const r = describeSelection({ x: 100, y: 100, width: 200, height: 100 }, win);
		const p = r.pieces[0]!;
		expect(p.localPhysical).toEqual({ x: 150, y: 150, width: 300, height: 150 });
		expect(p.globalPhysical).toEqual({ x: 150, y: 150, width: 300, height: 150 });
	});
	test("secondary piece maps to physical x >= 3840 even though logical x is 2560", () => {
		const r = describeSelection({ x: 2600, y: 10, width: 100, height: 50 }, win);
		const p = r.pieces[0]!;
		expect(p.displayId).toBe(65539);
		expect(p.globalPhysical).toEqual({ x: 3880, y: 10, width: 100, height: 50 });
	});
	test("spanning selection: union of physical pieces is wider than logical*any-scale", () => {
		const r = describeSelection({ x: 2460, y: 0, width: 200, height: 100 }, win);
		expect(r.pieces).toHaveLength(2);
		expect(r.pieces[0]!.globalPhysical).toEqual({ x: 3690, y: 0, width: 150, height: 150 });
		expect(r.pieces[1]!.globalPhysical).toEqual({ x: 3840, y: 0, width: 100, height: 100 });
		expect(r.globalPhysicalBounds).toEqual({ x: 3690, y: 0, width: 250, height: 150 });
		expect(r.spansMixedScale).toBe(true);
	});
	test("logicalToGlobalPhysical matches Electrobun's logicalScreenPointToPhysical", () => {
		expect(logicalToGlobalPhysical(win, { x: 2559, y: 1439 })).toEqual({ x: 3839, y: 2159 }); // round(2559*1.5)=3838.5->3839
		expect(logicalToGlobalPhysical(win, { x: 2560, y: 0 })).toEqual({ x: 3840, y: 0 });
		expect(logicalToGlobalPhysical(win, { x: 4479, y: 1079 })).toEqual({ x: 5759, y: 1079 });
	});
	test("125% edges snap so adjacent pieces stay adjacent", () => {
		const s = snapToDevicePixels({ x: 0.3, y: 0.3, width: 10.1, height: 10.1 }, winLeft[0]!);
		// 1/1.25 = 0.8 logical per pixel
		expect(s.x).toBeCloseTo(0.0, 6);
		expect(s.x + s.width).toBeCloseTo(10.4, 6);
	});
	test("display on the left with negative coordinates", () => {
		const r = describeSelection({ x: -100, y: 10, width: 200, height: 40 }, winLeft);
		const left = r.pieces.find((p) => p.displayId === 11)!;
		const right = r.pieces.find((p) => p.displayId === 10)!;
		expect(left.globalPhysical).toEqual({ x: -100, y: 10, width: 100, height: 40 });
		expect(right.globalPhysical).toEqual({ x: 0, y: 13, width: 125, height: 50 }); // round(10*1.25)=12.5->13
		expect(logicalToGlobalPhysical(winLeft, { x: -1, y: 0 })).toEqual({ x: -1, y: 0 });
	});
});

describe("size label", () => {
	test("1x shows plain size, 2x adds pixels, multi-display flags mixed DPI", () => {
		expect(sizeLabel({ x: 1600, y: 0, width: 100, height: 50 }, mac)).toBe("100 × 50");
		expect(sizeLabel({ x: 0, y: 0, width: 100, height: 50 }, mac)).toBe("100 × 50 pt · 200 × 100 px @2x");
		expect(sizeLabel({ x: 1400, y: 0, width: 300, height: 50 }, mac)).toBe("300 × 50 pt · 2 displays, mixed DPI");
	});
});
