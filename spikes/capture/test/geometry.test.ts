import { describe, expect, test } from "bun:test";
import {
	intersect,
	logicalToNative,
	nativeToLogical,
	parseRect,
	planCapture,
	spanningRegion,
	type NativeDisplay,
} from "../src/core/geometry";

// macOS-style: Retina laptop (1512x982 pt @2x) as main, 1x external to the right,
// top-aligned. Global points, y down.
const macDisplays: NativeDisplay[] = [
	{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, pixelScale: 2, uiScale: 2, primary: true },
	{ id: 2, bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, pixelScale: 1, uiScale: 1, primary: false },
];

// Windows-style physical layout: 4K @150% primary, 1080p @100% to its left.
const winDisplays: NativeDisplay[] = [
	{ id: 65537, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, pixelScale: 1, uiScale: 1.5, primary: true },
	{ id: 65539, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, pixelScale: 1, uiScale: 1, primary: false },
];

describe("parseRect", () => {
	test("accepts commas, spaces and negatives", () => {
		expect(parseRect("-100, 20,400,120")).toEqual({ x: -100, y: 20, width: 400, height: 120 });
		expect(parseRect("1 2 3 4")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
	});
	test("rejects bad input", () => {
		expect(() => parseRect("1,2,3")).toThrow();
		expect(() => parseRect("1,2,0,4")).toThrow();
		expect(() => parseRect("a,b,c,d")).toThrow();
	});
});

describe("intersect", () => {
	test("overlap and disjoint", () => {
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
			x: 5,
			y: 5,
			width: 5,
			height: 5,
		});
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
	});
});

describe("planCapture (macOS, mixed scale)", () => {
	test("single Retina display: output is points x 2", () => {
		const p = planCapture({ x: 100, y: 700, width: 400, height: 120 }, macDisplays);
		expect(p.scale).toBe(2);
		expect([p.outWidth, p.outHeight]).toEqual([800, 240]);
		expect(p.pieces).toHaveLength(1);
		expect(p.pieces[0]!.dest).toEqual({ x: 0, y: 0, width: 800, height: 240 });
		expect(p.hasUncovered).toBe(false);
	});

	test("1x display only: output is 1:1", () => {
		const p = planCapture({ x: 2000, y: 100, width: 400, height: 120 }, macDisplays);
		expect(p.scale).toBe(1);
		expect(p.pieces[0]!.local).toEqual({ x: 488, y: 100, width: 400, height: 120 });
	});

	test("spanning Retina + 1x: max scale, pieces tile exactly", () => {
		const p = planCapture({ x: 1312, y: 100, width: 400, height: 120 }, macDisplays);
		expect(p.scale).toBe(2);
		expect([p.outWidth, p.outHeight]).toEqual([800, 240]);
		expect(p.pieces).toHaveLength(2);
		const [a, b] = p.pieces;
		expect(a!.displayId).toBe(1);
		expect(a!.local).toEqual({ x: 1312, y: 100, width: 200, height: 120 });
		expect(b!.local).toEqual({ x: 0, y: 100, width: 200, height: 120 });
		expect(a!.dest).toEqual({ x: 0, y: 0, width: 400, height: 240 });
		expect(b!.dest).toEqual({ x: 400, y: 0, width: 400, height: 240 });
	});

	test("fractional edges never leave gaps", () => {
		const ds: NativeDisplay[] = [
			{ id: 1, bounds: { x: 0, y: 0, width: 100.5, height: 100 }, pixelScale: 1.5, uiScale: 1.5, primary: true },
			{ id: 2, bounds: { x: 100.5, y: 0, width: 100, height: 100 }, pixelScale: 1, uiScale: 1, primary: false },
		];
		const p = planCapture({ x: 33.3, y: 10, width: 120.1, height: 50 }, ds);
		const [a, b] = p.pieces;
		expect(a!.dest.x + a!.dest.width).toBe(b!.dest.x);
		expect(b!.dest.x + b!.dest.width).toBe(p.outWidth);
	});

	test("partly off-screen is flagged", () => {
		const p = planCapture({ x: 1312, y: 1000, width: 400, height: 120 }, macDisplays);
		expect(p.hasUncovered).toBe(true);
		const none = planCapture({ x: -5000, y: 0, width: 10, height: 10 }, macDisplays);
		expect(none.pieces).toHaveLength(0);
	});

	test("scale override", () => {
		const p = planCapture({ x: 0, y: 0, width: 100, height: 50 }, macDisplays, 1);
		expect([p.outWidth, p.outHeight]).toEqual([100, 50]);
	});
});

describe("planCapture (Windows, physical px)", () => {
	test("region straddling the negative-x monitor", () => {
		const p = planCapture({ x: -200, y: 500, width: 400, height: 120 }, winDisplays);
		expect(p.scale).toBe(1);
		expect(p.pieces.map((x) => x.displayId).sort()).toEqual([65537, 65539]);
		const left = p.pieces.find((x) => x.displayId === 65539)!;
		expect(left.local).toEqual({ x: 1720, y: 500, width: 200, height: 120 });
		expect(left.global).toEqual({ x: -200, y: 500, width: 200, height: 120 });
		expect(left.dest).toEqual({ x: 0, y: 0, width: 200, height: 120 });
	});
	test("below the shorter monitor is uncovered", () => {
		const p = planCapture({ x: -200, y: 1000, width: 400, height: 200 }, winDisplays);
		expect(p.hasUncovered).toBe(true);
	});
});

describe("logical <-> native (Windows mixed DPI)", () => {
	// Electrobun logical layout: primary 3840x2160@1.5 -> 2560x1440 logical at 0,0;
	// left monitor 1920x1080@1 at -1920,0.
	const logical = [
		{ id: 65537, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5, isPrimary: true },
		{ id: 65539, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, isPrimary: false },
	];
	test("rect on the 150% monitor scales by 1.5", () => {
		const r = logicalToNative({ x: 100, y: 100, width: 400, height: 120 }, logical, winDisplays, "win32");
		expect(r.bounds).toEqual({ x: 150, y: 150, width: 600, height: 180 });
	});
	test("rect spanning both maps each part with its own scale", () => {
		const r = logicalToNative({ x: -100, y: 100, width: 200, height: 100 }, logical, winDisplays, "win32");
		expect(r.parts).toHaveLength(2);
		expect(r.parts).toContainEqual({ x: -100, y: 100, width: 100, height: 100 });
		expect(r.parts).toContainEqual({ x: 0, y: 150, width: 150, height: 150 });
		expect(r.bounds).toEqual({ x: -100, y: 100, width: 250, height: 200 });
	});
	test("macOS is identity", () => {
		const rect = { x: 1, y: 2, width: 3, height: 4 };
		expect(logicalToNative(rect, logical, winDisplays, "darwin").bounds).toEqual(rect);
	});
	test("nativeToLogical round-trips on one monitor", () => {
		const back = nativeToLogical({ x: 150, y: 150, width: 600, height: 180 }, logical, winDisplays, "win32");
		expect(back).toEqual({ x: 100, y: 100, width: 400, height: 120 });
	});
});

describe("spanningRegion", () => {
	test("finds the shared vertical edge", () => {
		const r = spanningRegion(macDisplays)!;
		expect(r.x + r.width / 2).toBe(1512);
		expect(planCapture(r, macDisplays).pieces).toHaveLength(2);
	});
	test("works with a monitor to the left (negative x)", () => {
		const r = spanningRegion(winDisplays)!;
		expect(r.x + r.width / 2).toBe(0);
	});
	test("single display -> null", () => {
		expect(spanningRegion([macDisplays[0]!])).toBeNull();
	});
});
