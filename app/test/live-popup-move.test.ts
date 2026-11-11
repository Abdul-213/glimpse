// GLIM-151: moving, docking and pinning the Live popup through the window controller over a
// fake window: drags follow the OS cursor (view deltas as the fallback), the popup stays put
// for the session and grows from its top-left, Alt/Option+arrows move and announce, Dock goes
// back next to the region and forgets the offset, the offset is reused next session, Pin
// reaches the window. Nothing here activates the window.
import { describe, expect, test } from "bun:test";
import {
	type Display,
	displayKey,
	type LivePopupOffset,
	type LiveSessionEvent,
	type LiveSessionListener,
	nullLogger,
	type Point,
	type Rect,
	rect,
} from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import {
	type LiveMoveResult,
	LivePopupController,
	type LivePopupSession,
	type LivePopupWindowPort,
} from "../src/bun/windows/live-popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";
import type { LiveStateMessage } from "../src/shared/live-rpc.ts";

class FakeWindow implements LivePopupWindowPort {
	readonly calls: string[] = [];
	frames: Rect[] = [];
	messages: LiveStateMessage[] = [];
	pins: boolean[] = [];
	moves: LiveMoveResult[] = [];
	setFrame(frame: Rect): void {
		this.frames.push(frame);
	}
	showInactive(): void {
		this.calls.push("showInactive");
	}
	activate(): void {
		this.calls.push("activate");
	}
	hide(): void {
		this.calls.push("hide");
	}
	send(m: LiveStateMessage): void {
		this.messages.push(m);
	}
	focusControls(): void {
		this.calls.push("focusControls");
	}
	setPinned(on: boolean): void {
		this.pins.push(on);
	}
	moved(_sessionId: string, result: LiveMoveResult): void {
		this.moves.push(result);
	}
	get frame(): Rect {
		const f = this.frames.at(-1);
		if (!f) throw new Error("no frame");
		return f;
	}
	get last(): LiveStateMessage {
		const m = this.messages.at(-1);
		if (!m) throw new Error("no message");
		return m;
	}
}

class FakeSession implements LivePopupSession {
	active = true;
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
	highlightBlock() {}
	setPopupVisible() {}
}

const DISPLAY: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 0, 1440, 900),
	scaleFactor: 1,
	isPrimary: true,
};
const REGION = rect(120, 760, 1200, 100);
const S = "s1";
const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));
const opened = (sessionId = S, region = REGION): LiveSessionEvent => ({
	type: "opened",
	sessionId,
	region,
	providers: { cloud: null, localOnly: false },
	private: false,
});
const stopped = (sessionId = S): LiveSessionEvent => ({
	type: "status",
	sessionId,
	status: "stopped",
	reason: null,
	error: null,
	stale: true,
	capturedAt: null,
	at: 0,
});

function setup(opts: { cursor?: boolean; offsets?: LivePopupOffset[] } = {}) {
	const window = new FakeWindow();
	const live = new FakeSession();
	const scheduler = new ManualScheduler();
	let pointer: Point = { x: 500, y: 500 };
	let stored: readonly LivePopupOffset[] = opts.offsets ?? [];
	const c = new LivePopupController({
		window,
		live,
		displays: () => [DISPLAY],
		settings: () => ({ reducedMotion: false, uiDir: "ltr" }),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log: nullLogger,
		scheduler,
		now: scheduler.now,
		...(opts.cursor === false ? {} : { cursor: () => pointer }),
		offsets: { get: () => stored, set: (o) => (stored = o) },
	});
	return {
		c,
		window,
		live,
		setPointer: (p: Point) => {
			pointer = p;
		},
		offsets: () => stored,
	};
}

describe("Live popup: drag (GLIM-151)", () => {
	test("follows the OS cursor, stays put for the session, remembered on release", async () => {
		const { c, window, live, setPointer, offsets } = setup();
		live.emit(opened());
		c.painted(S);
		c.resized(S, 140);
		const before = window.frame;
		expect(c.moved).toBe(false);

		c.dragStart(S);
		setPointer({ x: 400, y: 300 });
		// The view's deltas are ignored while the OS cursor is known.
		c.dragMove(S, 9999, 9999);
		expect(window.frame).toMatchObject({ x: before.x - 100, y: before.y - 200, height: 140 });
		c.dragEnd(S);
		expect(c.moved).toBe(true);
		expect(offsets()).toEqual([
			{ display: displayKey(DISPLAY), dx: before.x - 100 - REGION.x, dy: before.y - 200 - REGION.y },
		]);
		await flush();
		expect(window.last.layout).toMatchObject({ moved: true, pinned: true });

		// Growth keeps the top-left; nothing re-docks it.
		const at = window.frame;
		c.resized(S, 260);
		expect(window.frame).toMatchObject({ x: at.x, y: at.y, height: 260 });
		// Never activated or re-shown by a drag.
		expect(window.calls).toEqual(["showInactive"]);
	});

	test("without the OS cursor, the view's screen deltas move it", () => {
		const { c, window, live } = setup({ cursor: false });
		live.emit(opened());
		c.painted(S);
		const before = window.frame;
		c.dragStart(S);
		c.dragMove(S, 30, -40);
		expect(window.frame).toMatchObject({ x: before.x + 30, y: before.y - 40 });
	});

	test("a press without movement (a click, a double-click) is not a move", () => {
		const { c, window, live, offsets } = setup();
		live.emit(opened());
		c.painted(S);
		const n = window.frames.length;
		c.dragStart(S);
		c.dragMove(S, 0, 0);
		c.dragEnd(S);
		expect(window.frames.length).toBe(n);
		expect(c.moved).toBe(false);
		expect(offsets()).toEqual([]);
	});

	test("held inside the work area", () => {
		const { c, window, live, setPointer } = setup();
		live.emit(opened());
		c.painted(S);
		c.dragStart(S);
		setPointer({ x: -5000, y: -5000 });
		c.dragMove(S, 0, 0);
		expect(window.frame).toMatchObject({ x: 8, y: 8 });
	});

	test("other sessions' messages are ignored", () => {
		const { c, window, live } = setup();
		live.emit(opened());
		c.painted(S);
		const n = window.frames.length;
		c.dragStart("other");
		c.dragMove("other", 50, 50);
		c.moveBy("other", "left", false);
		c.dock("other");
		c.setPinned("other", false);
		expect(window.frames.length).toBe(n);
		expect(window.pins).toEqual([true]);
	});
});

describe("Live popup: keyboard move (GLIM-151)", () => {
	test("10 px, 50 px with Shift; announced, with the edge it stopped at", () => {
		const { c, window, live } = setup();
		live.emit(opened());
		c.painted(S);
		const f = window.frame;
		c.moveBy(S, "left", false);
		expect(window.frame.x).toBe(f.x - 10);
		c.moveBy(S, "up", true);
		expect(window.frame.y).toBe(f.y - 50);
		expect(window.moves).toEqual([
			{ kind: "moved", edges: [] },
			{ kind: "moved", edges: [] },
		]);
		for (let i = 0; i < 40; i++) c.moveBy(S, "left", true);
		expect(window.frame.x).toBe(8);
		expect(window.moves.at(-1)).toEqual({ kind: "moved", edges: ["left"] });
		expect(window.calls).toEqual(["showInactive"]);
	});
});

describe("Live popup: Dock (GLIM-151)", () => {
	test("back next to the region with the docked placement; the offset is forgotten", async () => {
		const { c, window, live, offsets } = setup();
		live.emit(opened());
		c.painted(S);
		c.resized(S, 140);
		const docked = window.frame;
		c.moveBy(S, "up", true);
		expect(offsets()).toHaveLength(1);
		c.dock(S);
		expect(window.frame).toEqual(docked);
		expect(c.moved).toBe(false);
		expect(offsets()).toEqual([]);
		expect(window.moves.at(-1)).toEqual({ kind: "docked", edges: [] });
		await flush();
		expect(window.last.layout.moved).toBe(false);
	});

	test("does nothing while docked", () => {
		const { c, window, live } = setup();
		live.emit(opened());
		c.painted(S);
		const n = window.frames.length;
		c.dock(S);
		expect(window.frames.length).toBe(n);
		expect(window.moves).toEqual([]);
	});
});

describe("Live popup: next session (GLIM-151)", () => {
	test("the remembered offset places it relative to the new region; another display docks", () => {
		const { c, window, live } = setup({ offsets: [{ display: displayKey(DISPLAY), dx: 300, dy: -500 }] });
		live.emit(opened());
		expect(c.moved).toBe(true);
		expect(window.frame).toMatchObject({ x: REGION.x + 300, y: REGION.y - 500 });
		live.emit(stopped());

		const other = setup({ offsets: [{ display: "1440,0,1920x1080@1", dx: 300, dy: -500 }] });
		other.live.emit(opened());
		expect(other.c.moved).toBe(false);
	});

	test("an offset that would land off screen is clamped on", () => {
		const { window, live } = setup({ offsets: [{ display: displayKey(DISPLAY), dx: 5000, dy: 5000 }] });
		live.emit(opened());
		expect(window.frame.x + window.frame.width).toBeLessThanOrEqual(1440 - 8);
		expect(window.frame.y + window.frame.height).toBeLessThanOrEqual(900 - 8);
	});
});

describe("Live popup: Pin (GLIM-151)", () => {
	test("on by default; off reaches the window and the view; kept for the next session", async () => {
		const { c, window, live } = setup();
		live.emit(opened());
		c.painted(S);
		expect(c.pinned).toBe(true);
		expect(window.pins).toEqual([true]);
		c.setPinned(S, false);
		c.setPinned(S, false);
		expect(window.pins).toEqual([true, false]);
		await flush();
		expect(window.last.layout.pinned).toBe(false);
		live.emit(stopped());
		live.emit(opened("s2"));
		expect(window.pins).toEqual([true, false, false]);
		expect(window.calls).not.toContain("activate");
	});
});
