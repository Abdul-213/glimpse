// GLIM-156: "Snip works once, then every Snip says Glimpse couldn't capture this area."
//
// The real window lifecycle, minus Electrobun: the real PickerController and SnipPopupController
// wired as in app/src/bun/index.ts (hotkey → picker → RegionSelected → popup → pipeline, the
// overlays kept up as the results layer, Esc / hotkey / Snip again / Live), the real
// CaptureExclusion and MaskedCaptureSource, and the real core pipeline (an all-black frame is
// E4 captureBlank). Under them, a model of the OS compositor that Glimpse's capture reads:
//
//   windows  WDA_EXCLUDEFROMCAPTURE leaves a shown window out of GDI / DXGI frames, but a window
//            that was hidden and is shown again comes back as a black box in them (the suspected
//            GLIM-156 mechanism: what Electron's content-protection code works around with
//            WS_EX_LAYERED, which a transparent WebView2 can't use; not reproduced on a GPU-less
//            CI runner). The picker overlays cover their whole display, so with that behaviour
//            the old code made every Snip after the first all black, which is the owner's report.
//   macos    the ScreenCaptureKit filter leaves every Glimpse window out, shown or re-shown.
//
// Overlays here behave like ElectrobunOverlay (windows/picker.ts): created hidden, protected
// through CaptureExclusion on their first show only, then plain show / hide.
import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import {
	type CaptureFrame,
	type CaptureSession,
	type CaptureSource,
	createLogger,
	type Display,
	languageCode,
	NO_MODIFIERS,
	type PickerViewState,
	type Rect,
	type ResultsLayerState,
	rect,
	TranslationPipeline,
} from "@glimpse/core";
import {
	FakePointer,
	FakeTranslationProvider,
	MemoryLogSink,
	RecordingFocusKeeper,
	SolidPixelSampler,
	StaticWindowList,
} from "@glimpse/core/testing";
import { blackRatio, reportingCapture } from "../src/bun/services/capture/capture-report.ts";
import { MaskedCaptureSource } from "../src/bun/services/capture/masked.ts";
import { CaptureExclusion, type ExcludableWindow, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";
import {
	EXIT_FADE_MS,
	type OverlayFactory,
	type OverlayWindow,
	PickerController,
} from "../src/bun/windows/picker-controller.ts";
import { PAINT_TIMEOUT_MS, SnipPopupController } from "../src/bun/windows/popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";
import { DEFAULT_POPUP_SETTINGS, FakePopupWindow, pipelineRunner } from "../src/harness/popup.ts";
import { scriptedOcr } from "../src/harness/providers.ts";
import type { PickerLoupeMessage, PickerOpenInfo } from "../src/shared/rpc.ts";

type OS = "windows" | "macos";
const WDA_NONE = 0;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const W = 1280;
const H = 800;
const DESK: Display[] = [
	{ id: 1, bounds: rect(0, 0, W, H), workArea: rect(0, 0, W, H - 40), scaleFactor: 1, isPrimary: true },
];
const REGION = rect(200, 150, 240, 80);

// ---- the OS compositor model ------------------------------------------------------------

class ModelWindow implements ExcludableWindow {
	readonly ptr: Pointer;
	visible = false;
	affinity = WDA_NONE;
	shows = 0;
	/** Hidden at least once after a show: the next show is a re-show. */
	private hiddenAfterShow = false;
	/** Re-shown after a hide (GLIM-156 on Windows). */
	reshown = false;
	closed = false;
	private readonly closeHandlers: ((e: unknown) => void)[] = [];

	constructor(
		readonly id: number,
		readonly bounds: Rect,
		/** What the window draws where it is not excluded (the picker scrim, a card...). */
		readonly paint: readonly [number, number, number],
	) {
		this.ptr = id as unknown as Pointer;
	}
	on(_name: "close", handler: (event: unknown) => void): void {
		this.closeHandlers.push(handler);
	}
	show(): void {
		if (this.hiddenAfterShow) this.reshown = true;
		this.visible = true;
		this.shows++;
	}
	hide(): void {
		if (this.visible) this.hiddenAfterShow = true;
		this.visible = false;
	}
	close(): void {
		this.closed = true;
		this.visible = false;
		for (const h of this.closeHandlers) h({});
	}
}

/** What the capture backend reads: the desktop, plus every Glimpse window the OS lets in. */
class Compositor implements CaptureSource {
	readonly windows: ModelWindow[] = [];
	readonly desktop = new Uint8Array(W * H * 4);
	sessions = 0;
	private nextId = 1;
	private seq = 0;

	constructor(readonly os: OS) {
		// A busy, never-black desktop.
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				this.desktop[i] = 40 + ((x * 7 + y * 3) % 200);
				this.desktop[i + 1] = 40 + ((x * 3 + y * 5) % 200);
				this.desktop[i + 2] = 40 + ((x + y) % 200);
				this.desktop[i + 3] = 255;
			}
		}
	}

	get backend() {
		return this.os === "windows" ? "model-gdi" : "model-sck";
	}
	get exclusion() {
		return this.os === "windows" ? ("window-flag" as const) : ("filter" as const);
	}

	window(bounds: Rect, paint: readonly [number, number, number]): ModelWindow {
		const w = new ModelWindow(this.nextId++, bounds, paint);
		this.windows.push(w);
		return w;
	}
	byPtr(p: Pointer): ModelWindow {
		const w = this.windows.find((x) => x.ptr === p);
		if (!w) throw new Error("unknown window");
		return w;
	}

	/** How the OS draws `w` into a capture: left out, black, or its own pixels. */
	private appearance(w: ModelWindow): "out" | "black" | "drawn" {
		if (!w.visible || w.closed) return "out";
		if (this.os === "macos") return "out"; // the SCK filter excludes Glimpse's app
		if (w.affinity !== WDA_EXCLUDEFROMCAPTURE) return "drawn";
		return w.reshown ? "black" : "out";
	}

	displays(): readonly Display[] {
		return DESK;
	}
	async capture(r: Rect): Promise<CaptureFrame> {
		const width = Math.round(r.width);
		const height = Math.round(r.height);
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			const src = ((r.y + y) * W + r.x) * 4;
			data.set(this.desktop.subarray(src, src + width * 4), y * width * 4);
		}
		for (const w of this.windows) {
			const how = this.appearance(w);
			if (how === "out") continue;
			const rgb = how === "black" ? ([0, 0, 0] as const) : w.paint;
			const x0 = Math.max(r.x, w.bounds.x);
			const y0 = Math.max(r.y, w.bounds.y);
			const x1 = Math.min(r.x + width, w.bounds.x + w.bounds.width);
			const y1 = Math.min(r.y + height, w.bounds.y + w.bounds.height);
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) data.set([...rgb, 255], ((y - r.y) * width + (x - r.x)) * 4);
			}
		}
		return {
			width,
			height,
			data,
			rect: r,
			scale: 1,
			displayIds: [1],
			partial: false,
			sequence: ++this.seq,
			capturedAt: 0,
		};
	}
	async openSession(r: Rect): Promise<CaptureSession> {
		this.sessions++;
		return { rect: r, next: () => this.capture(r), close: () => {} };
	}
	setExcludedWindows(): void {}
	dispose(): void {}
}

/** The OS calls CaptureExclusion makes (native/exclusion.ts), against the model. */
function exclusionOps(screen: Compositor): ExclusionOps {
	return {
		exclude(handle) {
			const w = screen.byPtr(handle);
			w.affinity = WDA_EXCLUDEFROMCAPTURE;
			return { excluded: true, windowId: w.id, detail: "WDA_EXCLUDEFROMCAPTURE" };
		},
		windowId: (handle) => screen.byPtr(handle).id,
		setHidden(handle, hidden) {
			const w = screen.byPtr(handle);
			w.affinity = hidden ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;
			return { excluded: hidden, detail: hidden ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" };
		},
		state: (handle) => `0x${screen.byPtr(handle).affinity.toString(16)}`,
		ownCaptureSkipsIds: screen.os === "macos",
	};
}

/** ElectrobunOverlay (windows/picker.ts) over a model window: protected on its first show only. */
class ModelOverlay implements OverlayWindow {
	private protectedOnce = false;
	private level: "picking" | "belowPopup" = "picking";
	resultsSent: (ResultsLayerState | null)[] = [];
	constructor(
		readonly display: Display,
		readonly win: ModelWindow,
		private readonly exclusion: CaptureExclusion,
	) {}
	reset(_info: PickerOpenInfo): void {}
	state(_view: PickerViewState): void {}
	loupe(_m: PickerLoupeMessage): void {}
	fadeOut(_animate: boolean): void {}
	show(_activate: boolean): void {
		if (!this.protectedOnce) {
			this.protectedOnce = true;
			this.exclusion.protect(this.win, () => this.win.show(), { role: "surface" });
		} else {
			this.win.show();
		}
	}
	hide(): void {
		this.win.hide();
	}
	setLevel(level: "picking" | "belowPopup"): void {
		this.level = level;
	}
	results(state: ResultsLayerState | null): void {
		this.resultsSent.push(state);
	}
	close(): void {
		this.win.close();
	}
	diagnostics(): Record<string, unknown> {
		return {
			visible: this.win.visible,
			level: this.level,
			shows: this.win.shows,
			capture: this.exclusion.describe(this.win),
		};
	}
}

// ---- the app, wired like index.ts -----------------------------------------------------------

interface AppOptions {
	readonly os: OS;
	readonly reducedMotion?: boolean;
	/** Settings › General › Show translations on screen (GLIM-152 cards on the overlays). */
	readonly showOnScreen?: boolean;
	/** Override the platform default (index.ts: Windows only). */
	readonly recycle?: boolean;
}

async function app(o: AppOptions) {
	const screen = new Compositor(o.os);
	const exclusion = new CaptureExclusion(exclusionOps(screen), screen);
	const masked = new MaskedCaptureSource(screen, () => exclusion.maskRects());
	const sink = new MemoryLogSink();
	const log = createLogger({ sinks: [sink], level: "debug" });
	const scheduler = new ManualScheduler();
	const pointer = new FakePointer({ x: 10, y: 10 });
	const overlays: ModelOverlay[] = [];
	const factory: OverlayFactory = {
		create(display) {
			// The scrim is dark grey, not black: a leaked overlay reads as grey, a GLIM-156 one as black.
			const ov = new ModelOverlay(display, screen.window(display.bounds, [30, 30, 30]), exclusion);
			overlays.push(ov);
			return ov;
		},
	};
	let popup: SnipPopupController | null = null;
	const picker: PickerController = new PickerController({
		factory,
		displays: () => DESK,
		probe: pointer,
		windows: new StaticWindowList([]),
		sampler: new SolidPixelSampler(),
		focus: new RecordingFocusKeeper(),
		os: o.os,
		log: log.child("picker"),
		now: scheduler.now,
		scheduler,
		settings: () => ({ confirmOnRelease: true, showLoupe: true, reducedMotion: o.reducedMotion ?? false }),
		recycleOverlays: o.recycle ?? o.os === "windows",
	});
	picker.prepare();
	const ocr = scriptedOcr(["明日の会議は午後三時に始まります。"]);
	await ocr.init();
	const tr = new FakeTranslationProvider({ pivot: "en", capabilities: { streaming: false } });
	await tr.init();
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
	const snipScreen = reportingCapture(masked, {
		log: log.child("capture"),
		context: () => ({ overlays: picker.overlayStates() }),
	});
	const popupWindow = new FakePopupWindow();
	popup = new SnipPopupController({
		window: popupWindow,
		displays: () => DESK,
		runner: pipelineRunner(snipScreen, pipeline, { to: languageCode("en") }),
		focus: new RecordingFocusKeeper(),
		results: { dismiss: () => picker.dismiss(), showBoxes: (s) => picker.showResults(s) },
		targets: { snipAgain: () => picker.toggle("snip"), openSettings: () => {}, openExternal: () => {} },
		settings: () => ({
			...DEFAULT_POPUP_SETTINGS,
			reducedMotion: o.reducedMotion ?? false,
			showOnScreen: o.showOnScreen ?? false,
		}),
		scheduler,
		log: log.child("popup"),
	});
	const liveFrames: number[] = [];
	picker.onRegionSelected((region) => {
		if (region.mode === "snip") return popup?.open(region.rect) ? "keep" : undefined;
		// Live: a capture session over the pinned region (DXGI on Windows, an SCStream on macOS).
		void masked.openSession(region.rect, { fps: 4 }).then(async (s) => {
			liveFrames.push(blackRatio((await s.next()).data));
			s.close();
		});
		return undefined;
	});

	const settle = async () => {
		for (let i = 0; i < 5; i++) await Bun.sleep(1);
	};
	/** The Snip hotkey (index.ts commands): close an open popup, then toggle the picker. */
	const hotkey = (mode: "snip" | "live" = "snip") => {
		popup?.dismiss(null, "hotkey");
		picker.toggle(mode);
	};
	/** Drag the region on the overlay under the pointer. */
	const drag = async (r: Rect = REGION) => {
		const p = (phase: "down" | "move" | "up", x: number, y: number) => ({
			displayId: 1,
			phase,
			x,
			y,
			button: 0,
			detail: 1,
			mods: NO_MODIFIERS,
		});
		pointer.at = { x: r.x, y: r.y };
		pointer.down = true;
		picker.viewPointer(p("down", r.x, r.y));
		pointer.at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		picker.viewPointer(p("move", pointer.at.x, pointer.at.y));
		pointer.at = { x: r.x + r.width, y: r.y + r.height };
		pointer.down = false;
		picker.viewPointer(p("up", pointer.at.x, pointer.at.y));
		await settle();
		scheduler.advance(PAINT_TIMEOUT_MS);
		await settle();
	};
	/** The popup's state after a Snip: its whole-run error, or null. */
	const snipError = () => popupWindow.last?.state.error ?? null;
	const esc = async () => {
		const id = popupWindow.last?.state.requestId;
		if (id) popup?.dismiss(id, "esc");
		scheduler.advance(EXIT_FADE_MS + 1);
		await settle();
	};
	/** One full Snip by hotkey: pick, wait for the run, return the popup's error (null = translated). */
	const snip = async () => {
		hotkey("snip");
		await drag();
		return { error: snipError(), phase: popupWindow.last?.state.phase };
	};
	return { screen, picker, popup, popupWindow, overlays, sink, scheduler, hotkey, drag, esc, snip, settle, liveFrames };
}

// ---- the lifecycle -----------------------------------------------------------------------

describe.each(["windows", "macos"] as const)("Snip lifecycle on %s (GLIM-156)", (os) => {
	test.each([
		{ reducedMotion: false, showOnScreen: false },
		{ reducedMotion: true, showOnScreen: false },
		{ reducedMotion: false, showOnScreen: true },
		{ reducedMotion: true, showOnScreen: true },
	])("two, three and ten Snips in a row, closed with Esc (%o)", async (opts) => {
		const a = await app({ os, ...opts });
		for (let i = 1; i <= 10; i++) {
			const r = await a.snip();
			expect({ snip: i, ...r }).toEqual({ snip: i, error: null, phase: "done" });
			await a.esc();
			// Nothing of Glimpse's is left on screen between Snips.
			expect(a.screen.windows.filter((w) => w.visible)).toEqual([]);
		}
	});

	test.each([false, true])(
		"ten Snips, each started by the hotkey over the open popup (reduced motion %p)",
		async (reducedMotion) => {
			const a = await app({ os, reducedMotion, showOnScreen: true });
			for (let i = 1; i <= 10; i++) {
				const r = await a.snip(); // the hotkey closes the previous popup and its results layer
				expect({ snip: i, ...r }).toEqual({ snip: i, error: null, phase: "done" });
			}
		},
	);

	test("Snip again from the popup, then Esc and the hotkey", async () => {
		const a = await app({ os });
		expect((await a.snip()).error).toBeNull();
		a.popup?.action(a.popupWindow.last?.state.requestId ?? "", "snipAgain");
		await a.drag();
		expect(a.popupWindow.last?.state.error).toBeNull();
		await a.esc();
		expect((await a.snip()).error).toBeNull();
	});

	test("a cancelled picker, a Live pick, then Snips", async () => {
		const a = await app({ os });
		a.hotkey("snip");
		a.picker.cancel("escape");
		a.scheduler.advance(EXIT_FADE_MS + 1);
		await a.settle();
		a.hotkey("live");
		await a.drag(rect(600, 300, 200, 100));
		a.scheduler.advance(EXIT_FADE_MS + 1);
		await a.settle();
		expect(a.liveFrames).toHaveLength(1);
		expect(a.liveFrames[0]).toBe(0);
		for (let i = 0; i < 3; i++) {
			expect((await a.snip()).error).toBeNull();
			await a.esc();
		}
		// Live again after Snips, then Snip.
		a.hotkey("live");
		await a.drag(rect(600, 300, 200, 100));
		a.scheduler.advance(EXIT_FADE_MS + 1);
		await a.settle();
		expect(a.liveFrames[1]).toBe(0);
		expect((await a.snip()).error).toBeNull();
	});

	test("every Snip capture is logged with its black ratio and the overlay states", async () => {
		const a = await app({ os });
		await a.snip();
		await a.esc();
		await a.snip();
		const lines = a.sink.records.filter((r) => r.scope === "capture" && r.message.startsWith("snip capture"));
		expect(lines).toHaveLength(2);
		for (const l of lines) {
			expect(l.message).toBe("snip capture");
			expect(l.fields).toMatchObject({ backend: a.screen.backend, rect: "200,150 240x80", blackRatio: 0 });
			const overlays = l.fields["overlays"] as { displayId: number; visible: boolean; capture: string }[];
			expect(overlays).toHaveLength(1);
			expect(overlays[0]).toMatchObject({ displayId: 1, visible: true, capture: "0x11" });
		}
	});
});

describe("GLIM-156 root cause, on the model", () => {
	test("Windows without recycled overlays: the first Snip works, every later one is all black", async () => {
		const a = await app({ os: "windows", recycle: false });
		expect((await a.snip()).error).toBeNull();
		await a.esc();
		for (let i = 0; i < 3; i++) {
			expect((await a.snip()).error).toBe("captureBlank");
			await a.esc();
		}
		// The log line names the cause: an excluded overlay, shown again, and a fully black frame.
		const black = a.sink.records.filter((r) => r.message === "snip capture came back black");
		expect(black).toHaveLength(3);
		expect(black[0]?.fields).toMatchObject({ blackRatio: 1, backend: "model-gdi" });
		expect(black[0]?.fields["overlays"]).toEqual([
			expect.objectContaining({ displayId: 1, visible: true, shows: 2, capture: "0x11" }),
		]);
	});

	test("Windows: each show of an overlay is its first; hidden ones are closed and replaced", async () => {
		const a = await app({ os: "windows" });
		for (let i = 0; i < 3; i++) {
			await a.snip();
			await a.esc();
		}
		const overlays = a.screen.windows.filter((w) => w.paint[0] === 30);
		expect(overlays.every((w) => w.shows <= 1 && !w.reshown)).toBe(true);
		expect(overlays.filter((w) => !w.closed)).toHaveLength(1); // one fresh, hidden one per display
		expect(overlays.filter((w) => !w.closed)[0]?.visible).toBe(false);
	});

	test("macOS keeps its overlays: the SCK filter leaves them out however often they are shown", async () => {
		const a = await app({ os: "macos" });
		for (let i = 0; i < 3; i++) {
			await a.snip();
			await a.esc();
		}
		expect(a.overlays).toHaveLength(1);
		expect(a.screen.windows[0]?.shows).toBe(3);
	});
});

describe("blackRatio", () => {
	test("all black, none, half", () => {
		expect(blackRatio(new Uint8Array([0, 0, 0, 255, 2, 2, 2, 0]))).toBe(1);
		expect(blackRatio(new Uint8Array([3, 0, 0, 255, 0, 0, 9, 255]))).toBe(0);
		expect(blackRatio(new Uint8Array([0, 0, 0, 255, 200, 10, 10, 255]))).toBe(0.5);
		expect(blackRatio(new Uint8Array(0))).toBe(1);
	});
});
