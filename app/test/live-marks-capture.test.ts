// GLIM-154: Live must never read its own overlay cards. The whole main-process stack (the real
// LiveService, PinnedFrame, LivePopupController and TranslationService) runs over the
// file-based capture backend: a desktop PNG with the manga fixture on it. A model of the OS
// compositor sits between the files and Live: it paints every on-screen Glimpse window into
// the captured frames unless the window is excluded from capture (what WDA_EXCLUDEFROMCAPTURE
// and the ScreenCaptureKit filter do on real hardware), and MaskedCaptureSource paints over
// un-flagged popups as in production (GLIM-98/164, here with "Show Glimpse in screen sharing" on). The OCR fake is
// pixel-honest: a line reads as its text only while its pixels match the pristine page, so any
// card or badge that leaked into a frame shows up as a garbled read and a feedback loop.
//
// The Live view's rasteriser is replaced by plain opaque bitmaps at the planned rects (the
// view's `planMarks`, so the geometry is the real one); what is under test is where they go.
import type { Pointer } from "bun:ffi";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	applySettingsPatch,
	type CaptureFrame,
	type CaptureOptions,
	type CaptureSession,
	type CaptureSessionOptions,
	type CaptureSource,
	createLogger,
	type Display,
	defaultSettings,
	type LanguageCode,
	liveMarks,
	type OcrBlock,
	type OcrImage,
	ProviderRegistry,
	type Rect,
	type RgbaImage,
	rect,
	type Settings,
} from "@glimpse/core";
import {
	fakeOcrFactory,
	fakeTranslationFactory,
	ManualTimers,
	MemoryLogSink,
	RecordingFocusKeeper,
} from "@glimpse/core/testing";
import {
	type FrameHandle,
	type FrameNativeBinding,
	type FramePointer,
	type FrameSprite,
	logicalFrameSpace,
} from "../src/bun/native/frame.ts";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { MaskedCaptureSource } from "../src/bun/services/capture/masked.ts";
import { decodePng, encodePng } from "../src/bun/services/capture/png.ts";
import { LiveService } from "../src/bun/services/live/live-service.ts";
import { PinnedFrame } from "../src/bun/services/live/pinned-frame.ts";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { TranslationService } from "../src/bun/services/translation/translation-service.ts";
import { CaptureExclusion, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";
import { LivePopupController } from "../src/bun/windows/live-popup-controller.ts";
import type { Scheduler } from "../src/bun/windows/picker-controller.ts";
import type { LiveMarkSprite, LiveStateMessage } from "../src/shared/live-rpc.ts";
import { type MarkTheme, planMarks } from "../src/views/live/marks.ts";

const ROOT = resolve(import.meta.dir, "../..");
const COMIC = decodePng(readFileSync(join(ROOT, "docs/samples/comic-ja.png")));
const LINES = JSON.parse(readFileSync(join(ROOT, "packages/core/test/fixtures/ocr-lines/comic-ja.json"), "utf8")) as {
	box: Rect;
	text: string;
}[];
/** Where the page sits on the 1280 x 900 desktop; the pinned region is the page. */
const PAGE_AT = { x: 40, y: 60 };
const REGION = rect(PAGE_AT.x, PAGE_AT.y, COMIC.width, COMIC.height);
const GARBLED = "■";

// ---- the desktop PNG for the file backend -------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "glim154-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DESKTOP = join(dir, "desktop.png");
{
	const W = 1280;
	const H = 900;
	const data = new Uint8Array(W * H * 4);
	for (let i = 0; i < W * H; i++) data.set([46, 48, 52, 255], i * 4);
	for (let y = 0; y < COMIC.height; y++) {
		const from = y * COMIC.width * 4;
		data.set(COMIC.data.subarray(from, from + COMIC.width * 4), ((y + PAGE_AT.y) * W + PAGE_AT.x) * 4);
	}
	const img: RgbaImage = { width: W, height: H, data };
	writeFileSync(DESKTOP, encodePng(img));
}

// ---- the OS: frame windows and the compositor -----------------------------------------------

/** The native frame helper, as the OS sees it: its sprites and its display affinity. */
class OsFrame implements FrameNativeBinding {
	sprites: readonly FrameSprite[] = [];
	visible = false;
	region: Rect | null = null;
	/** What GetWindowDisplayAffinity reads back (0x11 = WDA_EXCLUDEFROMCAPTURE). */
	constructor(
		readonly affinity: number,
		/** Does the compositor really leave the window out? (false: a flag that lies) */
		readonly honoured = affinity === 0x11,
	) {}
	pointer: FramePointer = { hover: -1, click: -1 };
	frameCreate(): FrameHandle {
		return 1n;
	}
	frameSetRect(_h: FrameHandle, region: Rect): void {
		this.region = region;
	}
	frameSetStyle(): void {}
	frameSetHighlight(): void {}
	frameShow(_h: FrameHandle, visible: boolean): void {
		this.visible = visible;
	}
	frameWindowId(): number {
		return 501;
	}
	frameDestroy(): void {
		this.visible = false;
		this.sprites = [];
	}
	frameInfo(): Record<string, number> {
		return { affinity: this.affinity, exStyle: 0, visible: this.visible ? 1 : 0 };
	}
	frameSetSprites(_h: FrameHandle, sprites: readonly FrameSprite[]): void {
		this.sprites = sprites;
	}
	framePointer(): FramePointer {
		const p = this.pointer;
		this.pointer = { hover: p.hover, click: -1 };
		return p;
	}
	/** What the compositor puts into other apps' (and Glimpse's) captures. */
	get captured(): readonly FrameSprite[] {
		return this.visible && !this.honoured ? this.sprites : [];
	}
}

/** Composites leaked windows (premultiplied RGBA, global logical rects, scale 1) into frames. */
class Compositor implements CaptureSource {
	constructor(
		private readonly inner: CaptureSource,
		private readonly leaked: () => readonly FrameSprite[],
	) {}
	get backend(): string {
		return this.inner.backend;
	}
	get exclusion() {
		return this.inner.exclusion;
	}
	displays(): readonly Display[] {
		return this.inner.displays();
	}
	async capture(r: Rect, o?: CaptureOptions): Promise<CaptureFrame> {
		return this.paint(await this.inner.capture(r, o));
	}
	async openSession(r: Rect, o: CaptureSessionOptions): Promise<CaptureSession> {
		const s = await this.inner.openSession(r, o);
		return { rect: s.rect, next: async () => this.paint(await s.next()), close: () => s.close() };
	}
	setExcludedWindows(ids: readonly number[]): void {
		this.inner.setExcludedWindows(ids);
	}
	dispose(): void {
		this.inner.dispose();
	}
	private paint(f: CaptureFrame): CaptureFrame {
		const sprites = this.leaked();
		if (sprites.length === 0) return f;
		const data = new Uint8Array(f.data);
		for (const s of sprites) {
			for (let y = 0; y < s.height; y++) {
				const fy = Math.round((s.rect.y - f.rect.y) * f.scale) + y;
				if (fy < 0 || fy >= f.height) continue;
				for (let x = 0; x < s.width; x++) {
					const fx = Math.round((s.rect.x - f.rect.x) * f.scale) + x;
					if (fx < 0 || fx >= f.width) continue;
					const si = (y * s.width + x) * 4;
					const a = (s.rgba[si + 3] ?? 0) / 255;
					if (a === 0) continue;
					const di = (fy * f.width + fx) * 4;
					for (let c = 0; c < 3; c++) data[di + c] = Math.round((s.rgba[si + c] ?? 0) + (data[di + c] ?? 0) * (1 - a));
				}
			}
		}
		return { ...f, data };
	}
}

// ---- the stack ----------------------------------------------------------------------------

const windowsOps: ExclusionOps = {
	exclude: (h) => ({ excluded: true, windowId: Number(h), detail: "WDA_EXCLUDEFROMCAPTURE" }),
	windowId: (h) => Number(h),
	setHidden: (_h, hidden) => ({ excluded: hidden, detail: hidden ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" }),
	ownCaptureSkipsIds: false,
};

const THEME: MarkTheme = {
	key: "t",
	hud: "#1c1c1e",
	hudText: "#f5f5f7",
	stroke: "#fff",
	hudShadow: "#0000004d",
	accent: "#0a63c9",
	onAccent: "#fff",
	surface: "#f5f5f7",
	text: "#1d1d1f",
	edge: "#0000001f",
	shadow: "#00000026",
	changeRest: "#0a63c90f",
	changeMark: "#0a63c9",
	radiusControl: 6,
	numericFont: "system-ui",
	translationWeight: "400",
};

/** The Live view, minus the canvas: the real plan, opaque bitmaps (cards light, badges dark). */
function fakeView(controller: () => LivePopupController | null) {
	let sentFor: string | null = null;
	const sent = new Set<string>();
	return (m: LiveStateMessage) => {
		const cfg = m.marks;
		if (!cfg || !m.state.region) return;
		if (sentFor !== m.sessionId) {
			sentFor = m.sessionId;
			sent.clear();
		}
		const planned = planMarks(liveMarks(m.state, { target: cfg.target as LanguageCode | null }), {
			region: m.state.region,
			uiDir: "ltr",
			uiLang: "en",
			scale: cfg.scale,
			peekAll: false,
			theme: THEME,
			cardType: () => ({ family: "system-ui", scale: 1, leading: 1.5 }),
			measure: (t, px) => [...t].length * px * 0.6,
		});
		const sprites: LiveMarkSprite[] = planned.map((p) => {
			const width = Math.ceil(p.rect.width * cfg.scale);
			const height = Math.ceil(p.rect.height * cfg.scale);
			const px = new Uint8Array(width * height * 4);
			const c = p.kind === "card" ? [245, 245, 247, 255] : [28, 28, 30, 255];
			for (let i = 0; i < width * height; i++) px.set(c, i * 4);
			const base = { key: p.key, id: p.id, kind: p.kind, ...p.rect, opacity: p.opacity };
			if (sent.has(p.key)) return base;
			sent.add(p.key);
			return { ...base, image: { width, height, data: Buffer.from(px).toString("base64") } };
		});
		controller()?.marks(m.sessionId, sprites);
	};
}

function schedulerOn(timers: ManualTimers): Scheduler {
	return {
		later(ms, fn) {
			const h = timers.setTimeout(fn, ms);
			return () => timers.clearTimeout(h);
		},
		every(ms, fn) {
			let h = timers.setTimeout(function tick() {
				fn();
				h = timers.setTimeout(tick, ms);
			}, ms);
			return () => timers.clearTimeout(h);
		},
	};
}

async function setup(os: OsFrame) {
	const timers = new ManualTimers(1_000_000);
	const files = createFileCaptureSource(DESKTOP, { now: timers.now });
	const displays = files.displays();
	// OCR that only reads what is really on the page: a line whose pixels changed reads garbled.
	const reads: string[] = [];
	const registry = new ProviderRegistry<unknown>();
	registry.register(
		fakeOcrFactory({
			id: "honest-ocr",
			blocks: (req: { image: OcrImage }) => {
				const out: OcrBlock[] = [];
				LINES.forEach((l, i) => {
					const text = pristine(req.image, l.box) ? l.text : `${GARBLED}${l.text}`;
					reads.push(text);
					out.push({ id: `l${i}`, text, box: l.box, confidence: 0.99 });
				});
				return out;
			},
		}),
	);
	registry.register(fakeTranslationFactory({ id: "fake-translation" }));
	const env = settingsEnvFor("windows", "en-US", registry);
	const settings: Settings = applySettingsPatch(
		defaultSettings(env),
		{ providers: { ocr: "honest-ocr", translation: ["fake-translation"] }, snip: { showOnScreen: true } },
		env,
	).settings;
	const sink = new MemoryLogSink();
	const log = createLogger({ sinks: [sink], level: "debug" });
	const translation = new TranslationService({ registry, ctx: {}, settings: () => settings, log, now: timers.now });
	await translation.start();
	// GLIM-98 off: the popup is un-flagged and painted over in Glimpse's own frames.
	const exclusion = new CaptureExclusion(windowsOps, { setExcludedWindows: () => {} });
	exclusion.setHideFromCapture(false);
	let popup: LivePopupController | null = null;
	const screen = new MaskedCaptureSource(new Compositor(files, () => os.captured), () => exclusion.maskRects());
	const live = new LiveService({
		capture: screen,
		openPipeline: () => {
			const s = translation.openLive(() => {});
			return {
				process: (img, o) => s.process(img, o),
				setSources: (x) => s.setSources(x),
				setTarget: (x) => s.setTarget(x),
				close: () => s.close(),
			};
		},
		settings: () => settings,
		frame: () =>
			new PinnedFrame({
				binding: os,
				space: logicalFrameSpace,
				displays: () => displays,
				exclude: (id) => exclusion.register(id),
				log,
			}),
		log,
		timers,
	});
	const view = fakeView(() => popup);
	const win = { ptr: 7 as unknown as Pointer, on: () => {} };
	let shown = false;
	popup = new LivePopupController({
		window: {
			setFrame: () => {},
			showInactive: () => {
				if (shown) return;
				shown = true;
				exclusion.protect(win, undefined, { role: "popup", bounds: () => popup?.frame ?? null });
			},
			activate: () => {},
			hide: () => {},
			send: (m) => view(m),
			focusControls: () => {},
		},
		live,
		displays: () => displays,
		settings: () => ({ reducedMotion: true, uiDir: "ltr", showOnScreen: true, target: settings.language.target }),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log,
		scheduler: schedulerOn(timers),
		now: timers.now,
	});
	const t0 = timers.now();
	const at = async (ms: number) => {
		await timers.advanceTo(t0 + ms);
		// Let the controller's coalesced push (a microtask) reach the view and the frame.
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return { live, popup, at, reads, os, exclusion };
}

/** The OCR image's pixels in `box` (region-local) equal the pristine page's. */
function pristine(img: OcrImage, box: Rect): boolean {
	for (let y = box.y; y < box.y + box.height; y++) {
		for (let x = box.x; x < box.x + box.width; x++) {
			const i = y * img.stride + x * 4;
			const j = (y * COMIC.width + x) * 4;
			if (
				img.data[i] !== COMIC.data[j] ||
				img.data[i + 1] !== COMIC.data[j + 1] ||
				img.data[i + 2] !== COMIC.data[j + 2]
			)
				return false;
		}
	}
	return true;
}

/** Run a session with the overlay on, forcing re-reads while the cards are on screen. */
async function runSession(os: OsFrame) {
	const s = await setup(os);
	await s.live.start(REGION);
	await s.at(3000);
	const shownAfterFirstRead = os.sprites.length;
	const cardsShown = os.sprites.filter((x) => (x.flags & 2) !== 0).length;
	// Re-read the region several times with the cards up (a pack landing does this, GLIM-123).
	for (let i = 1; i <= 4; i++) {
		s.live.refresh("pack-installed");
		await s.at(3000 + i * 2000);
	}
	const state = s.popup.state;
	s.live.stop();
	return { ...s, shownAfterFirstRead, cardsShown, state };
}

describe("Live overlay cards never feed back into Live's own OCR (GLIM-154)", () => {
	test("frame out of capture: cards and badges are on screen, every read is the page itself", async () => {
		const os = new OsFrame(0x11);
		const r = await runSession(os);
		// The overlay really is up: a card per translated block plus a badge per numbered block.
		expect(r.state.overlay).toBe(true);
		expect(r.shownAfterFirstRead).toBeGreaterThan(0);
		const translated = r.state.blocks.filter((b) => b.cls === "translate");
		expect(r.cardsShown).toBe(translated.length);
		expect(r.shownAfterFirstRead).toBe(translated.length + r.state.blocks.length);
		expect(r.reads.length).toBeGreaterThanOrEqual(LINES.length * 3);
		expect(r.reads.filter((t) => t.startsWith(GARBLED))).toEqual([]);
		// Stable: the blocks and their numbers never changed across the re-reads.
		expect(translated.length).toBeGreaterThan(1);
		expect(r.state.changeSeq).toBe(0);
		expect(r.state.blocks.map((b) => b.badge)).toEqual(r.state.blocks.map((_, i) => i + 1));
	});

	test("frame not confirmed out of capture (affinity reads back WDA_NONE): no cards are drawn at all", async () => {
		const os = new OsFrame(0);
		const r = await runSession(os);
		expect(r.shownAfterFirstRead).toBe(0);
		expect(r.reads.length).toBeGreaterThan(0);
		expect(r.reads.filter((t) => t.startsWith(GARBLED))).toEqual([]);
	});

	test("control: a flag that doesn't hold puts the cards into Live's frames, and the harness sees it", async () => {
		const os = new OsFrame(0x11, false);
		const r = await runSession(os);
		expect(r.shownAfterFirstRead).toBeGreaterThan(0);
		expect(r.reads.some((t) => t.startsWith(GARBLED))).toBe(true);
	});
});
