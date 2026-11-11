// Screen-reader announcements for Live changes (GLIM-92, live-popup.md §10). Pure: no
// electrobun import, tested on Linux with fakes.
//
// Every popup state change goes through `revealedTranslations` (the latest change set's
// translations as they appear) and `statusAnnouncement` (paused / resumed); the core
// `LiveAnnouncer` coalesces them (≤ one per 1.5 s, ≤ 300 characters). Each announcement goes
//   - to the view's polite `role="log"` (status changes: `role="status"`), which a screen
//     reader reads while the popup has focus, and
//   - while it doesn't (the usual case: a game has focus), to the OS through the helper:
//     macOS NSAccessibilityAnnouncementRequestedNotification, Windows UIA notification event.
// Setting `live.announceChanges`: `auto` (default) = on when a screen reader is running when
// the session starts, `on`, `off`. Logs carry counts only, never the text.
import {
	type AnnouncementKind,
	LiveAnnouncer,
	type LivePopupState,
	type Logger,
	revealedTranslations,
	type Settings,
	statusAnnouncement,
	type Timers,
} from "@glimpse/core";

export const LIVE_STATUS_TEXT = { paused: "Live paused", resumed: "Live resumed" } as const;

export interface LiveAnnouncementsDeps {
	readonly popup: {
		onChange(listener: (prev: LivePopupState, next: LivePopupState) => void): () => void;
		/** The popup has keyboard focus (its own live regions are read then). */
		readonly focused: boolean;
	};
	/** To the view's log / status region. */
	readonly post: (sessionId: string, text: string, kind: AnnouncementKind) => void;
	/** Native announcement; false when the helper isn't there or the OS refused. */
	readonly speak: ((text: string, kind: AnnouncementKind) => boolean) | null;
	readonly screenReaderActive: () => boolean | null;
	readonly mode: () => Settings["live"]["announceChanges"];
	readonly timers: Timers;
	readonly log: Logger;
}

export class LiveAnnouncements {
	readonly #d: LiveAnnouncementsDeps;
	readonly #announcer: LiveAnnouncer;
	readonly #off: () => void;
	#sessionId: string | null = null;
	/** Screen reader running when the session started (`auto`). */
	#reader = false;
	#spoken = 0;
	#posted = 0;

	constructor(deps: LiveAnnouncementsDeps) {
		this.#d = deps;
		this.#announcer = new LiveAnnouncer({ timers: deps.timers, emit: (text, kind) => this.#emit(text, kind) });
		this.#off = deps.popup.onChange((prev, next) => this.#onChange(prev, next));
	}

	get enabled(): boolean {
		const mode = this.#d.mode();
		return mode === "on" || (mode === "auto" && this.#reader);
	}

	stats(): { readonly posted: number; readonly spoken: number } {
		return { posted: this.#posted, spoken: this.#spoken };
	}

	dispose(): void {
		this.#off();
		this.#announcer.clear();
	}

	#onChange(prev: LivePopupState, next: LivePopupState): void {
		if (next.sessionId !== this.#sessionId) {
			if (this.#sessionId !== null) {
				this.#d.log.debug("live announcements: session ended", { posted: this.#posted, spoken: this.#spoken });
			}
			this.#announcer.clear();
			this.#sessionId = next.sessionId;
			this.#posted = 0;
			this.#spoken = 0;
			if (next.sessionId !== null) {
				this.#reader = this.#d.screenReaderActive() === true;
				this.#d.log.info("live announcements", { mode: this.#d.mode(), screenReader: this.#reader, on: this.enabled });
			}
			return;
		}
		if (!this.enabled) {
			this.#announcer.clear();
			return;
		}
		this.#announcer.change(revealedTranslations(prev, next));
		const status = statusAnnouncement(prev, next);
		if (status) this.#announcer.status(LIVE_STATUS_TEXT[status]);
	}

	#emit(text: string, kind: AnnouncementKind): void {
		const id = this.#sessionId;
		if (id === null) return;
		this.#posted++;
		this.#d.post(id, text, kind);
		// While the popup has focus its own regions are read; speaking natively too would double up.
		if (!this.#d.popup.focused && this.#d.speak?.(text, kind)) this.#spoken++;
	}
}
