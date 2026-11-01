// GLIM-98: with "Hide Glimpse from screenshots and screen sharing" off, Glimpse's own capture
// paints over its popups before OCR. Exercised over the file backend's sample recording.
import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { type CaptureFrame, maskFrame, type Rect, rect } from "@glimpse/core";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { MaskedCaptureSource } from "../src/bun/services/capture/masked.ts";
import { CaptureExclusion, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";

const px = (f: CaptureFrame, x: number, y: number) => [
	...f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 4),
];

/** Every pixel of `f` inside `r` (global logical) has one colour. */
function flat(f: CaptureFrame, r: Rect): boolean {
	const x0 = Math.round((r.x - f.rect.x) * f.scale);
	const y0 = Math.round((r.y - f.rect.y) * f.scale);
	const first = px(f, x0, y0).join();
	for (let y = y0; y < y0 + r.height * f.scale; y++) {
		for (let x = x0; x < x0 + r.width * f.scale; x++) if (px(f, x, y).join() !== first) return false;
	}
	return true;
}

/** Windows-like ops: the flag is the only thing keeping a window out of frames. */
const windowsOps: ExclusionOps = {
	exclude: (h) => ({ excluded: true, windowId: Number(h), detail: "WDA_EXCLUDEFROMCAPTURE" }),
	windowId: (h) => Number(h),
	setHidden: (_h, hidden) => ({ excluded: hidden, detail: hidden ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" }),
	ownCaptureSkipsIds: false,
};

const fakeWindow = (n: number) => ({ ptr: n as unknown as Pointer, on: () => {} });

describe("maskFrame", () => {
	const frame = (): CaptureFrame => {
		const data = new Uint8Array(4 * 4 * 4);
		for (let i = 0; i < 16; i++) data.set([i * 10, 0, 0, 255], i * 4);
		return {
			width: 4,
			height: 4,
			data,
			rect: rect(10, 10, 2, 2),
			scale: 2,
			displayIds: [1],
			partial: false,
			sequence: 1,
			capturedAt: 0,
		};
	};

	test("paints the overlap with the colour just outside it, without touching the input", () => {
		const f = frame();
		const out = maskFrame(f, [rect(10.5, 10.5, 5, 5)]);
		expect(out).not.toBe(f);
		expect(px(f, 1, 1)).toEqual([50, 0, 0, 255]); // input untouched
		for (const [x, y] of [
			[1, 1],
			[3, 3],
			[2, 1],
		] as const)
			expect(px(out, x, y)).toEqual([0, 0, 0, 255]); // pixel (0,0)'s colour
		expect(px(out, 1, 0)).toEqual([10, 0, 0, 255]);
	});

	test("a rect off the frame returns the same frame", () => {
		const f = frame();
		expect(maskFrame(f, [rect(100, 100, 10, 10)])).toBe(f);
		expect(maskFrame(f, [])).toBe(f);
	});
});

describe("MaskedCaptureSource over the file backend", () => {
	const region = rect(20, 15, 160, 90);
	const popupAt = rect(60, 40, 80, 30);

	async function grab(hide: boolean) {
		const exclusion = new CaptureExclusion(windowsOps, { setExcludedWindows: () => {} });
		exclusion.setHideFromCapture(hide);
		exclusion.protect(fakeWindow(42), undefined, { role: "popup", bounds: () => popupAt });
		const screen = new MaskedCaptureSource(createFileCaptureSource(SAMPLE_FRAMES_DIR), () => exclusion.maskRects());
		const raw = await createFileCaptureSource(SAMPLE_FRAMES_DIR).capture(region);
		return { raw, masked: await screen.capture(region), screen };
	}

	test("setting on: the popup is flagged, frames pass through untouched", async () => {
		const { raw, masked } = await grab(true);
		expect(masked.data).toEqual(raw.data);
	});

	test("setting off: the popup's area is flat (nothing to OCR), everything else is unchanged", async () => {
		const { raw, masked } = await grab(false);
		expect(flat(raw, popupAt)).toBe(false); // the recording has content there
		expect(flat(masked, popupAt)).toBe(true);
		expect(px(masked, 2, 2)).toEqual(px(raw, 2, 2));
		const s = masked.scale;
		const right = Math.ceil((popupAt.x + popupAt.width - region.x) * s) + 1;
		expect(px(masked, right, 60)).toEqual(px(raw, right, 60));
	});

	test("Live sessions are masked too", async () => {
		const { screen } = await grab(false);
		const session = await screen.openSession(region, { fps: 3 });
		expect(flat(await session.next(), popupAt)).toBe(true);
		session.close();
	});
});
