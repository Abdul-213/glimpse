// Screen-reader announcements for Live changes (GLIM-92, live-popup.md §8, §10). Pure over a
// Timers port.
//
// - Change sets are coalesced: translations revealed within the gather window (700 ms, a
//   little over the 600 ms hold, so one change set whose blocks arrive over its hold is one
//   announcement) go out together, in reading order, ≤ 300 characters (`announcementText`).
// - At most one change announcement per 1500 ms; later changes wait and join the next one.
// - Status changes ("Live paused", "Live resumed") are announced once, at once.
import type { Timers } from "../pipeline/live-loop.ts";
import { announcementText } from "./live-layout.ts";
import type { LivePopupState } from "./live-state.ts";

export const ANNOUNCE_INTERVAL_MS = 1500;
export const ANNOUNCE_GATHER_MS = 700;
export const ANNOUNCE_MAX_CHARS = 300;

export type AnnouncementKind = "change" | "status";

export interface LiveAnnouncerOptions {
	readonly timers: Timers;
	readonly emit: (text: string, kind: AnnouncementKind) => void;
	readonly intervalMs?: number;
	readonly gatherMs?: number;
	readonly maxChars?: number;
}

export class LiveAnnouncer {
	readonly #o: LiveAnnouncerOptions;
	#pending: string[] = [];
	#timer: unknown = null;
	#last = Number.NEGATIVE_INFINITY;

	constructor(options: LiveAnnouncerOptions) {
		this.#o = options;
	}

	/** Newly revealed translations of the latest change set, in reading order. */
	change(texts: readonly string[]): void {
		const add = texts.filter((t) => t.trim() !== "");
		if (add.length === 0) return;
		this.#pending.push(...add);
		if (this.#timer !== null) return;
		const now = this.#o.timers.now();
		const interval = this.#o.intervalMs ?? ANNOUNCE_INTERVAL_MS;
		const delay = Math.max(this.#o.gatherMs ?? ANNOUNCE_GATHER_MS, this.#last + interval - now);
		this.#timer = this.#o.timers.setTimeout(() => this.#flush(), delay);
	}

	/** A status change, spoken once and at once. */
	status(text: string): void {
		this.#o.emit(text, "status");
	}

	/** Drop what is waiting (session stopped, announcements turned off). */
	clear(): void {
		if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
		this.#timer = null;
		this.#pending = [];
	}

	#flush(): void {
		this.#timer = null;
		const text = announcementText(this.#pending, this.#o.maxChars ?? ANNOUNCE_MAX_CHARS);
		this.#pending = [];
		if (text === "") return;
		this.#last = this.#o.timers.now();
		this.#o.emit(text, "change");
	}
}

/** "Live paused" / "Live resumed" when the session stops or starts capturing (§10.4); else null. */
export function statusAnnouncement(prev: LivePopupState, next: LivePopupState): "paused" | "resumed" | null {
	if (prev.sessionId !== next.sessionId || next.sessionId === null) return null;
	const stopped = (s: LivePopupState) => s.status === "paused" || s.status === "error";
	const running = (s: LivePopupState) => s.status === "live" || s.status === "updating" || s.status === "empty";
	if (!stopped(prev) && stopped(next)) return "paused";
	if (stopped(prev) && running(next)) return "resumed";
	return null;
}
