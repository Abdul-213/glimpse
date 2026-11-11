// GLIM-98/164: with "Show Glimpse in screen sharing and recordings" on (`hide` false below),
// Glimpse's own capture paints over its popups and Settings before OCR. Exercised over the
// file backend's sample recording.
import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { type CaptureFrame, type CaptureSource, maskFrame, type Rect, rect } from "@glimpse/core";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { MaskedCaptureSource, unionRects } from "../src/bun/services/capture/masked.ts";
import { CaptureExclusion, type ExclusionOps, frameBounds } from "../src/bun/windows/capture-exclusion.ts";

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

describe("GLIM-164: what Glimpse never reads with Show in screen sharing on (Windows)", () => {
	const region = rect(20, 15, 160, 90);

	test("a popup dragged during a capture is painted over where it was and where it went", async () => {
		const file = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const from = rect(30, 20, 50, 30);
		const to = rect(110, 60, 50, 30);
		let popupAt = from;
		// The backend grabs the screen with the popup at `from`; the drag lands before it returns.
		const dragging: CaptureSource = {
			backend: file.backend,
			exclusion: file.exclusion,
			displays: () => file.displays(),
			capture: async (r, o) => {
				const frame = await file.capture(r, o);
				popupAt = to;
				return frame;
			},
			openSession: (r, o) => file.openSession(r, o),
			setExcludedWindows: (ids) => file.setExcludedWindows(ids),
			dispose: () => file.dispose(),
		};
		const exclusion = new CaptureExclusion(windowsOps, { setExcludedWindows: () => {} });
		exclusion.setHideFromCapture(false);
		exclusion.protect(fakeWindow(7), undefined, { role: "popup", bounds: () => popupAt });
		const raw = await file.capture(region);
		expect(flat(raw, from)).toBe(false);
		const masked = await new MaskedCaptureSource(dragging, () => exclusion.maskRects()).capture(region);
		expect(flat(masked, from)).toBe(true);
		expect(flat(masked, to)).toBe(true);
	});

	test("Settings (a `window`) is painted over from its own frame while it is open, and not once closed", async () => {
		let frame = { x: 40, y: 30, width: 60, height: 40 };
		const closers: (() => void)[] = [];
		const settingsWindow = {
			ptr: 9 as unknown as Pointer,
			on: (_: "close", h: (event: unknown) => void) => {
				closers.push(() => h(null));
			},
			getFrame: () => frame,
		};
		const exclusion = new CaptureExclusion(windowsOps, { setExcludedWindows: () => {} });
		exclusion.setHideFromCapture(false);
		exclusion.protect(settingsWindow, undefined, { role: "window", bounds: frameBounds(settingsWindow) });
		const screen = new MaskedCaptureSource(createFileCaptureSource(SAMPLE_FRAMES_DIR), () => exclusion.maskRects());
		expect(flat(await screen.capture(region), rect(40, 30, 60, 40))).toBe(true);
		// Moved by the user: the new place is read from the window on the next capture.
		frame = { x: 100, y: 50, width: 60, height: 40 };
		expect(exclusion.maskRects()).toEqual([rect(100, 50, 60, 40)]);
		for (const c of closers) c();
		expect(exclusion.maskRects()).toEqual([]);
	});

	test("frameBounds: null when the window can't say or has no size", () => {
		expect(frameBounds({ getFrame: () => ({ x: 1, y: 2, width: 3, height: 4 }) })()).toEqual(rect(1, 2, 3, 4));
		expect(frameBounds({ getFrame: () => ({ x: 1, y: 2, width: 0, height: 4 }) })()).toBeNull();
		expect(frameBounds({ getFrame: () => ({ x: Number.NaN, y: 2, width: 3, height: 4 }) })()).toBeNull();
		const closed = {
			getFrame: (): { x: number; y: number; width: number; height: number } => {
				throw new Error("closed");
			},
		};
		expect(frameBounds(closed)()).toBeNull();
	});

	test("unionRects keeps both positions and drops a rect that didn't move", () => {
		const a = rect(0, 0, 10, 10);
		const b = rect(20, 0, 10, 10);
		expect(unionRects([a], [a])).toEqual([a]);
		expect(unionRects([a], [b])).toEqual([a, b]);
		expect(unionRects([], [b])).toEqual([b]);
	});
});
