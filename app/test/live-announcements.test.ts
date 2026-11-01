// GLIM-92: screen-reader announcements for Live changes (live-popup.md §10). The core
// LiveAnnouncer (coalescing, rate limit, 300 characters) and the app's LiveAnnouncements
// (setting, screen-reader detection at session start, native only while unfocused).
import { describe, expect, test } from "bun:test";
import {
	initialLivePopupState,
	LiveAnnouncer,
	type LiveBlockUpdate,
	type LivePopupState,
	type LiveSessionEvent,
	languageCode,
	nullLogger,
	rect,
	reduceLivePopup,
	type Settings,
} from "@glimpse/core";
import { ManualTimers } from "@glimpse/core/testing";
import { LiveAnnouncements } from "../src/bun/windows/live-announcements.ts";

describe("LiveAnnouncer", () => {
	test("coalesces a change set, at most one announcement per 1.5 s, 300 characters", async () => {
		const timers = new ManualTimers(0);
		const out: [number, string][] = [];
		const a = new LiveAnnouncer({ timers, emit: (t) => out.push([timers.now(), t]) });
		a.change(["The north door is locked."]);
		await timers.advance(400);
		a.change(["Talk to the guard first."]); // the held block, 400 ms later: same announcement
		await timers.advance(400);
		expect(out).toEqual([[700, "The north door is locked. Talk to the guard first."]]);
		a.change(["One"]);
		await timers.advance(100);
		a.change(["Two"]);
		await timers.advance(2000);
		// Not before 700 + 1500.
		expect(out[1]).toEqual([2200, "One. Two"]);
		a.change(["x".repeat(500)]);
		await timers.advance(5000);
		expect(out[2]?.[1].length).toBeLessThanOrEqual(300);
	});

	test("status is spoken at once; clear drops what waits", async () => {
		const timers = new ManualTimers(0);
		const out: string[] = [];
		const a = new LiveAnnouncer({ timers, emit: (t, k) => out.push(`${k}:${t}`) });
		a.change(["pending"]);
		a.status("Live paused");
		a.clear();
		await timers.advance(5000);
		expect(out).toEqual(["status:Live paused"]);
	});
});

const S = "s";
const up = (id: string, source: string, translation: string | null, changed = false): LiveBlockUpdate => ({
	id,
	order: 0,
	cls: "translate",
	lang: languageCode("es"),
	direction: "ltr",
	box: rect(0, 0, 1, 1),
	source,
	translation,
	failed: false,
	waitingForPack: false,
	changed,
});
const ev = {
	opened: {
		type: "opened",
		sessionId: S,
		region: rect(0, 0, 10, 10),
		providers: { cloud: null, localOnly: false },
		private: false,
	} as LiveSessionEvent,
	frame: (seq: number, u: LiveBlockUpdate[], changeSet: string[]): LiveSessionEvent => ({
		type: "frame",
		sessionId: S,
		frameSeq: seq,
		upserts: u,
		removes: [],
		order: u.map((b) => b.id),
		changeSet,
		capturedAt: 0,
		reused: false,
		region: rect(0, 0, 10, 10),
		image: { width: 10, height: 10 },
	}),
	status: (status: "live" | "paused"): LiveSessionEvent => ({
		type: "status",
		sessionId: S,
		status,
		reason: status === "paused" ? "user" : null,
		error: null,
		stale: status === "paused",
		capturedAt: 0,
		at: 0,
	}),
	stopped: {
		type: "status",
		sessionId: S,
		status: "stopped",
		reason: null,
		error: null,
		stale: true,
		capturedAt: 0,
		at: 0,
	} as LiveSessionEvent,
};

function harness(mode: Settings["live"]["announceChanges"], reader: boolean | null, focused = false) {
	const timers = new ManualTimers(0);
	let listener: ((p: LivePopupState, n: LivePopupState) => void) | null = null;
	let state = initialLivePopupState;
	const popup = {
		onChange: (l: (p: LivePopupState, n: LivePopupState) => void) => {
			listener = l;
			return () => {};
		},
		focused,
	};
	const posted: string[] = [];
	const spoken: string[] = [];
	const a = new LiveAnnouncements({
		popup,
		post: (_id, t, k) => posted.push(`${k}:${t}`),
		speak: (t) => {
			spoken.push(t);
			return true;
		},
		screenReaderActive: () => reader,
		mode: () => mode,
		timers,
		log: nullLogger,
	});
	const feed = (e: LiveSessionEvent) => {
		const prev = state;
		state = reduceLivePopup(prev, { type: "session", event: e });
		if (state !== prev) listener?.(prev, state);
	};
	return { a, feed, timers, posted, spoken };
}

describe("LiveAnnouncements (GLIM-92)", () => {
	const session = async (h: ReturnType<typeof harness>) => {
		h.feed(ev.opened);
		h.feed(ev.frame(1, [up("L1", "uno", "one")], [])); // first fill: never announced
		h.feed(ev.frame(2, [up("L1", "dos", "Two.", true)], ["L1"]));
		await h.timers.advance(1000);
		h.feed(ev.status("paused"));
		h.feed(ev.status("live"));
		await h.timers.advance(1000);
	};

	test("auto + a screen reader: changes and status go to the view and, unfocused, to the OS", async () => {
		const h = harness("auto", true);
		await session(h);
		expect(h.posted).toEqual(["change:Two.", "status:Live paused", "status:Live resumed"]);
		expect(h.spoken).toEqual(["Two.", "Live paused", "Live resumed"]);
	});

	test("auto without a screen reader, or off: silent", async () => {
		for (const h of [harness("auto", false), harness("auto", null), harness("off", true)]) {
			await session(h);
			expect(h.posted).toEqual([]);
		}
	});

	test("on: always; focused popup reads its own regions, so nothing native", async () => {
		const h = harness("on", false, true);
		await session(h);
		expect(h.posted.length).toBe(3);
		expect(h.spoken).toEqual([]);
	});

	test("stop drops a pending announcement", async () => {
		const h = harness("on", false);
		h.feed(ev.opened);
		h.feed(ev.frame(1, [up("L1", "uno", "one")], []));
		h.feed(ev.frame(2, [up("L1", "dos", "two", true)], ["L1"]));
		h.feed(ev.stopped);
		await h.timers.advance(5000);
		expect(h.posted).toEqual([]);
	});
});
