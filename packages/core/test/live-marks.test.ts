// GLIM-154: Live's numbered markers and overlay cards over the pinned region: stable numbers
// across updates, the reducer's overlay / pick / screen-hover actions, and which marks show
// for each Live state (600 ms hold, pending, change set, skipped, paused, empty, consent).
import { describe, expect, test } from "bun:test";
import {
	initialLivePopupState,
	type LiveBlockUpdate,
	type LivePopupAction,
	type LivePopupState,
	type LiveSessionEvent,
	languageCode,
	liveBlockNumbers,
	liveMarks,
	rect,
	reduceLivePopup,
} from "@glimpse/core";

describe("liveBlockNumbers", () => {
	const blocks = (...ids: string[]) => ids.map((id) => ({ id, cls: "translate" as const }));
	test("first fill: reading order from 1, neutral blocks get none", () => {
		const n = liveBlockNumbers(new Map(), [
			{ id: "a", cls: "translate" },
			{ id: "b", cls: "neutral" },
			{ id: "c", cls: "skip" },
			{ id: "d", cls: "target" },
		]);
		expect([...n]).toEqual([
			["a", 1],
			["c", 2],
			["d", 3],
		]);
	});
	test("blocks that stay keep their numbers; new ones take the smallest free numbers in reading order", () => {
		const first = liveBlockNumbers(new Map(), blocks("a", "b", "c"));
		// b left; x appears before a, y after c.
		const second = liveBlockNumbers(first, blocks("x", "a", "c", "y"));
		expect(second.get("a")).toBe(1);
		expect(second.get("c")).toBe(3);
		expect(second.get("x")).toBe(2);
		expect(second.get("y")).toBe(4);
		expect([...second.keys()]).toEqual(["x", "a", "c", "y"]);
	});
	test("a page turn (every block new) starts again at 1", () => {
		const first = liveBlockNumbers(new Map(), blocks("a", "b", "c"));
		expect([...liveBlockNumbers(first, blocks("p", "q"))]).toEqual([
			["p", 1],
			["q", 2],
		]);
	});
	test("a block turning neutral loses its number, which is free again", () => {
		const first = liveBlockNumbers(new Map(), blocks("a", "b"));
		const second = liveBlockNumbers(first, [
			{ id: "a", cls: "neutral" },
			{ id: "b", cls: "translate" },
			{ id: "c", cls: "translate" },
		]);
		expect([...second]).toEqual([
			["b", 2],
			["c", 1],
		]);
	});
});

// ---- reducer and marks ----------------------------------------------------------------

const S = "s1";
const REGION = rect(100, 200, 400, 300);
const block = (id: string, source: string, over: Partial<LiveBlockUpdate> = {}): LiveBlockUpdate => ({
	id,
	order: 0,
	cls: "translate",
	lang: languageCode("ja"),
	direction: "ltr",
	box: rect(0, 0, 100, 40),
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
	capturedAt: 1000 * seq,
	reused: false,
	region: REGION,
	// The capture is at 2x: boxes are in image px.
	image: { width: 800, height: 600 },
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
const status = (s: Extract<LiveSessionEvent, { type: "status" }>["status"]): LiveSessionEvent => ({
	type: "status",
	sessionId: S,
	status: s,
	reason: s === "paused" ? "user" : null,
	error: null,
	stale: s === "paused",
	capturedAt: null,
	at: 0,
});

function run(events: (LiveSessionEvent | LivePopupAction)[], from: LivePopupState = initialLivePopupState) {
	let s = from;
	for (const e of events) {
		const own = ["session", "holdExpired", "private", "skipped", "toggleOverlay", "select", "screenHover"].includes(
			e.type,
		);
		s = reduceLivePopup(s, own ? (e as LivePopupAction) : { type: "session", event: e as LiveSessionEvent });
	}
	return s;
}

const twoBubbles = [
	opened,
	status("live"),
	frame(
		1,
		[
			block("a", "おはよう", { order: 0, box: rect(20, 40, 200, 80), translation: "Good morning" }),
			block("b", "ありがとう", { order: 1, box: rect(400, 300, 160, 100), translation: "Thanks" }),
		],
		["a", "b"],
	),
];

describe("Live popup state (GLIM-154)", () => {
	test("blocks are numbered at the first fill and keep their numbers across updates", () => {
		const s1 = run(twoBubbles);
		expect(s1.blocks.map((b) => [b.id, b.badge])).toEqual([
			["a", 1],
			["b", 2],
		]);
		// a leaves, c arrives before b: b stays 2, c takes the free 1.
		const s2 = run(
			[
				frame(
					2,
					[block("c", "さようなら", { order: 0, box: rect(20, 40, 200, 80), changed: true })],
					["c", "b"],
					["c"],
				),
			],
			s1,
		);
		expect(s2.blocks.map((b) => [b.id, b.badge])).toEqual([
			["c", 1],
			["b", 2],
		]);
		// A translation for c keeps its number.
		expect(run([tr(2, "c", "Goodbye")], s2).blocks[0]?.badge).toBe(1);
	});

	test("overlay toggles per session; a new session starts with it off", () => {
		const s = run([...twoBubbles, { type: "toggleOverlay" }]);
		expect(s.overlay).toBe(true);
		expect(run([{ type: "toggleOverlay", on: false }], s).overlay).toBe(false);
		expect(run([{ ...opened, sessionId: "s2" }], s).overlay).toBe(false);
		// Nothing pinned: no overlay.
		expect(reduceLivePopup(initialLivePopupState, { type: "toggleOverlay", on: true }).overlay).toBe(false);
	});

	test("a pick on screen selects the block (new seq each time); it ends when the block leaves", () => {
		const s1 = run([...twoBubbles, { type: "select", id: "b" }]);
		expect(s1.selected).toEqual({ id: "b", seq: 1 });
		const s2 = run([{ type: "select", id: "b" }], s1);
		expect(s2.selected).toEqual({ id: "b", seq: 2 });
		expect(run([{ type: "select", id: "nope" }], s2)).toBe(s2);
		const s3 = run([frame(2, [], ["a"])], s2);
		expect(s3.selected).toBeNull();
	});

	test("picking a skipped block expands the skipped line", () => {
		const s = run([
			opened,
			frame(1, [block("a", "x", { translation: "y" }), block("k", "hello", { order: 1, cls: "skip" })], ["a", "k"]),
			{ type: "select", id: "k" },
		]);
		expect(s.skippedExpanded).toBe(true);
	});

	test("screen hover links a block; unknown ids clear it", () => {
		const s = run([...twoBubbles, { type: "screenHover", id: "a" }]);
		expect(s.screenLinked).toBe("a");
		expect(run([{ type: "screenHover", id: "zz" }], s).screenLinked).toBeNull();
	});
});

describe("liveMarks", () => {
	test("badges sit on boxes mapped to global logical px; cards only in overlay mode", () => {
		const s = run(twoBubbles);
		const m = liveMarks(s);
		expect(m.badges.map((b) => [b.id, b.n])).toEqual([
			["a", 1],
			["b", 2],
		]);
		// Image px at 2x → logical, offset by the region.
		expect(m.badges[0]?.rect).toEqual(rect(110, 220, 100, 40));
		expect(m.cards).toEqual([]);
		const o = liveMarks(run([{ type: "toggleOverlay", on: true }], s), { target: languageCode("en") });
		expect(o.cards.map((c) => [c.id, c.text, c.dir])).toEqual([
			["a", "Good morning", "ltr"],
			["b", "Thanks", "ltr"],
		]);
	});

	test("one numbered block: no badge (nothing to match), but its card still shows", () => {
		const s = run([
			opened,
			{ type: "toggleOverlay", on: true },
			frame(1, [block("a", "字幕", { translation: "Subtitle" })], ["a"]),
		]);
		const m = liveMarks(s);
		expect(m.badges).toEqual([]);
		expect(m.cards.map((c) => c.text)).toEqual(["Subtitle"]);
	});

	test("600 ms hold: the card keeps the old translation; pending after the hold shows no card; the new one is marked changed", () => {
		const on = run([...twoBubbles, { type: "toggleOverlay", on: true }]);
		const held = run(
			[frame(2, [block("a", "こんばんは", { box: rect(20, 40, 200, 80), changed: true })], ["a", "b"], ["a"])],
			on,
		);
		expect(liveMarks(held).cards.find((c) => c.id === "a")).toMatchObject({ text: "Good morning", changed: false });
		const expired = run([{ type: "holdExpired", id: "a", frameSeq: 2 }], held);
		expect(liveMarks(expired).cards.map((c) => c.id)).toEqual(["b"]);
		// The badge stays while pending.
		expect(liveMarks(expired).badges.map((b) => b.id)).toEqual(["a", "b"]);
		const landed = run([tr(2, "a", "Good evening")], expired);
		expect(liveMarks(landed).cards.find((c) => c.id === "a")).toMatchObject({ text: "Good evening", changed: true });
		expect(liveMarks(landed).cards.find((c) => c.id === "b")?.changed).toBe(false);
	});

	test("skipped, neutral, failed and pack-waiting blocks get no card; skipped badges are dashed", () => {
		const s = run([
			opened,
			{ type: "toggleOverlay", on: true },
			frame(
				1,
				[
					block("a", "x", { order: 0, translation: "y" }),
					block("k", "hello", { order: 1, cls: "skip" }),
					block("n", "100", { order: 2, cls: "neutral" }),
					block("f", "z", { order: 3, failed: true }),
					block("w", "q", { order: 4, waitingForPack: true }),
				],
				["a", "k", "n", "f", "w"],
			),
		]);
		const m = liveMarks(s);
		expect(m.cards.map((c) => c.id)).toEqual(["a"]);
		expect(m.badges.map((b) => [b.id, b.dashed])).toEqual([
			["a", false],
			["k", true],
			["f", false],
			["w", false],
		]);
	});

	test("lit: popup hover, screen hover or a pick", () => {
		const s = run(twoBubbles);
		expect(liveMarks(s, { linkedId: "b" }).badges.map((b) => b.lit)).toEqual([false, true]);
		expect(liveMarks(run([{ type: "screenHover", id: "a" }], s)).badges.map((b) => b.lit)).toEqual([true, false]);
		expect(liveMarks(run([{ type: "select", id: "b" }], s)).badges.map((b) => b.lit)).toEqual([false, true]);
	});

	test("paused: marks stay, stale; consent, empty and closed: none", () => {
		const s = run([...twoBubbles, { type: "toggleOverlay", on: true }]);
		const paused = run([status("paused")], s);
		expect(liveMarks(paused).stale).toBe(true);
		expect(liveMarks(paused).cards).toHaveLength(2);
		const empty = run([frame(2, [], []), status("empty")], s);
		expect(liveMarks(empty).badges).toEqual([]);
		expect(liveMarks(run([status("stopped")], s)).badges).toEqual([]);
		const consent = run([
			opened,
			{
				type: "consent",
				sessionId: S,
				providers: [],
				canRemember: false,
				reason: "cloud-translation",
			} as LiveSessionEvent,
		]);
		expect(liveMarks(consent)).toEqual({ badges: [], cards: [], stale: false });
	});

	test("RTL target: cards are right-to-left", () => {
		const s = run([...twoBubbles, { type: "toggleOverlay", on: true }]);
		expect(liveMarks(s, { target: languageCode("ar") }).cards[0]?.dir).toBe("rtl");
	});
});
