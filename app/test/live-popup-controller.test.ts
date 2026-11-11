// GLIM-79: the docked Live popup's window controller over a fake window and a scripted
// session: docking at pin time, show without activating, in-place updates (only changed
// blocks change), the 600 ms hold on the scheduler, staleness refresh, consent focus, close
// on stop, and no clipboard writes from the session.
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
	LIVE_PAINT_TIMEOUT_MS,
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
	get last(): LiveStateMessage {
		const m = this.messages.at(-1);
		if (!m) throw new Error("no message");
		return m;
	}
}

class FakeSession implements LivePopupSession {
	readonly calls: string[] = [];
	active = true;
	visible: boolean[] = [];
	highlights: (Rect | null)[] = [];
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
	pause(reason = "user") {
		this.calls.push(`pause:${reason}`);
	}
	resume() {
		this.calls.push("resume");
	}
	stop() {
		this.calls.push("stop");
	}
	answerConsent(id: string, answer: string, remember: boolean) {
		this.calls.push(`consent:${id}:${answer}:${remember}`);
	}
	highlightBlock(box: Rect | null) {
		this.highlights.push(box);
	}
	setPopupVisible(v: boolean) {
		this.visible.push(v);
	}
}

const DISPLAY: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 0, 1440, 900),
	scaleFactor: 2,
	isPrimary: true,
};
const REGION = rect(120, 760, 1200, 100);
const S = "s1";
const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

function setup(opts: { continueCloud?: () => Promise<unknown> } = {}) {
	const window = new FakeWindow();
	const live = new FakeSession();
	const scheduler = new ManualScheduler();
	const focus = new RecordingFocusKeeper();
	const copied: string[] = [];
	const privateCalls: boolean[] = [];
	const repins: number[] = [];
	const c = new LivePopupController({
		window,
		live,
		displays: () => [DISPLAY],
		settings: () => ({ reducedMotion: false, uiDir: "ltr" }),
		setPrivate: (on) => privateCalls.push(on),
		repin: () => repins.push(1),
		focus,
		clipboard: { writeText: (t) => copied.push(t) },
		log: nullLogger,
		scheduler,
		now: scheduler.now,
		...(opts.continueCloud ? { continueCloud: opts.continueCloud } : {}),
	});
	return { c, window, live, scheduler, focus, copied, privateCalls, repins };
}

const block = (id: string, source: string, over: Partial<LiveBlockUpdate> = {}): LiveBlockUpdate => ({
	id,
	order: 0,
	cls: "translate",
	lang: languageCode("ja"),
	direction: "ltr",
	box: rect(10, 10, 100, 20),
	source,
	translation: null,
	failed: false,
	waitingForPack: false,
	changed: false,
	...over,
});
const opened: LiveSessionEvent = {
	type: "opened",
	sessionId: S,
	region: REGION,
	providers: { cloud: null, localOnly: false },
	private: false,
};
const status = (s: Extract<LiveSessionEvent, { type: "status" }>["status"], over: object = {}): LiveSessionEvent => ({
	type: "status",
	sessionId: S,
	status: s,
	reason: null,
	error: null,
	stale: s === "paused" || s === "error" || s === "stopped",
	capturedAt: 1000,
	at: 0,
	...over,
});
const frame = (
	seq: number,
	upserts: LiveBlockUpdate[],
	order: string[],
	changeSet: string[] = [],
): LiveSessionEvent => ({
	type: "frame",
	sessionId: S,
	frameSeq: seq,
	upserts,
	removes: [],
	order,
	changeSet,
	capturedAt: 1000,
	reused: false,
	region: REGION,
	image: { width: 2400, height: 200 },
});
const tr = (seq: number, id: string, text: string): LiveSessionEvent => ({
	type: "translation",
	sessionId: S,
	frameSeq: seq,
	id,
	text,
	final: true,
	failed: false,
});

describe("LivePopupController (GLIM-79)", () => {
	test("pin: docked above the subtitle strip, never covering it; shown inactive after paint", async () => {
		const { c, window, live } = setup();
		live.emit(opened);
		live.emit(status("starting"));
		expect(c.placement?.side).toBe("above");
		const f = window.frames[0];
		if (!f) throw new Error("no frame");
		expect(f.y + f.height).toBeLessThanOrEqual(REGION.y - 8);
		await flush();
		expect(window.last.sessionId).toBe(S);
		c.painted(S);
		expect(window.calls).toEqual(["showInactive"]);
		expect(live.visible).toEqual([true]);
		// Growing keeps the bottom edge 8px above the region.
		c.resized(S, 180);
		const g = window.frames.at(-1);
		expect(g ? g.y + g.height : 0).toBe(REGION.y - 8);
	});

	test("shows after the paint timeout if the view is slow", () => {
		const { window, live, scheduler } = setup();
		live.emit(opened);
		scheduler.advance(LIVE_PAINT_TIMEOUT_MS);
		expect(window.calls).toEqual(["showInactive"]);
	});

	test("updates in place: unchanged blocks are the same objects; a change holds 600 ms then flashes", async () => {
		const { c, window, live, scheduler } = setup();
		live.emit(opened);
		live.emit(frame(1, [block("L1", "一"), block("L2", "二", { order: 1 })], ["L1", "L2"]));
		live.emit(tr(1, "L1", "One"));
		live.emit(tr(1, "L2", "Two"));
		const before = c.state.blocks;
		live.emit(frame(2, [block("L2", "三", { order: 1, changed: true })], ["L1", "L2"], ["L2"]));
		expect(c.state.blocks[0]).toBe(before[0] as NonNullable<(typeof before)[0]>);
		expect(c.state.blocks[1]?.holding).toBe(true);
		scheduler.advance(599);
		expect(c.state.blocks[1]?.holding).toBe(true);
		scheduler.advance(1);
		expect(c.state.blocks[1]?.pending).toBe(true);
		expect(c.state.blocks[1]?.changeId).toBe(1);
		await flush();
		expect(window.last.state.blocks[1]?.source).toBe("三");
	});

	test("paused: stale, re-sent every 30 s for the age label; resume stops the refresh", async () => {
		const { live, window, scheduler, c } = setup();
		live.emit(opened);
		c.painted(S);
		live.emit(status("paused", { reason: "user" }));
		await flush();
		const n = window.messages.length;
		scheduler.advance(30_000);
		await flush();
		expect(window.messages.length).toBe(n + 1);
		expect(window.last.now).toBe(30_000);
		live.emit(status("live"));
		await flush();
		const m = window.messages.length;
		scheduler.advance(60_000);
		await flush();
		expect(window.messages.length).toBe(m);
	});

	test("consent takes focus on purpose; answering restores it", async () => {
		const { c, live, window, focus } = setup();
		live.emit({
			...opened,
			providers: { cloud: { id: "g", kind: "cloud", name: "Google Cloud Translation" }, localOnly: false },
		});
		live.emit({
			type: "consent",
			sessionId: S,
			providers: [{ id: "g", kind: "cloud", name: "Google Cloud Translation" }],
			canRemember: true,
			reason: "cloud-translation",
		});
		c.painted(S);
		expect(window.calls).toEqual(["activate"]);
		expect(focus.calls).toEqual(["save"]);
		await flush();
		expect(window.last.focused).toBe(true);
		c.answerConsent(S, "cloud", true);
		expect(live.calls).toEqual([`consent:${S}:cloud:true`]);
		expect(focus.calls).toEqual(["save", "restore"]);
	});

	test("spend guard (GLIM-120): Continue this month lifts the pause, then resumes; a failure doesn't resume", async () => {
		const order: string[] = [];
		let fail = false;
		const { c, live } = setup({
			continueCloud: async () => {
				order.push("continue");
				if (fail) throw new Error("disk");
			},
		});
		live.emit(opened);
		await c.continueCloud("other");
		expect(order).toEqual([]);
		await c.continueCloud(S);
		expect(order).toEqual(["continue"]);
		expect(live.calls).toEqual(["resume"]);
		fail = true;
		await c.continueCloud(S);
		expect(live.calls).toEqual(["resume"]);
	});

	test("intents act on the session; another session's id is ignored", () => {
		const { c, live, privateCalls, repins } = setup();
		live.emit(opened);
		c.pause("other");
		c.pause(S);
		c.resume(S);
		c.setPrivate(S, true);
		c.repin(S);
		c.stop(S);
		expect(live.calls).toEqual(["pause:user", "resume", "stop"]);
		expect(privateCalls).toEqual([true]);
		expect(repins).toEqual([1]);
	});

	test("hovering a block lights its box; stop closes and hides; nothing is copied by the session", async () => {
		const { c, live, window, copied } = setup();
		live.emit(opened);
		live.emit(frame(1, [block("L1", "一", { translation: "One" })], ["L1"]));
		c.painted(S);
		c.hoverBlock(S, "L1");
		c.hoverBlock(S, null);
		expect(live.highlights).toEqual([rect(10, 10, 100, 20), null]);
		live.emit(status("stopped"));
		expect(window.calls).toEqual(["showInactive", "hide"]);
		expect(live.visible).toEqual([true, false]);
		expect(c.state.sessionId).toBeNull();
		expect(copied).toEqual([]);
	});

	test("Private from the tray reaches the toggle without touching blocks", () => {
		const { c, live } = setup();
		live.emit(opened);
		live.emit(frame(1, [block("L1", "一", { translation: "One" })], ["L1"]));
		const blocks = c.state.blocks;
		c.privateChanged(true);
		expect(c.state.private).toBe(true);
		expect(c.state.blocks).toBe(blocks);
	});
});
