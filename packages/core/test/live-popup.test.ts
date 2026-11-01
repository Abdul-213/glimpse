// GLIM-79: the docked Live popup's pure rules (live-popup.md §3 docking, §2.2 strip widths,
// §4 staleness, §8 the 600 ms hold, §2.5 change marks, §10 announcement text).
import { describe, expect, test } from "bun:test";
import {
	announcementText,
	type Display,
	heldBlocks,
	initialLivePopupState,
	LIVE_HOLD_MS,
	type LiveBlockUpdate,
	type LivePopupAction,
	type LivePopupState,
	type LiveSessionEvent,
	languageCode,
	listedLiveBlocks,
	livePopupFrame,
	liveShowsEmpty,
	liveStrip,
	placeLivePopup,
	type Rect,
	rect,
	reduceLivePopup,
	revealedTranslations,
	skippedLiveBlocks,
	staleAge,
	stripLayout,
} from "@glimpse/core";

const display = (workArea: Rect = rect(0, 0, 1440, 900), scaleFactor = 1): Display => ({
	id: 1,
	bounds: workArea,
	workArea,
	scaleFactor,
	isPrimary: true,
});

describe("placeLivePopup (§3)", () => {
	const d = [display()];
	test("subtitle strip at the bottom: above, centred, 640 wide, bottom anchored 8px above", () => {
		const p = placeLivePopup(rect(120, 760, 1200, 100), d);
		expect(p?.side).toBe("above");
		expect(p?.width).toBe(640);
		expect(p?.x).toBe(120 + 600 - 320);
		expect(p?.anchor).toBe("bottom");
		expect(p?.y).toBe(752);
		expect(p?.maxHeight).toBeCloseTo(0.4 * 900);
	});
	test("dialogue box mid-screen: below, its top fixed", () => {
		const p = placeLivePopup(rect(400, 300, 600, 150), d);
		expect(p?.side).toBe("below");
		expect(p?.anchor).toBe("top");
		expect(p?.y).toBe(458);
		expect(p?.width).toBe(600);
	});
	test("a tall chat pane on the left: inline-end side, top aligned, at most 400 wide", () => {
		const p = placeLivePopup(rect(20, 20, 400, 860), d);
		expect(p?.side).toBe("inline-end");
		expect(p?.x).toBe(428);
		expect(p?.width).toBe(400);
		expect(p?.y).toBe(20);
		expect(p?.maxHeight).toBeCloseTo(720);
	});
	test("RTL UI: inline-end is the left", () => {
		const p = placeLivePopup(rect(1020, 20, 400, 860), d, { uiDir: "rtl" });
		expect(p?.side).toBe("inline-end");
		expect(p?.x).toBe(1020 - 8 - 400);
	});
	test("narrow label: width clamps up to 240, clamped into the work area", () => {
		const p = placeLivePopup(rect(2, 400, 60, 20), d);
		expect(p?.width).toBe(240);
		expect(p?.x).toBe(8);
	});
	test("whole screen pinned: inside, top inline-end corner, never off the work area", () => {
		const p = placeLivePopup(rect(0, 0, 1440, 900), d);
		expect(p?.side).toBe("inside");
		expect(p?.anchor).toBe("top");
		expect(p ? p.x + p.width : 0).toBe(1440 - 8);
		expect(p?.y).toBe(8);
	});
	test("the popup never covers the region unless inside is the only option", () => {
		const regions = [
			rect(100, 100, 300, 50),
			rect(0, 820, 1440, 80),
			rect(1000, 0, 440, 900),
			rect(600, 380, 200, 100),
		];
		for (const r of regions) {
			const p = placeLivePopup(r, d);
			if (!p || p.side === "inside") throw new Error("expected a docked side");
			const f = livePopupFrame(p, p.maxHeight);
			const overlap = f.x < r.x + r.width && r.x < f.x + f.width && f.y < r.y + r.height && r.y < f.y + f.height;
			expect(overlap).toBe(false);
		}
	});
	test("frame: the anchored edge stays put as the content grows", () => {
		const p = placeLivePopup(rect(120, 760, 1200, 100), d);
		if (!p) throw new Error("no placement");
		const small = livePopupFrame(p, 90);
		const big = livePopupFrame(p, 200);
		expect(small.y + small.height).toBe(752);
		expect(big.y + big.height).toBe(752);
		expect(livePopupFrame(p, 10).height).toBe(80);
	});
});

test("stripLayout breakpoints (§2.2)", () => {
	expect(stripLayout(240)).toBe("compact");
	expect(stripLayout(299)).toBe("compact");
	expect(stripLayout(300)).toBe("regular");
	expect(stripLayout(360)).toBe("wide");
});

test("staleAge (§4)", () => {
	expect(staleAge(0, 59_000)).toEqual({ kind: "now" });
	expect(staleAge(0, 4 * 60_000 + 5)).toEqual({ kind: "min", n: 4 });
	expect(staleAge(0, 3_600_000)).toEqual({ kind: "hour" });
});

test("announcementText joins in reading order, max 300 with an ellipsis (§10)", () => {
	expect(announcementText(["The north door is locked.", "Talk to the guard first"])).toBe(
		"The north door is locked. Talk to the guard first",
	);
	expect(announcementText(["a", "b"])).toBe("a. b");
	const long = announcementText(["word ".repeat(100)]);
	expect(long.length).toBeLessThanOrEqual(300);
	expect(long.endsWith("…")).toBe(true);
	expect(announcementText(["", "  "])).toBe("");
});

// ---- reducer -------------------------------------------------------------------------

const S = "s1";
const block = (id: string, source: string, over: Partial<LiveBlockUpdate> = {}): LiveBlockUpdate => ({
	id,
	order: 0,
	cls: "translate",
	lang: languageCode("ja"),
	direction: "ltr",
	box: rect(0, 0, 100, 20),
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
	region: rect(0, 0, 800, 90),
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
	region: rect(0, 0, 800, 90),
	image: { width: 800, height: 90 },
});
const tr = (seq: number, id: string, text: string, final = true): LiveSessionEvent => ({
	type: "translation",
	sessionId: S,
	frameSeq: seq,
	id,
	text,
	final,
	failed: false,
});
const status = (s: Extract<LiveSessionEvent, { type: "status" }>["status"], over: object = {}): LiveSessionEvent => ({
	type: "status",
	sessionId: S,
	status: s,
	reason: null,
	error: null,
	stale: s === "paused" || s === "error",
	capturedAt: null,
	at: 0,
	...over,
});

function run(events: (LiveSessionEvent | LivePopupAction)[], from: LivePopupState = initialLivePopupState) {
	let s = from;
	const states: LivePopupState[] = [];
	for (const e of events) {
		const own = ["session", "holdExpired", "private", "skipped"].includes(e.type);
		const action = own ? (e as LivePopupAction) : { type: "session" as const, event: e as LiveSessionEvent };
		s = reduceLivePopup(s, action);
		states.push(s);
	}
	return { s, states };
}

const firstFill = () =>
	run([
		opened,
		status("starting"),
		frame(1, [block("L1", "北の扉は施錠されている。"), block("L2", "まず衛兵と話して。", { order: 1 })], ["L1", "L2"]),
		status("live"),
		tr(1, "L1", "The north door is locked."),
		tr(1, "L2", "Talk to the guard first."),
	]).s;

describe("reduceLivePopup", () => {
	test("first fill: pending source, then translations, nothing marked (L0)", () => {
		const s = firstFill();
		expect(s.status).toBe("live");
		expect(s.blocks.map((b) => b.translation)).toEqual(["The north door is locked.", "Talk to the guard first."]);
		expect(s.blocks.every((b) => b.changeId === null && !b.pending)).toBe(true);
	});

	test("a changed block holds its old translation, then swaps and flashes once (§8)", () => {
		const s0 = firstFill();
		const s1 = reduceLivePopup(s0, {
			type: "session",
			event: frame(2, [block("L2", "塔の鍵を探して。", { order: 1, changed: true })], ["L1", "L2"], ["L2"]),
		});
		const l2 = s1.blocks[1];
		expect(l2?.holding).toBe(true);
		expect(l2?.translation).toBe("Talk to the guard first.");
		expect(l2?.changeId).toBeNull();
		expect(heldBlocks(s0, s1)).toEqual([{ id: "L2", frameSeq: 2 }]);
		// Unchanged L1 is the same object: the view keeps its node.
		expect(s1.blocks[0]).toBe(s0.blocks[0]);
		const s2 = reduceLivePopup(s1, { type: "session", event: tr(2, "L2", "Look for the key in the tower.") });
		expect(s2.blocks[1]?.translation).toBe("Look for the key in the tower.");
		expect(s2.blocks[1]?.changeId).toBe(s2.changeSeq);
		expect(revealedTranslations(s1, s2)).toEqual(["Look for the key in the tower."]);
		// The hold timer firing late changes nothing.
		expect(reduceLivePopup(s2, { type: "holdExpired", id: "L2", frameSeq: 2 })).toBe(s2);
	});

	test("hold runs out: the new source shows pending and flashes; the late translation does not flash again", () => {
		const s0 = firstFill();
		const { s: held } = run(
			[frame(2, [block("L2", "塔の鍵を探して。", { order: 1, changed: true })], ["L1", "L2"], ["L2"])],
			s0,
		);
		const expired = reduceLivePopup(held, { type: "holdExpired", id: "L2", frameSeq: 2 });
		const b = expired.blocks[1];
		expect(b?.pending).toBe(true);
		expect(b?.changeId).toBe(1);
		const late = reduceLivePopup(expired, { type: "session", event: tr(2, "L2", "Look for the key.") });
		expect(late.blocks[1]?.changeId).toBe(1);
		expect(late.blocks[1]?.pending).toBe(false);
		expect(revealedTranslations(expired, late)).toEqual(["Look for the key."]);
	});

	test("a new change set clears the previous marks; neutral updates are silent", () => {
		const s0 = firstFill();
		const { s: s1 } = run(
			[frame(2, [block("L1", "x", { changed: true, translation: "X" })], ["L1", "L2"], ["L1"])],
			s0,
		);
		expect(s1.blocks[0]?.changeId).toBe(1);
		const { s: s2 } = run(
			[frame(3, [block("L2", "y", { order: 1, changed: true, translation: "Y" })], ["L1", "L2"], ["L2"])],
			s1,
		);
		expect(s2.blocks[0]?.changeId).toBeNull();
		expect(s2.blocks[1]?.changeId).toBe(2);
		const { s: s3 } = run([frame(4, [block("N", "HP 82/100", { cls: "neutral", order: 2 })], ["L1", "L2", "N"])], s2);
		expect(s3.blocks[1]?.changeId).toBe(2);
		expect(s3.blocks[2]?.changeId).toBeNull();
		expect(revealedTranslations(s2, s3)).toEqual([]);
	});

	test("older translations for a block are dropped (frameSeq)", () => {
		const s0 = firstFill();
		const { s: s1 } = run([frame(3, [block("L1", "新", { changed: true })], ["L1", "L2"], ["L1"])], s0);
		const s2 = reduceLivePopup(s1, { type: "session", event: tr(2, "L1", "stale result") });
		expect(s2).toBe(s1);
	});

	test("pause is stale, resume is fresh; empty shows the L7 row; stop closes", () => {
		const s0 = firstFill();
		const paused = reduceLivePopup(s0, {
			type: "session",
			event: status("paused", { reason: "user", capturedAt: 1000 }),
		});
		expect(paused.stale).toBe(true);
		expect(liveStrip(paused)).toEqual({ dot: "paused", label: "paused" });
		expect(liveStrip(reduceLivePopup(paused, { type: "session", event: status("error") })).dot).toBe("error");
		const { s: empty } = run([{ ...frame(2, [], []), removes: ["L1", "L2"] } as LiveSessionEvent, status("empty")], s0);
		expect(liveShowsEmpty(empty)).toBe(true);
		const closed = reduceLivePopup(empty, { type: "session", event: status("stopped") });
		expect(closed.status).toBe("closed");
		expect(closed.sessionId).toBeNull();
	});

	test("consent: the question shows until the session's first status", () => {
		const { s } = run([
			opened,
			{
				type: "consent",
				sessionId: S,
				providers: [{ id: "g", kind: "cloud", name: "Google" }],
				canRemember: true,
				reason: "cloud-translation",
			},
		]);
		expect(s.status).toBe("consent");
		expect(liveStrip(s).dot).toBe("consent");
		const started = reduceLivePopup(s, { type: "session", event: status("starting") });
		expect(started.consent).toBeNull();
	});

	test("events for another session are ignored; skipped expansion persists", () => {
		const s0 = firstFill();
		expect(reduceLivePopup(s0, { type: "session", event: { ...tr(1, "L1", "x"), sessionId: "other" } })).toBe(s0);
		const x = reduceLivePopup(s0, { type: "skipped", expanded: true });
		expect(x.skippedExpanded).toBe(true);
		const { s } = run(
			[frame(2, [block("K", "안녕", { cls: "skip", lang: languageCode("ko"), order: 2 })], ["L1", "L2", "K"])],
			x,
		);
		expect(s.skippedExpanded).toBe(true);
		expect(s.blocks[2]?.changeId).toBeNull();
	});

	test("hold constant", () => expect(LIVE_HOLD_MS).toBe(600));
});

describe("skipped blocks in Live (GLIM-82)", () => {
	test("skip-class blocks leave the list for the skipped line, keep their original text, never marked", () => {
		const s0 = firstFill();
		const { s } = run(
			[
				frame(
					2,
					[block("K", "Bis morgen!", { cls: "skip", lang: languageCode("de"), order: 2, changed: false })],
					["L1", "L2", "K"],
				),
			],
			s0,
		);
		expect(listedLiveBlocks(s).map((b) => b.id)).toEqual(["L1", "L2"]);
		expect(skippedLiveBlocks(s).map((b) => [b.source, b.translation, b.changeId])).toEqual([
			["Bis morgen!", null, null],
		]);
		// A class flip (hysteresis rarely allows it) moves the block without a mark.
		const { s: flipped } = run(
			[frame(3, [block("K", "Bis morgen!", { order: 2, translation: "See you tomorrow!" })], ["L1", "L2", "K"])],
			s,
		);
		expect(listedLiveBlocks(flipped).map((b) => b.id)).toEqual(["L1", "L2", "K"]);
		expect(flipped.blocks[2]?.changeId).toBeNull();
	});
});
