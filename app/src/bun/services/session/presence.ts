// What Glimpse does when the user steps away (GLIM-119, GLIM-107): the pure mapping from OS
// session events to actions, tested on Linux with ManualTimers.
//
//   lock / sleep    pause Live at once (live-popup.md L17: "Paused", hollow dot) and wipe the
//                   translation cache (GLIM-20; the composition root checks
//                   privacy.clearCacheOnLock). Each new lock or sleep wipes once.
//   unlock / wake   resume Live once the user is back: neither locked nor asleep. An
//                   automatic resume never undoes a user pause (LiveRunner keeps the reason).
//
// The OS sends overlapping and repeated notifications: a lid close on macOS is
// screensDidSleep + screenIsLocked + willSleep, Windows sends PBT_APMRESUMEAUTOMATIC and
// PBT_APMRESUMESUSPEND, and a machine that wakes into the lock screen reports the wake
// before (or without) a fresh lock. So the tracker keeps two flags (locked, asleep), ignores
// repeats, pauses with the reason of whichever came first and resumes with that same reason
// only when both are clear. The resume waits `resumeDelayMs` (default 1 s): a wake followed
// at once by a lock (Windows locks on resume) never flashes Live back on.
import type { TimerHandle, Timers } from "@glimpse/core";
import type { SessionEventKind } from "../../native/session.ts";

export type AwayPauseReason = "locked" | "sleep";
export type AwayWipeReason = "lock" | "sleep";

export interface PresenceActions {
	pause(reason: AwayPauseReason): void;
	resume(reason: AwayPauseReason): void;
	wipe(reason: AwayWipeReason): void;
}

export interface PresenceState {
	readonly locked: boolean;
	readonly asleep: boolean;
	/** The automatic pause in force (resumed once the user is back), or null. */
	readonly pausedFor: AwayPauseReason | null;
	readonly resumePending: boolean;
}

export interface PresenceOptions {
	readonly resumeDelayMs?: number;
}

export class PresenceTracker {
	#locked = false;
	#asleep = false;
	#pausedFor: AwayPauseReason | null = null;
	#resumeTimer: TimerHandle | null = null;

	constructor(
		private readonly actions: PresenceActions,
		private readonly timers: Pick<Timers, "setTimeout" | "clearTimeout">,
		private readonly options: PresenceOptions = {},
	) {}

	get state(): PresenceState {
		return {
			locked: this.#locked,
			asleep: this.#asleep,
			pausedFor: this.#pausedFor,
			resumePending: this.#resumeTimer !== null,
		};
	}

	handle(kind: SessionEventKind): void {
		switch (kind) {
			case "lock":
				if (this.#locked) return;
				this.#locked = true;
				this.#away("locked", "lock");
				return;
			case "sleep":
				if (this.#asleep) return;
				this.#asleep = true;
				this.#away("sleep", "sleep");
				return;
			case "unlock":
				this.#locked = false;
				this.#maybeBack();
				return;
			case "wake":
				this.#asleep = false;
				this.#maybeBack();
				return;
		}
	}

	dispose(): void {
		this.#cancelResume();
	}

	#away(pause: AwayPauseReason, wipe: AwayWipeReason): void {
		this.#cancelResume();
		this.actions.wipe(wipe);
		if (this.#pausedFor === null) {
			this.#pausedFor = pause;
			this.actions.pause(pause);
		}
	}

	#maybeBack(): void {
		if (this.#locked || this.#asleep || this.#pausedFor === null || this.#resumeTimer !== null) return;
		const delay = this.options.resumeDelayMs ?? 1_000;
		this.#resumeTimer = this.timers.setTimeout(() => {
			this.#resumeTimer = null;
			const reason = this.#pausedFor;
			if (reason === null || this.#locked || this.#asleep) return;
			this.#pausedFor = null;
			this.actions.resume(reason);
		}, delay);
	}

	#cancelResume(): void {
		if (this.#resumeTimer === null) return;
		this.timers.clearTimeout(this.#resumeTimer);
		this.#resumeTimer = null;
	}
}
