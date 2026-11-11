// Region picker state machine, snapping, HUD layout and session (region-picker spec 3-8, 9.5).
import { describe, expect, test } from "bun:test";
import {
	candidateAt,
	hintPlacement,
	initialPickerState,
	loupePosition,
	type Modifiers,
	NO_MODIFIERS,
	type PickerEnv,
	type PickerEvent,
	type PickerOutcome,
	PickerSession,
	type PickerState,
	type PickerViewState,
	type Point,
	pickerView,
	readoutPosition,
	rect,
	reducePicker,
	type ScreenWindow,
	snapEdges,
	snapPoint,
} from "../src/index.ts";
import { FakePointer, SolidPixelSampler, StaticWindowList } from "../src/testing/index.ts";
import { display, macDisplays, winDisplays } from "./picker-fixtures.ts";

// The mockup's desktop: one 1280 x 720 display, menu bar 28 px, three windows front to back.
const desk = [display(1, rect(0, 0, 1280, 720), 1, true, rect(0, 28, 1280, 692))];
const WINDOWS: ScreenWindow[] = [
	{ rect: rect(64, 92, 400, 520), pid: 11, z: 0, appName: "Messages" },
	{ rect: rect(500, 64, 720, 420), pid: 12, z: 1, appName: "Safari" },
	{ rect: rect(560, 440, 620, 250), pid: 13, z: 2, appName: "Preview" },
];
const env = (over: Partial<PickerEnv> = {}): PickerEnv => ({
	displays: desk,
	windows: WINDOWS,
	os: "windows",
	confirmOnRelease: true,
	...over,
});

const mods = (m: Partial<Modifiers> = {}): Modifiers => ({ ...NO_MODIFIERS, ...m });
const ptr = (
	phase: "down" | "move" | "up",
	x: number,
	y: number,
	m: Partial<Modifiers> = {},
	extra = {},
): PickerEvent => ({
	type: "pointer",
	phase,
	p: { x, y },
	button: 0,
	mods: mods(m),
	detail: 1,
	t: 1000,
	...extra,
});
const key = (k: string, m: Partial<Modifiers> = {}, down = true): PickerEvent => ({
	type: "key",
	key: k,
	down,
	mods: mods(m),
	t: 1000,
});
const run = (s: PickerState, ...events: PickerEvent[]) => events.reduce(reducePicker, s);
const start = (over: Partial<PickerEnv> = {}, at: Point = { x: 640, y: 360 }, mode: "snip" | "live" = "snip") =>
	initialPickerState(env(over), mode, at);
const drag = (s: PickerState, from: Point, to: Point, m: Partial<Modifiers> = {}) =>
	run(
		s,
		ptr("down", from.x, from.y, m),
		ptr("move", (from.x + to.x) / 2, (from.y + to.y) / 2, m),
		ptr("move", to.x, to.y, m),
		ptr("up", to.x, to.y, m),
	);
const view = (s: PickerState, now = 1000): PickerViewState => pickerView(s, { seq: 1, now });
const region = (s: PickerState) => (s.outcome?.kind === "confirmed" ? s.outcome.region : null);

describe("candidates and clicks", () => {
	test("hovering a window shows it as the candidate with app name and size", () => {
		const s = run(start(), ptr("move", 205, 152));
		expect(view(s).candidate).toEqual({ rect: rect(64, 92, 400, 520), label: "Messages · 400 × 520" });
		expect(view(s).readout?.text).toBe("Messages · 400 × 520");
	});

	test("bare desktop: the whole display, labelled Screen", () => {
		const s = run(start(), ptr("move", 20, 700));
		expect(view(s).candidate?.label).toBe("Screen · 1280 × 720");
	});

	test("click confirms the window under the pointer; Shift-click lands in adjusting", () => {
		const clicked = run(start(), ptr("down", 205, 152), ptr("up", 206, 153));
		expect(clicked.phase).toBe("confirmed");
		expect(region(clicked)).toMatchObject({
			rect: rect(64, 92, 400, 520),
			source: "window",
			window: { appName: "Messages", pid: 11 },
		});
		const shifted = run(start(), ptr("down", 205, 152, { shift: true }), ptr("up", 205, 152, { shift: true }));
		expect(shifted.phase).toBe("adjusting");
		expect(shifted.selection).toEqual(rect(64, 92, 400, 520));
	});

	test("windows under 40 x 40 are skipped; overlapping windows pick the frontmost", () => {
		const tiny: ScreenWindow = { rect: rect(600, 100, 30, 30), pid: 1, z: -1, appName: "Tiny" };
		expect(candidateAt([tiny, ...WINDOWS], desk, { x: 610, y: 110 }, "snip")?.window?.appName).toBe("Safari");
		// Preview overlaps Safari at (600, 460): Safari is in front.
		expect(candidateAt(WINDOWS, desk, { x: 600, y: 460 }, "snip")?.window?.appName).toBe("Safari");
	});
});

describe("dragging", () => {
	test("a press that moves 4 px becomes a drag; release confirms the device-pixel snapped rect", () => {
		const s = run(start({ windows: [] }), ptr("down", 300.3, 300), ptr("move", 302, 302));
		expect(s.phase).toBe("idle");
		const d = run(s, ptr("move", 303, 303));
		expect(d.phase).toBe("dragging");
		const done = run(d, ptr("move", 500, 400), ptr("up", 500.6, 400));
		expect(region(done)).toMatchObject({ rect: rect(300, 300, 201, 100), source: "drag", window: null });
		expect(region(done)?.pieces).toHaveLength(1);
	});

	test("too small returns to idle with the hint for 2 s", () => {
		const s = drag(start({ windows: [] }), { x: 300, y: 300 }, { x: 305, y: 340 });
		expect(s.phase).toBe("idle");
		expect(s.selection).toBeNull();
		expect(view(s, 1500).hint?.key).toBe("tooSmall");
		expect(view(s, 3001).hint?.key).toBe("idle");
	});

	test("edges snap within 6 px to window edges, with a guide; Ctrl turns it off on Windows", () => {
		const s = run(start(), ptr("down", 200, 300), ptr("move", 300, 400), ptr("move", 468, 400));
		expect(s.selection).toEqual(rect(200, 300, 264, 100));
		expect(s.guides).toEqual([{ x1: 464, y1: 92, x2: 464, y2: 612 }]);
		const off = run(
			start(),
			ptr("down", 200, 300, { ctrl: true }),
			ptr("move", 300, 400, { ctrl: true }),
			ptr("move", 468, 400, { ctrl: true }),
		);
		expect(off.selection?.width).toBe(268);
		expect(off.guides).toEqual([]);
	});

	test("on macOS ⌘ disables snapping, not Ctrl", () => {
		const base = start({ os: "macos" });
		const ctrl = run(
			base,
			ptr("down", 200, 300, { ctrl: true }),
			ptr("move", 300, 400, { ctrl: true }),
			ptr("move", 468, 400, { ctrl: true }),
		);
		expect(ctrl.selection?.width).toBe(264);
		const cmd = run(
			base,
			ptr("down", 200, 300, { meta: true }),
			ptr("move", 300, 400, { meta: true }),
			ptr("move", 468, 400, { meta: true }),
		);
		expect(cmd.selection?.width).toBe(268);
	});

	test("the anchor snaps at press time", () => {
		const s = run(start(), ptr("down", 67, 300), ptr("move", 200, 400));
		expect(s.selection?.x).toBe(64);
	});

	test("Space held moves the whole selection", () => {
		let s = run(start({ windows: [] }), ptr("down", 100, 100), ptr("move", 200, 200));
		s = run(s, key(" "), ptr("move", 250, 230));
		expect(s.selection).toEqual(rect(150, 130, 100, 100));
		s = run(s, key(" ", {}, false), ptr("move", 300, 300));
		expect(s.selection).toEqual(rect(150, 130, 150, 170));
	});

	test("Shift at release, or confirm-on-release off, lands in adjusting", () => {
		const shift = drag(start({ windows: [] }), { x: 100, y: 100 }, { x: 300, y: 200 }, { shift: true });
		expect(shift.phase).toBe("adjusting");
		const off = drag(start({ windows: [], confirmOnRelease: false }), { x: 100, y: 100 }, { x: 300, y: 200 });
		expect(off.phase).toBe("adjusting");
		expect(off.source).toBe("drag");
	});

	test("points are clamped to the desktop", () => {
		const s = run(start({ windows: [] }), ptr("down", 1200, 600), ptr("move", 1250, 650), ptr("move", 2000, 900));
		expect(s.selection).toEqual(rect(1200, 600, 80, 120));
	});
});

describe("adjusting", () => {
	const adjusting = () => drag(start({ windows: [] }), { x: 100, y: 100 }, { x: 300, y: 200 }, { shift: true });

	test("dragging a handle resizes from it; crossing over flips the rect", () => {
		const s = run(adjusting(), ptr("down", 300, 200), ptr("move", 350, 260), ptr("up", 350, 260));
		expect(s.selection).toEqual(rect(100, 100, 250, 160));
		const flipped = run(adjusting(), ptr("down", 100, 150), ptr("move", 400, 150), ptr("up", 400, 150));
		expect(flipped.selection).toEqual(rect(300, 100, 100, 100));
	});

	test("dragging inside moves it; a double-click inside confirms", () => {
		const moved = run(adjusting(), ptr("down", 200, 150), ptr("move", 230, 170), ptr("up", 230, 170));
		expect(moved.selection).toEqual(rect(130, 120, 200, 100));
		const dbl = run(
			adjusting(),
			ptr("down", 200, 150),
			ptr("up", 200, 150),
			ptr("down", 200, 150),
			ptr("up", 200, 150, {}, { detail: 2 }),
		);
		expect(dbl.phase).toBe("confirmed");
	});

	test("pressing outside starts a new selection", () => {
		const s = run(adjusting(), ptr("down", 600, 400), ptr("move", 700, 500));
		expect(s.phase).toBe("dragging");
		expect(s.selection).toEqual(rect(600, 400, 100, 100));
	});

	test("midpoint handles only on edges of 48 px or more", () => {
		const s = adjusting();
		expect(view(s).handles).toBe(true);
		expect(view(run(s, ptr("move", 200, 100))).cursorStyle).toBe("ns-resize");
		expect(view(run(s, ptr("move", 300, 200))).cursorStyle).toBe("nwse-resize");
		expect(view(run(s, ptr("move", 200, 150))).cursorStyle).toBe("move");
		expect(view(s).crosshair).toBe(false);
		expect(view(s).loupe).toBeNull();
	});
});

describe("keyboard", () => {
	test("an arrow in idle draws a 240 x 120 box round the pointer, clamped to the display", () => {
		expect(run(start(), key("ArrowRight")).selection).toEqual(rect(520, 300, 240, 120));
		const corner = run(start({}, { x: 1270, y: 10 }), key("ArrowDown"));
		expect(corner.selection).toEqual(rect(1040, 0, 240, 120));
		expect(corner.source).toBe("keyboard");
	});

	test("arrows move 1 / 10 px; Alt+arrows resize, never below 8 x 8; Enter confirms", () => {
		let s = run(start(), key("ArrowRight"), key("ArrowRight"), key("ArrowDown", { shift: true }));
		expect(s.selection).toEqual(rect(521, 310, 240, 120));
		s = run(s, key("ArrowLeft", { alt: true, shift: true }), key("ArrowDown", { alt: true }));
		expect(s.selection).toEqual(rect(521, 310, 230, 121));
		for (let i = 0; i < 30; i++) s = run(s, key("ArrowUp", { alt: true, shift: true }));
		expect(s.selection?.height).toBe(8);
		s = run(s, key("Enter"));
		expect(region(s)?.source).toBe("keyboard");
	});

	test("Enter in idle confirms the candidate", () => {
		expect(region(run(start(), ptr("move", 700, 200), key("Enter")))?.window?.appName).toBe("Safari");
	});

	test("Tab switches mode and keeps the selection and phase", () => {
		const s = run(start(), key("ArrowRight"), key("Tab"));
		expect(s.mode).toBe("live");
		expect(s.phase).toBe("adjusting");
		expect(s.selection).toEqual(rect(520, 300, 240, 120));
		expect(run(s, key("Tab")).mode).toBe("snip");
	});
});

describe("cancel", () => {
	test("Esc cancels from any phase; right-click cancels; final states ignore input", () => {
		for (const s of [start(), run(start(), ptr("down", 10, 10), ptr("move", 50, 50)), run(start(), key("ArrowUp"))]) {
			expect(run(s, key("Escape")).outcome).toEqual({ kind: "cancelled", reason: "escape" });
		}
		const rc = run(start(), { ...ptr("down", 10, 10), button: 2 } as PickerEvent);
		expect(rc.outcome).toEqual({ kind: "cancelled", reason: "right-click" });
		expect(run(rc, key("ArrowUp"), ptr("down", 1, 1))).toBe(rc);
	});
});

describe("Live mode", () => {
	const two = [display(1, rect(0, 0, 1280, 720), 1, true), display(2, rect(1280, 0, 1280, 720), 1)];
	test("the moving corner stays on the anchor's display, and the hint says so", () => {
		const s = run(
			start({ displays: two, windows: [] }, { x: 1000, y: 100 }, "live"),
			ptr("down", 1000, 100),
			ptr("move", 1100, 200),
			ptr("move", 1500, 300),
		);
		expect(s.selection).toEqual(rect(1000, 100, 280, 200));
		expect(view(s).hint?.key).toBe("liveOneScreen");
	});

	test("candidates are clipped to the pointer's display", () => {
		const wide: ScreenWindow = { rect: rect(1000, 100, 600, 400), pid: 1, z: 0, appName: "Wide" };
		expect(candidateAt([wide], two, { x: 1100, y: 200 }, "live")?.rect).toEqual(rect(1000, 100, 280, 400));
		expect(candidateAt([wide], two, { x: 1100, y: 200 }, "snip")?.rect).toEqual(rect(1000, 100, 600, 400));
	});
});

describe("snapping helpers", () => {
	test("edges only from windows whose extent contains the pointer; display and work-area edges always", () => {
		const e = snapEdges(WINDOWS, desk, { x: 30, y: 30 });
		expect(e.x.map((x) => x.at)).not.toContain(64);
		expect(e.y.map((y) => y.at)).toContain(28); // the work area's top (menu bar)
		expect(snapPoint({ x: 3, y: 31 }, e).p).toEqual({ x: 0, y: 28 });
		expect(snapPoint({ x: 7, y: 35 }, e).p).toEqual({ x: 7, y: 35 });
	});
});

describe("HUD layout", () => {
	const d = desk;
	test("readout: 8 px outside bottom-right, flips per axis at display edges, else inside", () => {
		const chip = { width: 80, height: 20 };
		expect(readoutPosition(rect(100, 100, 200, 100), chip, d)?.at).toEqual({ x: 308, y: 208 });
		expect(readoutPosition(rect(1100, 650, 150, 60), chip, d)?.at).toEqual({ x: 1012, y: 622 });
		expect(readoutPosition(rect(0, 0, 1280, 720), chip, d)?.at).toEqual({ x: 1192, y: 692 });
		expect(readoutPosition(rect(100, 100, 200, 100), chip, d, "rtl")?.at).toEqual({ x: 12, y: 208 });
	});

	test("readout is drawn on the display holding the corner", () => {
		expect(readoutPosition(rect(1400, 300, 200, 100), { width: 80, height: 20 }, macDisplays)?.displayId).toBe(2);
		expect(readoutPosition(rect(2300, 100, 200, 100), { width: 80, height: 20 }, winDisplays)?.displayId).toBe(65537);
	});

	test("loupe: 24 px right and below, flips near the right and bottom edges", () => {
		const one = desk[0];
		if (!one) throw new Error("fixture");
		expect(loupePosition({ x: 100, y: 100 }, one).at).toEqual({ x: 124, y: 124 });
		expect(loupePosition({ x: 1200, y: 650 }, one).at).toEqual({ x: 1056, y: 506 });
	});

	test("hint bar: top unless the pointer or selection is within 48 px, then bottom", () => {
		const wa = rect(0, 28, 1280, 692);
		const bar = { width: 500, height: 28 };
		expect(hintPlacement(wa, bar, { x: 640, y: 400 }, null)).toBe("top");
		expect(hintPlacement(wa, bar, { x: 640, y: 100 }, null)).toBe("bottom");
		expect(hintPlacement(wa, bar, null, rect(600, 50, 100, 100))).toBe("bottom");
		expect(hintPlacement(wa, bar, { x: 640, y: 100 }, rect(0, 600, 1280, 100), "bottom")).toBe("bottom");
	});

	test("in idle the pointer doesn't push the bar (so the mode switch stays reachable); dragging does", () => {
		expect(view(run(start(), ptr("move", 640, 60))).hint?.placement).toBe("top");
		const dragging = run(start({ windows: [] }), ptr("down", 640, 300), ptr("move", 640, 200), ptr("move", 640, 60));
		expect(view(dragging).hint?.placement).toBe("bottom");
	});
});

describe("view state", () => {
	test("crosshair and loupe on the pointer's display in idle; hidden over the hint bar", () => {
		const s = run(start(), ptr("move", 205, 152));
		const v = view(s);
		expect(v.crosshair).toBe(true);
		expect(v.loupe?.at).toEqual({ x: 229, y: 176 });
		expect(v.pointerDisplayId).toBe(1);
		const over = pickerView(s, { seq: 1, now: 0, overHint: true });
		expect(over.crosshair).toBe(false);
		expect(over.cursorStyle).toBe("default");
		expect(pickerView(s, { seq: 1, now: 0, showLoupe: false }).loupe).toBeNull();
	});

	test("Snip confirm drops the scrim (results layer); Live confirm keeps it until the overlay hides", () => {
		const snip = drag(start({ windows: [] }), { x: 100, y: 100 }, { x: 300, y: 200 });
		expect(view(snip).scrim).toBe(false);
		expect(view(snip).selection).toEqual(rect(100, 100, 200, 100));
		const live = drag(start({ windows: [] }, { x: 0, y: 0 }, "live"), { x: 100, y: 100 }, { x: 300, y: 200 });
		expect(view(live).scrim).toBe(true);
		expect(view(live).hint).toBeNull();
	});

	test("the egress and replace notices ride on the hint", () => {
		const v = pickerView(start({}, { x: 0, y: 0 }, "live"), {
			seq: 1,
			now: 0,
			egress: "Live will send text to X",
			liveRunning: true,
		});
		expect(v.hint).toMatchObject({ egress: "Live will send text to X", replacesLive: true });
	});
});

describe("PickerSession", () => {
	function session(o: { windows?: StaticWindowList; at?: Point } = {}) {
		let t = 0;
		const clock = { now: () => t, advance: (ms: number) => (t += ms) };
		const pointer = new FakePointer(o.at ?? { x: 640, y: 360 });
		const views: PickerViewState[] = [];
		const loupes: number[] = [];
		const outcomes: PickerOutcome[] = [];
		const logs: string[] = [];
		const sampler = new SolidPixelSampler();
		const s = new PickerSession({
			env: { displays: desk, os: "windows", confirmOnRelease: true },
			mode: "snip",
			probe: pointer,
			windows: o.windows ?? new StaticWindowList(WINDOWS),
			sampler,
			now: clock.now,
			onView: (v) => views.push(v),
			onLoupe: (p) => loupes.push(p.sequence),
			onDone: (x) => outcomes.push(x),
			log: (m) => logs.push(m),
		});
		return { s, clock, pointer, views, loupes, outcomes, logs, sampler };
	}
	const local = (x: number, y: number, phase: "down" | "move" | "up" = "move") => ({
		displayId: 1,
		phase,
		x,
		y,
		button: 0,
		mods: NO_MODIFIERS,
		detail: 1,
	});

	test("publishes on start; the window list arrives and turns on window candidates", async () => {
		const { s, views } = session({ at: { x: 205, y: 152 } });
		s.start();
		expect(views[0]?.candidate?.label).toBe("Screen · 1280 × 720");
		await Bun.sleep(0);
		expect(views.at(-1)?.candidate?.label).toBe("Messages · 400 × 520");
	});

	test("a failing window list is logged and the picker keeps working", async () => {
		const { s, logs, views } = session({ windows: new StaticWindowList([], true) });
		s.start();
		await Bun.sleep(0);
		expect(logs[0]).toContain("window list unavailable");
		s.pointer(local(10, 10));
		expect(views.at(-1)?.cursor).toEqual({ x: 10, y: 10 });
	});

	test("polls the cursor only when views are quiet", () => {
		const { s, clock, pointer } = session();
		s.start();
		s.pointer(local(100, 100));
		pointer.at = { x: 300, y: 300 };
		clock.advance(50);
		s.tick();
		expect(s.snapshot.cursor).toEqual({ x: 100, y: 100 });
		clock.advance(60);
		s.tick();
		expect(s.snapshot.cursor).toEqual({ x: 300, y: 300 });
	});

	test("samples the loupe at most every 33 ms and pushes the pixels", async () => {
		const { s, clock, loupes, sampler } = session();
		s.start();
		for (let i = 0; i < 10; i++) {
			s.tick();
			await Bun.sleep(0);
			clock.advance(10);
		}
		expect(loupes.length).toBe(3);
		expect(sampler.samples.length).toBe(3);
	});

	test("finishes once, stops the sampler, and ignores later input", () => {
		const { s, outcomes, sampler } = session();
		s.start();
		s.pointer(local(100, 100, "down"));
		s.pointer(local(200, 200));
		s.pointer(local(300, 250, "up"));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.kind).toBe("confirmed");
		expect(sampler.stopped).toBe(1);
		s.key({ displayId: 1, key: "Escape", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(outcomes).toHaveLength(1);
		expect(s.done).toBe(true);
	});

	test("held Enter doesn't repeat; identical frames aren't re-sent", () => {
		const { s, views, outcomes } = session();
		s.start();
		s.key({ displayId: 1, key: "ArrowUp", down: true, repeat: false, mods: NO_MODIFIERS });
		s.key({ displayId: 1, key: "Enter", down: true, repeat: true, mods: NO_MODIFIERS });
		expect(outcomes).toHaveLength(0);
		const n = views.length;
		s.measured(1, {});
		expect(views.length).toBe(n);
	});
});
