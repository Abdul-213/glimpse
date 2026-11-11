// Screen lock / unlock and sleep / wake notifications from the native helpers (GLIM-119):
// app/native/macos/session.m (NSWorkspace + com.apple.screenIsLocked) and
// app/native/windows/session.cpp (WTSRegisterSessionNotification + WM_POWERBROADCAST).
// This file is the binding interface and the pure code mapping; no FFI, tested on Linux.

/** What the OS reported. Several native notifications map to one kind. */
export type SessionEventKind = "lock" | "unlock" | "sleep" | "wake";

const KINDS: Record<number, SessionEventKind> = { 1: "lock", 2: "unlock", 3: "sleep", 4: "wake" };
export const SESSION_KIND_CODE: Record<SessionEventKind, number> = { lock: 1, unlock: 2, sleep: 3, wake: 4 };

/** Which native notification it was (`source` in the callback), for the log. */
const SOURCES: Record<"macos" | "windows", Record<number, string>> = {
	macos: {
		1: "screenIsLocked",
		2: "screenIsUnlocked",
		3: "sessionDidResignActive",
		4: "sessionDidBecomeActive",
		5: "willSleep",
		6: "didWake",
		7: "screensDidSleep",
		8: "screensDidWake",
		99: "simulated",
	},
	windows: {
		1: "WTS_SESSION_LOCK",
		2: "WTS_SESSION_UNLOCK",
		3: "PBT_APMSUSPEND",
		4: "PBT_APMRESUMEAUTOMATIC",
		5: "PBT_APMRESUMESUSPEND",
	},
};

export function sessionKindFor(code: number): SessionEventKind | null {
	return KINDS[code] ?? null;
}

export function sessionSourceName(os: "macos" | "windows", source: number): string {
	return SOURCES[os][source] ?? `source ${source}`;
}

/** The helper exports both OSes share (glim_session_*). Faked in tests. */
export interface SessionNativeBinding {
	/**
	 * Start observing; `onEvent` runs on the Bun worker (threadsafe JSCallback) for every
	 * notification. Returns the native status (0 = ok). Calling it again replaces the listener.
	 */
	sessionStart(onEvent: (kind: SessionEventKind, source: string) => void): number;
	/** Stop observing and release the callback. Idempotent. */
	sessionStop(): void;
	/** Smoke tests: make the helper deliver `kind` through its real notification path. */
	sessionSimulate(kind: SessionEventKind): number;
	/** Smoke tests: let the native side deliver (macOS runs the main run loop for `ms`). */
	sessionPump(ms: number): void;
	/** What the helper registered ({running, observers} / {running, wts, suspendResume}). */
	sessionInfo(): Record<string, number> | null;
}
