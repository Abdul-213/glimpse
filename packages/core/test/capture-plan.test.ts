// Ported from spikes/capture/test/geometry.test.ts, against the unified planCapture.
import { describe, expect, test } from "bun:test";
import {
	type CaptureDisplay,
	type Display,
	parseRect,
	planCapture,
	rect,
	withLogicalNativeBounds,
	withNativeBounds,
} from "../src/index.ts";

const display = (id: number, bounds: ReturnType<typeof rect>, scaleFactor: number, isPrimary = false): Display => ({
	id,
	bounds,
	workArea: bounds,
	scaleFactor,
	isPrimary,
});

// macOS: Retina laptop (1512x982 pt @2x) as main, 1x external to the right, top-aligned.
// Native space = global points.
const mac: CaptureDisplay[] = withLogicalNativeBounds([
	display(1, rect(0, 0, 1512, 982), 2, true),
	display(2, rect(1512, 0, 1920, 1080), 1),
]);

// Windows: 4K @150% primary, 1080p @100% to its left. Electrobun's logical layout puts
// the primary at 2560x1440 DIP; physical rects come from glimpse.dll by HMONITOR.
const winLogical: Display[] = [
	display(65537, rect(0, 0, 2560, 1440), 1.5, true),
	display(65539, rect(-1920, 0, 1920, 1080), 1),
];
const winPhysical = [
	{ id: 65537, bounds: rect(0, 0, 3840, 2160) },
	{ id: 65539, bounds: rect(-1920, 0, 1920, 1080) },
];
const win = withNativeBounds(winLogical, winPhysical);

describe("planCapture on macOS (native = points)", () => {
	test("single Retina display: output is points x 2, source is local points", () => {
		const p = planCapture(rect(100, 700, 400, 120), mac);
		expect(p.scale).toBe(2);
		expect([p.width, p.height]).toEqual([800, 240]);
		expect(p.pieces).toHaveLength(1);
		expect(p.pieces[0]?.dest).toEqual(rect(0, 0, 800, 240));
		expect(p.pieces[0]?.sourceLocal).toEqual(rect(100, 700, 400, 120));
		expect(p.partial).toBe(false);
	});

	test("1x display only: output is 1:1, source is display-local", () => {
		const p = planCapture(rect(2000, 100, 400, 120), mac);
		expect(p.scale).toBe(1);
		expect(p.pieces[0]?.sourceLocal).toEqual(rect(488, 100, 400, 120));
		expect(p.pieces[0]?.source).toEqual(rect(2000, 100, 400, 120));
	});

	test("spanning Retina + 1x: max scale, pieces tile exactly", () => {
		const p = planCapture(rect(1312, 100, 400, 120), mac);
		expect(p.scale).toBe(2);
		expect([p.width, p.height]).toEqual([800, 240]);
		const [a, b] = p.pieces;
		expect(a?.displayId).toBe(1);
		expect(a?.sourceLocal).toEqual(rect(1312, 100, 200, 120));
		expect(b?.sourceLocal).toEqual(rect(0, 100, 200, 120));
		expect(a?.dest).toEqual(rect(0, 0, 400, 240));
		expect(b?.dest).toEqual(rect(400, 0, 400, 240));
	});

	test("fractional edges never leave gaps", () => {
		const ds = withLogicalNativeBounds([
			display(1, rect(0, 0, 100.5, 100), 1.5),
			display(2, rect(100.5, 0, 100, 100), 1),
		]);
		const p = planCapture(rect(33.3, 10, 120.1, 50), ds);
		const [a, b] = p.pieces;
		expect((a?.dest.x ?? 0) + (a?.dest.width ?? 0)).toBe(b?.dest.x ?? -1);
		expect((b?.dest.x ?? 0) + (b?.dest.width ?? 0)).toBe(p.width);
	});

	test("partly off-screen is flagged; fully off-screen has no pieces", () => {
		expect(planCapture(rect(1312, 1000, 400, 120), mac).partial).toBe(true);
		const none = planCapture(rect(-5000, 0, 10, 10), mac);
		expect(none.pieces).toHaveLength(0);
		expect(none.partial).toBe(true);
	});

	test("scale override", () => {
		const p = planCapture(rect(0, 0, 100, 50), mac, { scale: 1 });
		expect([p.width, p.height]).toEqual([100, 50]);
	});

	test("rejects empty and non-finite rects", () => {
		expect(() => planCapture(rect(0, 0, 0, 10), mac)).toThrow(RangeError);
		expect(() => planCapture(rect(0, 0, Number.NaN, 10), mac)).toThrow(RangeError);
		expect(() => planCapture(rect(0, 0, 10, 10), mac, { scale: 0 })).toThrow(RangeError);
	});
});

describe("planCapture on Windows (native = physical px)", () => {
	test("rect on the 150% monitor maps to physical px x1.5", () => {
		const p = planCapture(rect(100, 100, 400, 120), win, { snapSource: true });
		expect(p.scale).toBe(1.5);
		expect([p.width, p.height]).toEqual([600, 180]);
		expect(p.pieces[0]?.source).toEqual(rect(150, 150, 600, 180));
		expect(p.pieces[0]?.dest).toEqual(rect(0, 0, 600, 180));
	});

	test("rect on the negative-x monitor: global and monitor-local physical", () => {
		const p = planCapture(rect(-300, 500, 200, 100), win, { snapSource: true });
		expect(p.scale).toBe(1);
		expect(p.pieces[0]?.source).toEqual(rect(-300, 500, 200, 100));
		expect(p.pieces[0]?.sourceLocal).toEqual(rect(1620, 500, 200, 100));
	});

	test("rect spanning mixed DPI: each part maps with its own scale, output at max scale", () => {
		const p = planCapture(rect(-100, 100, 200, 100), win, { snapSource: true });
		expect(p.scale).toBe(1.5);
		expect([p.width, p.height]).toEqual([300, 150]);
		const left = p.pieces.find((x) => x.displayId === 65539);
		const right = p.pieces.find((x) => x.displayId === 65537);
		// Same parts the spike's logicalToNative produced.
		expect(left?.source).toEqual(rect(-100, 100, 100, 100));
		expect(right?.source).toEqual(rect(0, 150, 150, 150));
		// The 100% part is upsampled into its 150x150 dest by the backend.
		expect(left?.dest).toEqual(rect(0, 0, 150, 150));
		expect(right?.dest).toEqual(rect(150, 0, 150, 150));
	});

	test("below the shorter monitor is uncovered", () => {
		expect(planCapture(rect(-200, 1000, 400, 200), win).partial).toBe(true);
	});

	test("snapSource rounds source edges so pieces stay whole pixels", () => {
		const p = planCapture(rect(10.3, 10.3, 33.3, 20.1), win, { snapSource: true });
		const s = p.pieces[0]?.source;
		expect(s && [s.x, s.y, s.width, s.height].every(Number.isInteger)).toBe(true);
	});
});

describe("withNativeBounds", () => {
	test("joins by id and drops displays the backend doesn't know", () => {
		const joined = withNativeBounds(winLogical, [{ id: 65537, bounds: rect(0, 0, 3840, 2160) }]);
		expect(joined.map((d) => d.id)).toEqual([65537]);
		expect(joined[0]?.nativeBounds).toEqual(rect(0, 0, 3840, 2160));
		expect(joined[0]?.scaleFactor).toBe(1.5);
	});
});

describe("parseRect", () => {
	test("accepts commas, spaces and negatives", () => {
		expect(parseRect("-100, 20,400,120")).toEqual(rect(-100, 20, 400, 120));
		expect(parseRect("1 2 3 4")).toEqual(rect(1, 2, 3, 4));
	});
	test("rejects bad input", () => {
		expect(() => parseRect("1,2,3")).toThrow();
		expect(() => parseRect("1,2,0,4")).toThrow();
		expect(() => parseRect("a,b,c,d")).toThrow();
	});
});
