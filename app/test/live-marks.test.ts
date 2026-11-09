// GLIM-154: the main-process side of Live's numbered markers and overlay: sprite packing for
// the helpers, PinnedFrame's marks (mapping, flags, the capture-exclusion gate, pointer ids),
// and the popup controller (overlay toggle and setting, bitmaps cached by key, the pointer
// poll that links and picks blocks, marks config only when the frame can draw out of capture).
import { describe, expect, test } from "bun:test";
import {
	type Display,
	type LiveBlockUpdate,
	type LiveSessionEvent,
	type LiveSessionListener,
	languageCode,
	nullLogger,
	type Rect,
	rect,
} from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import {
	type FrameHandle,
	type FrameNativeBinding,
	type FramePointer,
	type FrameSprite,
	logicalFrameSpace,
	packSprites,
	premultiplied,
	SPRITE_INTERACTIVE,
	SPRITE_PEEK,
} from "../src/bun/native/frame.ts";
import { type LiveFrameMark, type LiveMarksPointer, PinnedFrame } from "../src/bun/services/live/pinned-frame.ts";
import {
	isLiveMarkSprite,
	LIVE_MARKS_POINTER_MS,
	LivePopupController,
	type LivePopupSession,
	liveViewInit,
} from "../src/bun/windows/live-popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";
import type { LiveMarkSprite, LiveStateMessage } from "../src/shared/live-rpc.ts";

const sprite = (over: Partial<FrameSprite> = {}): FrameSprite => ({
	rect: rect(1, 2, 3, 4),
	width: 2,
	height: 1,
	rgba: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
	opacity: 0.6,
	flags: SPRITE_INTERACTIVE,
	...over,
});

describe("sprite packing (frame.ts)", () => {
	test("geometry, meta and pixels back to back, as glim_frame_set_sprites takes them", () => {
		const p = packSprites([
			sprite(),
			sprite({ rect: rect(10, 20, 30, 40), width: 1, rgba: Uint8Array.of(9, 9, 9, 9), flags: 3 }),
		]);
		expect(p.count).toBe(2);
		expect([...p.geom]).toEqual([1, 2, 3, 4, 0.6, 10, 20, 30, 40, 0.6]);
		expect([...p.meta]).toEqual([2, 1, 1, 1, 1, 3]);
		expect([...p.pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9]);
	});
	test("no sprites: still non-empty buffers (bun:ffi ptr needs a backing store)", () => {
		const p = packSprites([]);
		expect(p.count).toBe(0);
		expect(p.geom.length).toBeGreaterThan(0);
		expect(p.pixels.length).toBeGreaterThan(0);
	});
	test("premultiplied alpha", () => {
		expect([...premultiplied(Uint8Array.of(255, 128, 0, 128, 10, 20, 30, 255, 99, 99, 99, 0))]).toEqual([
			128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0,
		]);
	});
});

class SpriteBinding implements FrameNativeBinding {
	sprites: readonly FrameSprite[] = [];
	peek = 0;
	pointer: FramePointer = { hover: -1, click: -1 };
	info: Record<string, number> | null;
	calls = 0;
	constructor(info: Record<string, number> | null) {
		this.info = info;
	}
	frameCreate(): FrameHandle {
		return 1n;
	}
	frameSetRect(): void {}
	frameSetStyle(): void {}
	frameSetHighlight(): void {}
	frameShow(): void {}
	frameWindowId(): number {
		return 7;
	}
	frameDestroy(): void {}
	frameInfo(): Record<string, number> | null {
		return this.info;
	}
	frameSetSprites(_h: FrameHandle, sprites: readonly FrameSprite[], peek: number): void {
		this.calls++;
		this.sprites = sprites;
		this.peek = peek;
	}
	framePointer(): FramePointer {
		return this.pointer;
	}
}

const DISPLAY: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 0, 1440, 900),
	scaleFactor: 2,
	isPrimary: true,
};
const mark = (id: string, kind: "badge" | "card", over: Partial<LiveFrameMark> = {}): LiveFrameMark => ({
	id,
	kind,
	rect: rect(100, 100, 2, 1),
	width: 2,
	height: 1,
	rgba: Uint8Array.of(255, 255, 255, 128, 0, 0, 0, 255),
	opacity: 1,
	...over,
});

function frameWith(info: Record<string, number> | null, space = logicalFrameSpace) {
	const binding = new SpriteBinding(info);
	const frame = new PinnedFrame({ binding, space, displays: () => [DISPLAY], log: nullLogger });
	frame.show(rect(50, 50, 400, 300));
	return { binding, frame };
}

describe("PinnedFrame marks (GLIM-154)", () => {
	test("Windows: marks only once the display affinity reads back WDA_EXCLUDEFROMCAPTURE", () => {
		expect(frameWith({ affinity: 0x11 }).frame.marksAvailable).toBe(true);
		expect(frameWith({ affinity: 0x11 }).frame.marksScale).toBe(2);
		const old = frameWith({ affinity: 0 });
		expect(old.frame.marksAvailable).toBe(false);
		expect(old.frame.marksScale).toBeNull();
		old.frame.setMarks([mark("a", "card")]);
		expect(old.binding.calls).toBe(0);
		// Nothing to confirm with: no marks.
		expect(frameWith(null).frame.marksAvailable).toBe(false);
	});

	test("macOS (the SCK filter leaves out the app): marks available", () => {
		expect(frameWith({ sharingType: 0, ignoresMouseEvents: 1 }).frame.marksAvailable).toBe(true);
	});

	test("sprites: mapped into the frame's space, premultiplied, cards peek, everything hit-tested", () => {
		const double: typeof logicalFrameSpace = (r) => ({
			rect: { x: r.x * 2, y: r.y * 2, width: r.width * 2, height: r.height * 2 },
			scale: 2,
		});
		const { binding, frame } = frameWith({ affinity: 0x11 }, double);
		frame.setMarks([mark("a", "card"), mark("a", "badge", { opacity: 0.6 })]);
		expect(binding.sprites.map((s) => [s.rect, s.flags, s.opacity])).toEqual([
			[rect(200, 200, 4, 2), SPRITE_INTERACTIVE | SPRITE_PEEK, 1],
			[rect(200, 200, 4, 2), SPRITE_INTERACTIVE, 0.6],
		]);
		expect([...(binding.sprites[0]?.rgba ?? [])]).toEqual([128, 128, 128, 128, 0, 0, 0, 255]);
		expect(binding.peek).toBeGreaterThan(0);
		expect(binding.peek).toBeLessThan(0.2);
	});

	test("pointer indices map back to block ids; nothing when there are no marks", () => {
		const { binding, frame } = frameWith({ affinity: 0x11 });
		expect(frame.pointer()).toEqual({ hover: null, click: null });
		frame.setMarks([mark("a", "card"), mark("b", "badge")]);
		binding.pointer = { hover: 1, click: 0 };
		expect(frame.pointer()).toEqual({ hover: "b", click: "a" });
		frame.setMarks([]);
		expect(binding.sprites).toEqual([]);
		expect(frame.pointer()).toEqual({ hover: null, click: null });
	});

	test("bad bitmaps are skipped", () => {
		const { binding, frame } = frameWith({ affinity: 0x11 });
		frame.setMarks([mark("a", "card", { rgba: new Uint8Array(3) }), mark("b", "badge")]);
		expect(binding.sprites).toHaveLength(1);
		expect(frame.marks.map((m) => m.id)).toEqual(["b"]);
	});
});

describe("isLiveMarkSprite (RPC input)", () => {
	const ok: LiveMarkSprite = { key: "k", id: "a", kind: "card", x: 1, y: 2, width: 3, height: 4, opacity: 1 };
	test("accepts sprites with or without an image; rejects junk", () => {
		expect(isLiveMarkSprite(ok)).toBe(true);
		expect(isLiveMarkSprite({ ...ok, image: { width: 2, height: 2, data: "AAAA" } })).toBe(true);
		expect(isLiveMarkSprite({ ...ok, kind: "box" })).toBe(false);
		expect(isLiveMarkSprite({ ...ok, x: Number.NaN })).toBe(false);
		expect(isLiveMarkSprite({ ...ok, image: { width: 99999, height: 2, data: "" } })).toBe(false);
		expect(isLiveMarkSprite(null)).toBe(false);
	});
});

// ---- controller ---------------------------------------------------------------------------

class MarksSession implements LivePopupSession {
	active = true;
	highlights: (Rect | null)[] = [];
	marks: (readonly LiveFrameMark[])[] = [];
	scale: number | null = 2;
	pointer: LiveMarksPointer = { hover: null, click: null };
	#l: LiveSessionListener | null = null;
	onEvent(l: LiveSessionListener) {
		this.#l = l;
		return () => {
			this.#l = null;
		};
	}
	emit(e: LiveSessionEvent) {
		this.#l?.(e);
	}
	pause() {}
	resume() {}
	stop() {}
	answerConsent() {}
	highlightBlock(box: Rect | null) {
		this.highlights.push(box);
	}
	setPopupVisible() {}
	marksScale() {
		return this.scale;
	}
	setMarks(m: readonly LiveFrameMark[]) {
		this.marks.push(m);
	}
	refreshes: string[] = [];
	refresh(reason: string) {
		this.refreshes.push(reason);
	}
	marksPointer() {
		const p = this.pointer;
		this.pointer = { hover: p.hover, click: null };
		return p;
	}
}

const REGION = rect(100, 100, 800, 400);
const S = "s1";
const flush = async () => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};
const block = (id: string, order: number, box: Rect): LiveBlockUpdate => ({
	id,
	order,
	cls: "translate",
	lang: languageCode("ja"),
	direction: "ltr",
	box,
	source: `src ${id}`,
	translation: `tr ${id}`,
	failed: false,
	waitingForPack: false,
	changed: false,
});

function setup(opts: { showOnScreen?: boolean; update?: "text" | "manual"; modes?: string[] } = {}) {
	const live = new MarksSession();
	const messages: LiveStateMessage[] = [];
	const scheduler = new ManualScheduler();
	const c = new LivePopupController({
		window: {
			setFrame: () => {},
			showInactive: () => {},
			activate: () => {},
			hide: () => {},
			send: (m) => messages.push(m),
			focusControls: () => {},
		},
		live,
		displays: () => [DISPLAY],
		settings: () => ({
			reducedMotion: false,
			uiDir: "ltr",
			showOnScreen: opts.showOnScreen ?? false,
			target: languageCode("en"),
			...(opts.update ? { update: opts.update } : {}),
		}),
		...(opts.modes ? { setUpdateMode: (m: string) => opts.modes?.push(m) } : {}),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log: nullLogger,
		scheduler,
		now: scheduler.now,
	});
	live.emit({
		type: "opened",
		sessionId: S,
		region: REGION,
		providers: { cloud: null, localOnly: false },
		private: false,
	});
	live.emit({
		type: "frame",
		sessionId: S,
		frameSeq: 1,
		upserts: [block("a", 0, rect(10, 10, 100, 40)), block("b", 1, rect(300, 200, 120, 60))],
		removes: [],
		order: ["a", "b"],
		changeSet: [],
		capturedAt: 1,
		reused: false,
		region: REGION,
		image: { width: 800, height: 400 },
	});
	const last = () => {
		const m = messages.at(-1);
		if (!m) throw new Error("no message");
		return m;
	};
	return { c, live, messages, scheduler, last };
}

const spriteMsg = (id: string, key: string, withImage: boolean): LiveMarkSprite => ({
	key,
	id,
	kind: "badge",
	x: 10,
	y: 10,
	width: 2,
	height: 1,
	opacity: 1,
	...(withImage
		? { image: { width: 2, height: 1, data: Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]).toString("base64") } }
		: {}),
});

describe("LivePopupController marks (GLIM-154)", () => {
	test("the view gets the marks config (scale, target) only while the frame can draw out of capture", async () => {
		const s = setup();
		await flush();
		expect(s.last().marks).toEqual({ scale: 2, target: "en" });
		s.live.scale = null;
		s.c.toggleOverlay(S, true);
		await flush();
		expect(s.last().marks).toBeUndefined();
	});

	test("overlay: off by default, on with Settings › Show translations on screen, toggled per session", async () => {
		expect(setup().c.state.overlay).toBe(false);
		const s = setup({ showOnScreen: true });
		expect(s.c.state.overlay).toBe(true);
		s.c.toggleOverlay(S, false);
		expect(s.c.state.overlay).toBe(false);
		s.c.toggleOverlay("other", true);
		expect(s.c.state.overlay).toBe(false);
	});

	test("bitmaps are kept by key: a sprite sent again without pixels reuses them; unknown keys are skipped", () => {
		const s = setup();
		s.c.marks(S, [spriteMsg("a", "k1", true)]);
		expect(s.live.marks.at(-1)?.map((m) => [m.id, m.width, [...m.rgba]])).toEqual([
			["a", 2, [1, 2, 3, 255, 4, 5, 6, 255]],
		]);
		s.c.marks(S, [spriteMsg("a", "k1", false), spriteMsg("b", "k2", false)]);
		expect(s.live.marks.at(-1)?.map((m) => m.id)).toEqual(["a"]);
		// k1 dropped once unused; sending it again without pixels draws nothing.
		s.c.marks(S, []);
		s.c.marks(S, [spriteMsg("a", "k1", false)]);
		expect(s.live.marks.at(-1)).toEqual([]);
	});

	test("the pointer poll runs only while marks are up: hover links the block and its box, a click picks it", async () => {
		const s = setup();
		s.scheduler.advance(LIVE_MARKS_POINTER_MS * 3);
		s.live.pointer = { hover: "b", click: null };
		s.scheduler.advance(LIVE_MARKS_POINTER_MS);
		expect(s.c.state.screenLinked).toBeNull(); // no marks yet: not polled
		s.c.marks(S, [spriteMsg("b", "k", true)]);
		s.scheduler.advance(LIVE_MARKS_POINTER_MS);
		expect(s.c.state.screenLinked).toBe("b");
		expect(s.live.highlights.at(-1)).toEqual(rect(300, 200, 120, 60)); // image px; the service maps it
		s.live.pointer = { hover: "b", click: "b" };
		s.scheduler.advance(LIVE_MARKS_POINTER_MS);
		expect(s.c.state.selected).toEqual({ id: "b", seq: 1 });
		// A popup hover wins over the screen for the linked box.
		s.c.hoverBlock(S, "a");
		expect(s.live.highlights.at(-1)).toEqual(rect(10, 10, 100, 40));
		// Marks gone: the poll stops and the screen link clears.
		s.c.marks(S, []);
		expect(s.c.state.screenLinked).toBeNull();
		const pending = s.scheduler.pending;
		s.scheduler.advance(LIVE_MARKS_POINTER_MS * 2);
		expect(s.scheduler.pending).toBe(pending);
	});

	test("the view's keys name the overlay shortcut", () => {
		expect(liveViewInit("macos").keys.overlay).toBe("⌘⇧T");
		expect(liveViewInit("windows").keys.overlay).toBe("Ctrl+Shift+T");
	});
});

describe("GLIM-157: no redraw without a change; Refresh and the Update mode", () => {
	test("the same marks in the same places are not sent to the frame again", () => {
		const s = setup();
		s.c.marks(S, [spriteMsg("a", "k1", true)]);
		s.c.marks(S, [spriteMsg("a", "k1", false)]);
		s.c.marks(S, [spriteMsg("a", "k1", false)]);
		expect(s.live.marks).toHaveLength(1);
		s.c.marks(S, [{ ...spriteMsg("a", "k1", false), x: 11 }]);
		expect(s.live.marks).toHaveLength(2);
	});

	test("Refresh reaches the session; the Update toggle sets the setting; the view is told the mode", async () => {
		const modes: string[] = [];
		const s = setup({ update: "manual", modes });
		await flush();
		expect(s.last().update).toBe("manual");
		expect(s.last().updateToggle).toBe(true);
		s.c.refresh(S);
		s.c.refresh("other");
		expect(s.live.refreshes).toEqual(["user"]);
		s.c.setUpdateMode(S, "text");
		expect(modes).toEqual(["text"]);
		const auto = setup();
		await flush();
		expect(auto.last().update).toBeUndefined();
		expect(auto.last().updateToggle).toBeUndefined();
	});

	test("the view's keys name Refresh", () => {
		expect(liveViewInit("macos").keys.refresh).toBe("⌘R");
		expect(liveViewInit("windows").keys.refresh).toBe("Ctrl+R");
	});
});
