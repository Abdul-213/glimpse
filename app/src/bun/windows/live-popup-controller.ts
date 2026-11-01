// The docked Live popup's window controller, minus Electrobun (GLIM-79/81; live-popup.md §3,
// §6, §7, §8, §12). One pre-created hidden window serves every Live session. The session's
// typed events (LiveService.onEvent) fold into a `LivePopupState` (@glimpse/core
// `reduceLivePopup`); every change is pushed to the view, coalesced per turn, and the view
// updates blocks in place.
//
// - Docking: `placeLivePopup` once at pin time; the side is kept for the session and the
//   anchored edge never moves as the content grows or shrinks (`livePopupFrame`).
// - Focus (§7): shown inactive (never activates on show, update or resize). Keyboard focus is
//   taken on purpose only: the consent question (L10) and "Focus Live popup"; the previous
//   app's focus is saved first and restored on Esc / after answering.
// - The 600 ms hold (§8) runs on the scheduler; stale labels refresh every 30 s.
// - Never writes the clipboard by itself: only an explicit Ctrl/⌘C in the focused popup copies.
//
// The window comes in through `LivePopupWindowPort` (Electrobun in windows/live-popup.ts, a
// fake in tests). No electrobun import here.
import {
	type Display,
	type FocusKeeper,
	heldBlocks,
	initialLivePopupState,
	LIVE_HOLD_MS,
	LIVE_STALE_REFRESH_MS,
	type LivePauseReason,
	type LivePopupAction,
	type LivePopupPlacement,
	type LivePopupState,
	type LiveSessionEvent,
	type LiveSessionListener,
	type Logger,
	listedLiveBlocks,
	livePopupFrame,
	placeLivePopup,
	type Rect,
	reduceLivePopup,
} from "@glimpse/core";
import type { LiveConsentAnswer, LiveLayout, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import { realScheduler, type Scheduler } from "./picker-controller.ts";

/** Show the window anyway if the view hasn't reported `painted` by then (§8: ≤ 100 ms p95). */
export const LIVE_PAINT_TIMEOUT_MS = 48;
/** Height before the view measures: the strip plus one line. */
export const LIVE_INITIAL_HEIGHT = 96;

export interface LivePopupWindowPort {
	setFrame(frame: Rect): void;
	/** Show without activating (non-activating panel / WS_EX_NOACTIVATE + SW_SHOWNOACTIVATE). */
	showInactive(): void;
	/** Show and take keyboard focus (consent, Focus Live popup). */
	activate(): void;
	hide(): void;
	send(message: LiveStateMessage): void;
	/** Move DOM focus to Pause / Resume (after `activate`). */
	focusControls(sessionId: string): void;
}

/** What the controller needs from the Live feature (`LiveService`). */
export interface LivePopupSession {
	onEvent(listener: LiveSessionListener): () => void;
	readonly active: boolean;
	pause(reason?: LivePauseReason): void;
	resume(reason?: LivePauseReason): void;
	stop(reason?: "user"): void;
	answerConsent(sessionId: string, answer: LiveConsentAnswer, remember: boolean): Promise<void> | void;
	highlightBlock(box: Rect | null, image: { readonly width: number; readonly height: number } | null): void;
	setPopupVisible(visible: boolean): void;
}

export interface LivePopupSettings {
	readonly reducedMotion: boolean;
	readonly uiDir: "ltr" | "rtl";
}

export interface LivePopupControllerDeps {
	readonly window: LivePopupWindowPort;
	readonly live: LivePopupSession;
	readonly displays: () => readonly Display[];
	readonly settings: () => LivePopupSettings;
	/** App-wide Private (GLIM-20), shared with the tray. */
	readonly setPrivate: (on: boolean) => void;
	/** Re-pin (L18): open the picker in Live mode. */
	readonly repin: () => void;
	readonly focus: FocusKeeper;
	/** Manual copy only (Ctrl/⌘C in the focused popup). */
	readonly clipboard?: { writeText(text: string): void };
	readonly eol?: "\n" | "\r\n";
	readonly log: Logger;
	readonly scheduler?: Scheduler;
	readonly now?: () => number;
}

export class LivePopupController {
	readonly #d: LivePopupControllerDeps;
	readonly #scheduler: Scheduler;
	readonly #now: () => number;
	#state: LivePopupState = initialLivePopupState;
	#placement: LivePopupPlacement | null = null;
	/** The window's last frame (global logical). */
	#frame: Rect | null = null;
	#visible = false;
	#painted = false;
	#focused = false;
	#hidden = false;
	/** Focus was saved on pointer-enter; an unexpected activation hands it back. */
	#armed = false;
	#pushQueued = false;
	#cancelPaint: (() => void) | null = null;
	#cancelStale: (() => void) | null = null;
	readonly #holds = new Map<string, () => void>();
	readonly #unsubscribe: () => void;
	readonly #listeners = new Set<(prev: LivePopupState, next: LivePopupState) => void>();

	constructor(deps: LivePopupControllerDeps) {
		this.#d = deps;
		this.#scheduler = deps.scheduler ?? realScheduler;
		this.#now = deps.now ?? Date.now;
		this.#unsubscribe = deps.live.onEvent((e) => this.#onSession(e));
	}

	get state(): LivePopupState {
		return this.#state;
	}

	get visible(): boolean {
		return this.#visible;
	}

	/** The popup has keyboard focus on purpose (consent, Focus Live popup). */
	get focused(): boolean {
		return this.#focused;
	}

	/**
	 * Where the popup is on screen (global logical), or null while hidden. GLIM-128: the
	 * capture-exclusion `popup` bounds, which Glimpse's own capture paints over on Windows when
	 * "Hide Glimpse from screenshots" is off.
	 */
	get frame(): Rect | null {
		return this.#visible ? this.#frame : null;
	}

	get placement(): LivePopupPlacement | null {
		return this.#placement;
	}

	/** Every state change (announcements, GLIM-92; tests). */
	onChange(listener: (prev: LivePopupState, next: LivePopupState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// ---- session ---------------------------------------------------------------------

	#onSession(event: LiveSessionEvent): void {
		if (event.type === "opened" && event.sessionId !== this.#state.sessionId) this.#open(event.region);
		const wasOpen = this.#state.sessionId !== null;
		this.#dispatch({ type: "session", event });
		if (event.type === "consent") this.#takeFocus();
		if (wasOpen && this.#state.sessionId === null) this.#close();
	}

	#open(region: Rect): void {
		this.#clearTimers();
		const s = this.#d.settings();
		this.#placement = placeLivePopup(region, this.#d.displays(), { uiDir: s.uiDir });
		this.#painted = false;
		if (!this.#placement) {
			this.#d.log.warn("live popup: no display for the region");
			return;
		}
		this.#setFrame(livePopupFrame(this.#placement, LIVE_INITIAL_HEIGHT));
		this.#d.log.info("live popup: docked", {
			side: this.#placement.side,
			width: this.#placement.width,
			maxHeight: Math.round(this.#placement.maxHeight),
		});
		this.#cancelPaint = this.#scheduler.later(LIVE_PAINT_TIMEOUT_MS, () => this.#show("timeout"));
	}

	#close(): void {
		this.#clearTimers();
		this.#placement = null;
		if (this.#visible) {
			this.#visible = false;
			this.#d.window.hide();
		}
		this.#d.live.setPopupVisible(false);
		this.#restoreFocus();
		this.#hidden = false;
	}

	#show(why: "painted" | "timeout"): void {
		this.#cancelPaint?.();
		this.#cancelPaint = null;
		if (this.#visible || this.#hidden || !this.#placement || this.#state.sessionId === null) return;
		this.#visible = true;
		if (this.#state.status === "consent") this.#takeFocus();
		else this.#d.window.showInactive();
		this.#d.live.setPopupVisible(true);
		this.#d.log.debug("live popup: shown", { why });
	}

	// ---- view intents ----------------------------------------------------------------

	painted(sessionId: string): void {
		if (sessionId !== this.#state.sessionId) return;
		this.#painted = true;
		this.#show("painted");
	}

	resized(sessionId: string, contentHeight: number): void {
		if (sessionId !== this.#state.sessionId || !this.#placement || !Number.isFinite(contentHeight)) return;
		this.#setFrame(livePopupFrame(this.#placement, contentHeight));
	}

	pause(sessionId: string): void {
		if (this.#mine(sessionId)) this.#d.live.pause("user");
	}

	resume(sessionId: string): void {
		if (this.#mine(sessionId)) this.#d.live.resume();
	}

	/** Stop never asks (§6.1): unpins, drops the session caches; the popup closes on `stopped`. */
	stop(sessionId: string): void {
		if (!this.#mine(sessionId)) return;
		if (this.#d.live.active) this.#d.live.stop("user");
		// A session that failed to open has nothing to stop: close the popup ourselves.
		else this.#onSession(stoppedEvent(sessionId));
	}

	repin(sessionId: string): void {
		if (!this.#mine(sessionId)) return;
		this.#restoreFocus();
		this.#d.repin();
	}

	setPrivate(sessionId: string, on: boolean): void {
		if (this.#mine(sessionId)) this.#d.setPrivate(on);
	}

	/** App-wide Private changed (tray, popup): the toggle mirrors it without re-rendering blocks. */
	privateChanged(on: boolean): void {
		this.#dispatch({ type: "private", on });
	}

	answerConsent(sessionId: string, answer: LiveConsentAnswer, remember: boolean): void {
		if (!this.#mine(sessionId) || this.#state.status !== "consent") return;
		this.#restoreFocus();
		void this.#d.live.answerConsent(sessionId, answer, remember);
	}

	toggleSkipped(sessionId: string, expanded: boolean): void {
		if (this.#mine(sessionId)) this.#dispatch({ type: "skipped", expanded });
	}

	hoverBlock(sessionId: string, id: string | null): void {
		if (!this.#mine(sessionId)) return;
		const b = id === null ? null : this.#state.blocks.find((x) => x.id === id);
		this.#d.live.highlightBlock(b?.box ?? null, b ? this.#state.image : null);
	}

	/** Ctrl/⌘C / Ctrl/⌘⇧C in the focused popup (§6.2). The only clipboard write Live makes. */
	copy(sessionId: string, what: "translation" | "original"): void {
		if (!this.#mine(sessionId) || !this.#d.clipboard) return;
		const eol = this.#d.eol ?? "\n";
		const text = listedLiveBlocks(this.#state)
			.map((b) => (what === "original" || b.cls !== "translate" ? b.source : (b.translation ?? b.source)))
			.filter((t) => t.trim() !== "")
			.join(eol + eol);
		if (text === "") return;
		this.#d.clipboard.writeText(text.replace(/\r?\n/g, eol));
		this.#d.log.info("live popup: copied", { what, blocks: listedLiveBlocks(this.#state).length });
	}

	/** Esc in the popup: focus goes back to the game; Live keeps running (§6.2). */
	blurred(sessionId: string): void {
		if (this.#mine(sessionId)) this.#restoreFocus();
	}

	/**
	 * The pointer came over the popup while the game has focus: save it, so a click that
	 * activates Glimpse anyway (WebView2's child HWND, §7.2) can be handed straight back.
	 */
	pointerEntered(sessionId: string): void {
		if (!this.#mine(sessionId) || this.#focused) return;
		this.#d.focus.save();
		this.#armed = true;
	}

	/**
	 * The popup window became key. On purpose (consent, Focus Live popup): nothing to do.
	 * Otherwise a control click activated Glimpse despite the non-activating window: restore
	 * the previous app at once (§7.2, `glim_focus_restore`).
	 */
	windowFocused(): void {
		if (this.#focused || !this.#armed) return;
		this.#armed = false;
		const restored = this.#d.focus.restore();
		this.#d.log.info("live popup: took focus on a click; handed it back", { restored });
	}

	/** The popup window lost key (the user clicked elsewhere): nothing to restore (§7.5). */
	windowBlurred(): void {
		if (!this.#focused) return;
		this.#focused = false;
		this.#push();
	}

	// ---- tray / global actions -------------------------------------------------------

	/** "Focus Live popup" (§6.3, owner question 6): keyboard and screen-reader users reach the controls. */
	focusPopup(): boolean {
		if (this.#state.sessionId === null || !this.#placement) return false;
		if (this.#hidden) this.setHidden(false);
		this.#takeFocus();
		this.#d.window.focusControls(this.#state.sessionId);
		return true;
	}

	/** Hide / Show popup (tray, L19): the session keeps running; the frame shows the region tag. */
	setHidden(hidden: boolean): void {
		if (hidden === this.#hidden) return;
		this.#hidden = hidden;
		if (hidden) {
			if (this.#visible) {
				this.#visible = false;
				this.#d.window.hide();
			}
			this.#restoreFocus();
			this.#d.live.setPopupVisible(false);
		} else if (this.#painted) {
			this.#show("painted");
		}
	}

	get hidden(): boolean {
		return this.#hidden;
	}

	dispose(): void {
		this.#unsubscribe();
		this.#clearTimers();
		this.#listeners.clear();
	}

	// ---- internals -------------------------------------------------------------------

	#mine(sessionId: string): boolean {
		return typeof sessionId === "string" && sessionId === this.#state.sessionId;
	}

	#takeFocus(): void {
		if (!this.#visible || this.#focused) return;
		this.#armed = false;
		this.#d.focus.save();
		this.#focused = true;
		this.#d.window.activate();
		this.#push();
	}

	#restoreFocus(): void {
		if (!this.#focused) return;
		this.#focused = false;
		this.#d.focus.restore();
		this.#push();
	}

	#dispatch(action: LivePopupAction): void {
		const prev = this.#state;
		const next = reduceLivePopup(prev, action);
		if (next === prev) return;
		this.#state = next;
		for (const h of heldBlocks(prev, next)) {
			this.#holds.get(h.id)?.();
			this.#holds.set(
				h.id,
				this.#scheduler.later(LIVE_HOLD_MS, () => {
					this.#holds.delete(h.id);
					this.#dispatch({ type: "holdExpired", id: h.id, frameSeq: h.frameSeq });
				}),
			);
		}
		this.#syncStaleTimer();
		for (const l of this.#listeners) l(prev, next);
		this.#push();
	}

	#setFrame(frame: Rect): void {
		this.#frame = frame;
		this.#d.window.setFrame(frame);
	}

	#syncStaleTimer(): void {
		const stale = this.#state.stale && this.#state.sessionId !== null;
		if (stale && !this.#cancelStale) {
			this.#cancelStale = this.#scheduler.every(LIVE_STALE_REFRESH_MS, () => this.#push());
		} else if (!stale && this.#cancelStale) {
			this.#cancelStale();
			this.#cancelStale = null;
		}
	}

	#push(): void {
		if (this.#pushQueued) return;
		this.#pushQueued = true;
		queueMicrotask(() => {
			this.#pushQueued = false;
			const p = this.#placement;
			const id = this.#state.sessionId;
			if (!p || id === null) return;
			const layout: LiveLayout = { side: p.side, width: p.width, maxHeight: p.maxHeight };
			this.#d.window.send({
				sessionId: id,
				layout,
				state: this.#state,
				reducedMotion: this.#d.settings().reducedMotion,
				now: this.#now(),
				focused: this.#focused,
			});
		});
	}

	#clearTimers(): void {
		this.#cancelPaint?.();
		this.#cancelPaint = null;
		this.#cancelStale?.();
		this.#cancelStale = null;
		for (const cancel of this.#holds.values()) cancel();
		this.#holds.clear();
	}
}

function stoppedEvent(sessionId: string): LiveSessionEvent {
	return {
		type: "status",
		sessionId,
		status: "stopped",
		reason: null,
		error: null,
		stale: true,
		capturedAt: null,
		at: 0,
	};
}

/** What the Live view gets once per load: platform, UI language, the popup's keys (§6.2). */
export function liveViewInit(os: LiveViewInit["os"], uiLang = "en"): LiveViewInit {
	const mac = os === "macos";
	return {
		os,
		uiLang,
		uiDir: "ltr",
		keys: {
			pause: mac ? "⌘⇧P" : "Ctrl+Shift+P",
			stop: mac ? "⌘W" : "Ctrl+W",
			copy: mac ? "⌘C" : "Ctrl+C",
			copyOriginal: mac ? "⌘⇧C" : "Ctrl+Shift+C",
			original: mac ? "⌘⇧O" : "Ctrl+Shift+O",
			focus: null,
		},
	};
}
