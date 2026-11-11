// GLIM-128: the docked Live popup registers with CaptureExclusion as a `popup` with its
// on-screen frame (GLIM-98). With "Show Glimpse in screen sharing" on (GLIM-164), Windows can't keep the
// popup out of Glimpse's own frames by flag, so MaskedCaptureSource paints its frame over: a
// Live region under the popup (the "inside" docking of a full-screen pin) never reads the
// popup's text. File backend, sample recording.
import type { Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { type CaptureFrame, type LiveSessionEvent, nullLogger, type Rect } from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { MaskedCaptureSource } from "../src/bun/services/capture/masked.ts";
import { CaptureExclusion, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";
import { LivePopupController } from "../src/bun/windows/live-popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";

const windowsOps: ExclusionOps = {
	exclude: (h) => ({ excluded: true, windowId: Number(h), detail: "WDA_EXCLUDEFROMCAPTURE" }),
	windowId: (h) => Number(h),
	setHidden: (_h, hidden) => ({ excluded: hidden, detail: hidden ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" }),
	ownCaptureSkipsIds: false,
};

function flat(f: CaptureFrame, r: Rect): boolean {
	const at = (x: number, y: number) => f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 4).join();
	const x0 = Math.round((r.x - f.rect.x) * f.scale);
	const y0 = Math.round((r.y - f.rect.y) * f.scale);
	const x1 = Math.min(f.width, Math.round((r.x + r.width - f.rect.x) * f.scale));
	const y1 = Math.min(f.height, Math.round((r.y + r.height - f.rect.y) * f.scale));
	const first = at(x0, y0);
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (at(x, y) !== first) return false;
	return true;
}

async function setup(hideFromCapture: boolean) {
	const files = createFileCaptureSource(SAMPLE_FRAMES_DIR);
	const display = files.displays().find((d) => d.isPrimary);
	if (!display) throw new Error("no primary display in the sample recording");
	const exclusion = new CaptureExclusion(windowsOps, { setExcludedWindows: () => {} });
	exclusion.setHideFromCapture(hideFromCapture);
	const bus: { listener: ((e: LiveSessionEvent) => void) | null } = { listener: null };
	let popup: LivePopupController | null = null;
	const win = { ptr: 7 as unknown as Pointer, on: () => {} };
	// The Electrobun window's part: protect on first show, with the controller's frame as bounds.
	let protectedOnce = false;
	const window = {
		setFrame: () => {},
		showInactive: () => {
			if (protectedOnce) return;
			protectedOnce = true;
			exclusion.protect(win, undefined, { role: "popup", bounds: () => popup?.frame ?? null });
		},
		activate: () => {},
		hide: () => {},
		send: () => {},
		focusControls: () => {},
	};
	popup = new LivePopupController({
		window,
		live: {
			onEvent: (l) => {
				bus.listener = l;
				return () => {};
			},
			active: true,
			pause: () => {},
			resume: () => {},
			stop: () => {},
			answerConsent: () => {},
			highlightBlock: () => {},
			setPopupVisible: () => {},
		},
		displays: () => [display],
		settings: () => ({ reducedMotion: true, uiDir: "ltr" }),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log: nullLogger,
		scheduler: new ManualScheduler(),
	});
	// A full-screen pin: the popup docks inside the region (live-popup.md §3 last resort).
	const region = display.bounds;
	bus.listener?.({
		type: "opened",
		sessionId: "s",
		region,
		providers: { cloud: null, localOnly: false },
		private: false,
	});
	popup.painted("s");
	const screen = new MaskedCaptureSource(files, () => exclusion.maskRects());
	return { popup, region, screen, files };
}

test("the Live popup is a `popup` with its on-screen frame; masked out of Live frames with the setting off", async () => {
	const { popup, region, screen, files } = await setup(false);
	expect(popup.placement?.side).toBe("inside");
	const frame = popup.frame;
	if (!frame) throw new Error("popup not on screen");
	const raw = await (await files.openSession(region, { fps: 3 })).next();
	expect(flat(raw, frame)).toBe(false); // the recording has content under the popup
	const session = await screen.openSession(region, { fps: 3 });
	expect(flat(await session.next(), frame)).toBe(true);
	session.close();
});

test("setting on: the popup is flagged, Live frames pass through untouched; hidden popup has no bounds", async () => {
	const { popup, region, screen, files } = await setup(true);
	const raw = await (await files.openSession(region, { fps: 3 })).next();
	const masked = await (await screen.openSession(region, { fps: 3 })).next();
	expect(masked.data).toEqual(raw.data);
	popup.setHidden(true);
	expect(popup.frame).toBeNull();
});
