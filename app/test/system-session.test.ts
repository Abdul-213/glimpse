// GLIM-119 / GLIM-107: OS lock and sleep events -> Live pause / resume and cache wipes.
import { describe, expect, test } from "bun:test";
import { createLogger, type LogRecord } from "@glimpse/core";
import { ManualTimers } from "@glimpse/core/testing";
import {
	type SessionEventKind,
	type SessionNativeBinding,
	sessionKindFor,
	sessionSourceName,
} from "../src/bun/native/session.ts";
import { PresenceTracker } from "../src/bun/services/session/presence.ts";
import { SystemSession, type SystemSessionEvent } from "../src/bun/services/session/system-session.ts";

function tracker(resumeDelayMs?: number) {
	const calls: string[] = [];
	const timers = new ManualTimers();
	const t = new PresenceTracker(
		{
			pause: (r) => calls.push(`pause:${r}`),
			resume: (r) => calls.push(`resume:${r}`),
			wipe: (r) => calls.push(`wipe:${r}`),
		},
		timers,
		resumeDelayMs === undefined ? {} : { resumeDelayMs },
	);
	const run = async (...kinds: SessionEventKind[]) => {
		for (const k of kinds) t.handle(k);
	};
	return { t, calls, timers, run };
}

describe("PresenceTracker", () => {
	test("lock pauses and wipes at once; unlock resumes after the delay", async () => {
		const { calls, timers, run } = tracker();
		await run("lock");
		expect(calls).toEqual(["wipe:lock", "pause:locked"]);
		await run("unlock");
		expect(calls).toHaveLength(2);
		await timers.advance(999);
		expect(calls).toHaveLength(2);
		await timers.advance(1);
		expect(calls).toEqual(["wipe:lock", "pause:locked", "resume:locked"]);
	});

	test("sleep and wake do the same with the sleep reason", async () => {
		const { calls, timers, run } = tracker();
		await run("sleep", "wake");
		await timers.advance(1_000);
		expect(calls).toEqual(["wipe:sleep", "pause:sleep", "resume:sleep"]);
	});

	test("repeated notifications are folded (lid close: screens sleep, lock, system sleep)", async () => {
		const { calls, timers, run } = tracker();
		await run("sleep", "lock", "sleep", "lock");
		expect(calls).toEqual(["wipe:sleep", "pause:sleep", "wipe:lock"]);
		// Two wake notifications, then the unlock: one resume, with the first reason.
		await run("wake", "wake");
		await timers.advance(5_000);
		expect(calls).toHaveLength(3);
		await run("unlock");
		await timers.advance(1_000);
		expect(calls).toEqual(["wipe:sleep", "pause:sleep", "wipe:lock", "resume:sleep"]);
	});

	test("waking into the lock screen stays paused until unlock", async () => {
		const { t, calls, timers, run } = tracker();
		await run("lock", "sleep", "wake");
		await timers.advance(10_000);
		expect(calls.filter((c) => c.startsWith("resume"))).toEqual([]);
		expect(t.state).toMatchObject({ locked: true, asleep: false, pausedFor: "locked" });
		await run("unlock");
		await timers.advance(1_000);
		expect(calls.at(-1)).toBe("resume:locked");
		expect(t.state).toEqual({ locked: false, asleep: false, pausedFor: null, resumePending: false });
	});

	test("a lock right after a wake cancels the pending resume (debounce)", async () => {
		const { calls, timers, run } = tracker();
		await run("sleep", "wake");
		await timers.advance(400);
		await run("lock");
		await timers.advance(5_000);
		expect(calls).toEqual(["wipe:sleep", "pause:sleep", "wipe:lock"]);
		await run("unlock");
		await timers.advance(1_000);
		expect(calls.at(-1)).toBe("resume:sleep");
	});

	test("unlock or wake without a pause does nothing", async () => {
		const { calls, timers, run } = tracker();
		await run("unlock", "wake");
		await timers.advance(5_000);
		expect(calls).toEqual([]);
	});

	test("every new lock or sleep wipes again", async () => {
		const { calls, timers, run } = tracker(0);
		await run("lock", "unlock");
		await timers.advance(0);
		await run("lock");
		expect(calls.filter((c) => c === "wipe:lock")).toHaveLength(2);
	});

	test("dispose cancels a pending resume", async () => {
		const { t, calls, timers, run } = tracker();
		await run("lock", "unlock");
		t.dispose();
		await timers.advance(5_000);
		expect(calls).toEqual(["wipe:lock", "pause:locked"]);
	});
});

describe("session native mapping", () => {
	test("codes and sources", () => {
		expect([1, 2, 3, 4, 0, 5].map(sessionKindFor)).toEqual(["lock", "unlock", "sleep", "wake", null, null]);
		expect(sessionSourceName("macos", 1)).toBe("screenIsLocked");
		expect(sessionSourceName("windows", 3)).toBe("PBT_APMSUSPEND");
		expect(sessionSourceName("windows", 42)).toBe("source 42");
	});
});

class FakeSessionBinding implements SessionNativeBinding {
	listener: ((kind: SessionEventKind, source: string) => void) | null = null;
	startStatus = 0;
	stopped = 0;
	sessionStart(onEvent: (kind: SessionEventKind, source: string) => void): number {
		if (this.startStatus !== 0) return this.startStatus;
		this.listener = onEvent;
		return 0;
	}
	sessionStop(): void {
		this.stopped++;
		this.listener = null;
	}
	sessionSimulate(kind: SessionEventKind): number {
		this.listener?.(kind, "simulated");
		return 0;
	}
	sessionPump(): void {}
	sessionInfo(): Record<string, number> {
		return { running: this.listener ? 1 : 0 };
	}
}

function logger() {
	const records: LogRecord[] = [];
	return { records, log: createLogger({ sinks: [{ write: (r) => records.push(r) }], level: "debug" }) };
}

describe("SystemSession", () => {
	test("delivers typed events to subscribers and stops on dispose", () => {
		const binding = new FakeSessionBinding();
		const { log } = logger();
		const session = new SystemSession({ binding, log, now: () => 42 });
		const got: SystemSessionEvent[] = [];
		session.subscribe((e) => got.push(e));
		expect(session.start()).toEqual({ state: "running" });
		expect(session.start()).toEqual({ state: "running" });
		binding.sessionSimulate("lock");
		binding.listener?.("wake", "didWake");
		expect(got).toEqual([
			{ kind: "lock", source: "simulated", at: 42 },
			{ kind: "wake", source: "didWake", at: 42 },
		]);
		session.dispose();
		expect(binding.stopped).toBe(1);
		expect(session.status).toEqual({ state: "stopped" });
	});

	test("no helper or a failed start: unavailable, never throws", () => {
		const { log } = logger();
		const none = new SystemSession({ binding: null, unavailableReason: "no native helper on linux", log });
		expect(none.start()).toEqual({ state: "unavailable", reason: "no native helper on linux" });
		const binding = new FakeSessionBinding();
		binding.startStatus = -4;
		const failed = new SystemSession({ binding, log });
		expect(failed.start()).toMatchObject({ state: "unavailable" });
		failed.dispose();
		expect(binding.stopped).toBe(0);
	});

	test("a throwing listener doesn't stop the others", () => {
		const binding = new FakeSessionBinding();
		const { log, records } = logger();
		const session = new SystemSession({ binding, log });
		const got: string[] = [];
		session.subscribe(() => {
			throw new Error("boom");
		});
		session.subscribe((e) => got.push(e.kind));
		session.start();
		session.inject("sleep");
		expect(got).toEqual(["sleep"]);
		expect(records.some((r) => r.message === "system session listener failed")).toBe(true);
	});
});
