import { describe, expect, test } from "bun:test";
import { allocRgba, blitRgba, CaptureError, rect, rgbaHash, toOcrImage, validateOcrImage } from "../src/index.ts";
import {
	ManualClock,
	makeImage,
	pixelAt,
	ReplayCaptureSource,
	singleDisplay,
	solidImage,
} from "../src/testing/index.ts";

const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;
const BLUE = [0, 0, 255] as const;

describe("blitRgba", () => {
	test("1:1 copy with alpha forced to 255", () => {
		const src = makeImage(4, 4, (x, y) => [x * 10, y * 10, 7]);
		src.data[3] = 0;
		const out = allocRgba(2, 2);
		blitRgba(src, rect(1, 1, 2, 2), out, rect(0, 0, 2, 2));
		expect(pixelAt(out, 0, 0)).toEqual([10, 10, 7]);
		expect(pixelAt(out, 1, 1)).toEqual([20, 20, 7]);
		expect(out.data[3]).toBe(255);
	});

	test("upsampling a flat area keeps its colour; off-image reads black", () => {
		const src = solidImage(2, 2, BLUE);
		const out = allocRgba(4, 4);
		blitRgba(src, rect(0, 0, 2, 2), out, rect(0, 0, 4, 4));
		expect(pixelAt(out, 3, 3)).toEqual([0, 0, 255]);
		const off = allocRgba(2, 2);
		blitRgba(src, rect(5, 5, 2, 2), off, rect(0, 0, 2, 2));
		expect(pixelAt(off, 0, 0)).toEqual([0, 0, 0]);
	});

	test("rejects a dest outside the output", () => {
		expect(() => blitRgba(solidImage(2, 2, RED), rect(0, 0, 2, 2), allocRgba(2, 2), rect(1, 1, 2, 2))).toThrow(
			RangeError,
		);
	});
});

describe("ReplayCaptureSource (FrameSequenceSource)", () => {
	const frames = [solidImage(100, 50, RED), solidImage(100, 50, GREEN), solidImage(100, 50, BLUE)];

	test("one-shot capture crops the rect and reports the frame contract", async () => {
		const src = new ReplayCaptureSource([makeImage(100, 50, (x) => [x, 0, 0])]);
		const f = await src.capture(rect(10, 5, 20, 10));
		expect([f.width, f.height, f.scale]).toEqual([20, 10, 1]);
		expect(f.data.length).toBe(20 * 10 * 4);
		expect(pixelAt(f, 0, 0)).toEqual([10, 0, 0]);
		expect(f.displayIds).toEqual([1]);
		expect(f.partial).toBe(false);
		expect(src.displays()).toEqual([
			{ id: 1, bounds: rect(0, 0, 100, 50), workArea: rect(0, 0, 100, 50), scaleFactor: 1, isPrimary: true },
		]);
	});

	test("frames are valid OCR input", async () => {
		const f = await new ReplayCaptureSource([solidImage(30, 20, RED)]).capture(rect(0, 0, 30, 20));
		const img = toOcrImage(f);
		expect(img).toMatchObject({ width: 30, height: 20, stride: 120, format: "rgba8" });
		expect(validateOcrImage(img)).toBeNull();
	});

	test("a 2x display gives 2x output for a logical rect", async () => {
		const src = new ReplayCaptureSource([makeImage(200, 100, (x, y) => [x, y, 0])], {
			displays: [singleDisplay(200, 100, 2)],
		});
		const f = await src.capture(rect(10, 10, 20, 10));
		expect([f.width, f.height, f.scale]).toEqual([40, 20, 2]);
		expect(pixelAt(f, 0, 0)).toEqual([20, 20, 0]);
	});

	test("off-screen parts are opaque black and flagged partial", async () => {
		const src = new ReplayCaptureSource([solidImage(100, 50, RED)]);
		const f = await src.capture(rect(90, 0, 20, 10));
		expect(f.partial).toBe(true);
		expect(pixelAt(f, 5, 5)).toEqual([255, 0, 0]);
		expect(pixelAt(f, 15, 5)).toEqual([0, 0, 0]);
		expect(f.data[(5 * 20 + 15) * 4 + 3]).toBe(255);
	});

	test("a rect on no display is a no-display CaptureError", async () => {
		const src = new ReplayCaptureSource(frames);
		await expect(src.capture(rect(500, 500, 10, 10))).rejects.toMatchObject({ code: "no-display" });
		await expect(src.capture(rect(0, 0, 0, 10))).rejects.toBeInstanceOf(CaptureError);
	});

	test("per-grab sessions walk the frames, then hold the last with a stable sequence", async () => {
		const src = new ReplayCaptureSource(frames);
		const s = await src.openSession(rect(0, 0, 10, 10), { fps: 4 });
		const got = [];
		for (let i = 0; i < 5; i++) got.push(await s.next());
		expect(got.map((f) => pixelAt(f, 0, 0))).toEqual([
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[0, 0, 255],
			[0, 0, 255],
		]);
		expect(got.map((f) => f.sequence)).toEqual([1, 2, 3, 3, 3]);
		s.close();
		s.close();
		await expect(s.next()).rejects.toBeInstanceOf(CaptureError);
	});

	test("an identical repeated frame keeps the sequence (reads as unchanged)", async () => {
		const src = new ReplayCaptureSource([solidImage(20, 20, RED), solidImage(20, 20, RED), solidImage(20, 20, BLUE)], {
			end: "loop",
		});
		const s = await src.openSession(rect(0, 0, 10, 10), { fps: 4 });
		const seq = [];
		for (let i = 0; i < 7; i++) seq.push((await s.next()).sequence);
		// R R B | R R B | R
		expect(seq).toEqual([1, 1, 2, 3, 3, 4, 5]);
	});

	test("loop mode wraps and keeps the sequence increasing", async () => {
		const src = new ReplayCaptureSource(frames, { end: "loop" });
		const s = await src.openSession(rect(0, 0, 10, 10), { fps: 4 });
		const seq = [];
		for (let i = 0; i < 4; i++) seq.push((await s.next()).sequence);
		expect(seq).toEqual([1, 2, 3, 4]);
		expect(rgbaHash(await s.next())).toBe(rgbaHash(solidImage(10, 10, GREEN)));
	});

	test("timed mode picks the frame by elapsed time and holdMs", async () => {
		const clock = new ManualClock(1000);
		const src = new ReplayCaptureSource(
			[
				{ image: frames[0] ?? solidImage(1, 1, RED), holdMs: 100 },
				{ image: frames[1] ?? solidImage(1, 1, RED), holdMs: 300 },
				{ image: frames[2] ?? solidImage(1, 1, RED), holdMs: 100 },
			],
			{ advance: "timed", now: clock.now },
		);
		const s = await src.openSession(rect(0, 0, 10, 10), { fps: 4 });
		const at = async (ms: number) => {
			clock.set(1000 + ms);
			return pixelAt(await s.next(), 0, 0);
		};
		expect(await at(0)).toEqual([255, 0, 0]);
		expect(await at(99)).toEqual([255, 0, 0]);
		expect(await at(100)).toEqual([0, 255, 0]);
		expect(await at(399)).toEqual([0, 255, 0]);
		expect(await at(400)).toEqual([0, 0, 255]);
		expect(await at(10_000)).toEqual([0, 0, 255]);
		expect((await s.next()).capturedAt).toBe(11_000);
	});

	test("dispose closes sessions; exclusion list is recorded", async () => {
		const src = new ReplayCaptureSource(frames);
		const s = await src.openSession(rect(0, 0, 10, 10), { fps: 2 });
		src.setExcludedWindows([7, 9]);
		expect(src.excludedWindows).toEqual([7, 9]);
		expect(src.exclusion).toBe("none");
		src.dispose();
		await expect(s.next()).rejects.toBeInstanceOf(CaptureError);
		await expect(src.capture(rect(0, 0, 1, 1))).rejects.toMatchObject({ code: "unavailable" });
	});

	test("openSession validates fps and rect", async () => {
		const src = new ReplayCaptureSource(frames);
		await expect(src.openSession(rect(0, 0, 10, 10), { fps: 0 })).rejects.toMatchObject({ code: "invalid-argument" });
		await expect(src.openSession(rect(900, 900, 10, 10), { fps: 2 })).rejects.toMatchObject({ code: "no-display" });
	});
});
