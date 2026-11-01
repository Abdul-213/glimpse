import { describe, expect, test } from "bun:test";
import {
	CapturePixelSampler,
	clampToDesktop,
	desktopBounds,
	devicePixelAt,
	displayAt,
	LOUPE_CELLS,
	loupeRect,
	nativeToLogicalRect,
	rect,
	selectionPieces,
	snapToDevicePixels,
	spansMixedScale,
} from "../src/index.ts";
import { makeImage, pixelAt, ReplayCaptureSource, StaticWindowList } from "../src/testing/index.ts";
import { macDisplays, negDisplays, winDisplays, winNative } from "./picker-fixtures.ts";

describe("displayAt / clampToDesktop", () => {
	test("finds the containing display, else the nearest", () => {
		expect(displayAt(macDisplays, { x: 100, y: 100 })?.id).toBe(1);
		expect(displayAt(macDisplays, { x: 1600, y: 300 })?.id).toBe(2);
		// The gap above the lower external display belongs to neither; nearest wins.
		expect(displayAt(macDisplays, { x: 1700, y: 50 })?.id).toBe(2);
		expect(displayAt([], { x: 0, y: 0 })).toBeNull();
	});

	test("a point in the gap between displays sticks to the nearest edge", () => {
		expect(clampToDesktop(macDisplays, { x: 1700, y: 50 })).toEqual({ x: 1700, y: 200 });
		expect(clampToDesktop(macDisplays, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
		// The far edges are inclusive: a drag can end exactly on the desktop's right edge.
		expect(clampToDesktop(macDisplays, { x: 5000, y: 300 })).toEqual({ x: 3432, y: 300 });
	});

	test("negative x monitors", () => {
		expect(displayAt(negDisplays, { x: -10, y: 10 })?.id).toBe(11);
		expect(desktopBounds(negDisplays)).toEqual(rect(-1536, 0, 3456, 1080));
		expect(desktopBounds([])).toBeNull();
	});
});

describe("device pixel snapping and pieces", () => {
	test("150 %: edges land on whole device px", () => {
		const d = winDisplays[0];
		if (!d) throw new Error("fixture");
		const s = snapToDevicePixels(rect(10.4, 20.2, 100.1, 50.5), d);
		for (const v of [s.x, s.y, s.x + s.width, s.y + s.height])
			expect(Number.isInteger(Math.round(v * 1.5 * 1e9) / 1e9)).toBe(true);
		expect(s.x).toBeCloseTo(10.6667, 3);
	});

	test("a selection across a mixed-DPI seam splits into one piece per display", () => {
		const pieces = selectionPieces(rect(2400, 100, 400, 200), winDisplays);
		expect(pieces.map((p) => p.displayId)).toEqual([65537, 65539]);
		expect(pieces[0]?.local).toEqual(rect(2400, 100, 160, 200));
		expect(pieces[0]?.physical).toEqual(rect(3600, 150, 240, 300));
		expect(pieces[1]?.local).toEqual(rect(0, 100, 240, 200));
		expect(pieces[1]?.physical).toEqual(rect(0, 100, 240, 200));
		expect(spansMixedScale(pieces)).toBe(true);
		expect(spansMixedScale(selectionPieces(rect(10, 10, 50, 50), winDisplays))).toBe(false);
	});

	test("Retina + offset external", () => {
		const pieces = selectionPieces(rect(1400, 300, 300, 100), macDisplays);
		expect(pieces[0]?.physical).toEqual(rect(2800, 600, 224, 200));
		expect(pieces[1]?.local).toEqual(rect(0, 100, 188, 100));
	});
});

describe("nativeToLogicalRect (Windows window frames)", () => {
	test("a window on the 150 % primary", () => {
		expect(nativeToLogicalRect(winNative, rect(300, 150, 1500, 900))).toEqual(rect(200, 100, 1000, 600));
	});

	test("a window on the 100 % secondary maps through the Chromium-style layout", () => {
		expect(nativeToLogicalRect(winNative, rect(3940, 100, 800, 600))).toEqual(rect(2660, 100, 800, 600));
	});

	test("a window straddling both keeps each edge on its own monitor", () => {
		const r = nativeToLogicalRect(winNative, rect(3540, 300, 600, 300));
		expect(r).toEqual({ x: 2360, y: 200, width: 500, height: 400 });
	});

	test("nothing to map against", () => {
		expect(nativeToLogicalRect([], rect(0, 0, 10, 10))).toBeNull();
	});
});

describe("loupe sampling from capture", () => {
	test("loupeRect covers 15 device px: 7.5 logical on a 2x display", () => {
		const d = macDisplays[0];
		if (!d) throw new Error("fixture");
		expect(devicePixelAt(d, { x: 10.3, y: 20.9 })).toEqual({ x: 20, y: 41 });
		expect(loupeRect(d, { x: 10.3, y: 20.9 })).toEqual(rect(6.5, 17, 7.5, 7.5));
	});

	test("CapturePixelSampler returns the 15 x 15 patch centred on the hotspot", async () => {
		// One 64 x 48 display at 1x; pixel (x, y) is (x, y, 7).
		const source = new ReplayCaptureSource([makeImage(64, 48, (x, y) => [x, y, 7])]);
		const sampler = new CapturePixelSampler(source);
		const patch = await sampler.sample({ x: 20.5, y: 10.2 }, LOUPE_CELLS);
		expect(patch?.size).toBe(15);
		expect(patch?.rgba.length).toBe(15 * 15 * 4);
		const img = { width: 15, data: patch?.rgba ?? new Uint8Array() };
		expect(pixelAt(img, 7, 7)).toEqual([20, 10, 7]); // centre cell = the pixel under the pointer
		expect(pixelAt(img, 0, 0)).toEqual([13, 3, 7]);
	});

	test("cells off the desktop are black", async () => {
		const source = new ReplayCaptureSource([makeImage(32, 32, () => [200, 200, 200])]);
		const patch = await new CapturePixelSampler(source).sample({ x: 1, y: 1 }, 15);
		const img = { width: 15, data: patch?.rgba ?? new Uint8Array() };
		expect(pixelAt(img, 0, 0)).toEqual([0, 0, 0]);
		expect(pixelAt(img, 7, 7)).toEqual([200, 200, 200]);
	});

	test("capture failures resolve null and are reported once", async () => {
		const errors: unknown[] = [];
		const source = new ReplayCaptureSource([makeImage(32, 32, () => [1, 2, 3])]);
		source.capture = async () => {
			throw new Error("permission denied");
		};
		const sampler = new CapturePixelSampler(source, (e) => errors.push(e));
		expect(await sampler.sample({ x: 0, y: 0 }, 15)).toBeNull();
		await sampler.sample({ x: 0, y: 0 }, 15);
		expect(errors).toHaveLength(1);
	});
});

describe("fakes", () => {
	test("StaticWindowList sorts front to back and can fail", async () => {
		const list = new StaticWindowList([
			{ rect: rect(0, 0, 100, 100), pid: 2, z: 1, appName: "B" },
			{ rect: rect(0, 0, 100, 100), pid: 1, z: 0, appName: "A" },
		]);
		expect((await list.list()).map((w) => w.appName)).toEqual(["A", "B"]);
		list.fail = true;
		await expect(list.list()).rejects.toThrow();
	});
});
