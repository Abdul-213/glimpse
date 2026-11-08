// The docked Live popup's window controller, minus Electrobun (GLIM-79/81; live-popup.md §3,
// §6, §7, §8, §12). One pre-created hidden window serves every Live session. The session's
// typed events (LiveService.onEvent) fold into a `LivePopupState` (@glimpse/core
// `reduceLivePopup`); every change is pushed to the view, coalesced per turn, and the view
// updates blocks in place.
//
// - Docking: `placeLivePopup` once at pin time; the side is kept for the session and the
//   anchored edge never moves as the content grows or shrinks (`livePopupFrame`).
// - Moving (GLIM-151, §3.3): a drag on the strip or Alt/Option+arrows moves the window
//   (`moveLivePopup`: on screen, top-left fixed as it grows); it stays put for the session
//   and the offset from the region is remembered per display for the next one. Dock puts it
//   back with `placeLivePopup` and forgets the offset. Pin keeps it above other windows (on
//   by default; the choice lasts until Glimpse quits).
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
	forgetOffset,
	heldBlocks,
	initialLivePopupState,
	type LanguageCode,
	LIVE_HOLD_MS,
	LIVE_STALE_REFRESH_MS,
	type LiveEdge,
	type LiveMoveKey,
	type LivePauseReason,
	type LivePopupAction,
	type LivePopupOffset,
	type LivePopupPlacement,
	type LivePopupState,
	type LiveSessionEvent,
	type LiveSessionListener,
	type Logger,
	listedLiveBlocks,
	liveMoveStep,
	livePopupFrame,
	movedOrigin,
	moveLivePopup,
	offsetFor,
	type Point,
	placeLivePopup,
	type Rect,
	reduceLivePopup,
	rememberOffset,
	skippedLiveBlocks,
} from "@glimpse/core";
import type {
	LiveConsentAnswer,
	LiveLayout,
	LiveSkippedAction,
	LiveStateMessage,
	LiveViewInit,
} from "../../shared/live-rpc.ts";
import { realScheduler, type Scheduler } from "./picker-controller.ts";
import type { PackPort } from "./popup-controller.ts";

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
	/**
	 * Pin (GLIM-151): above other windows (true: level 101 / HWND_TOPMOST) or a normal window
	 * level other apps can cover. Never activates. Optional for older fakes.
	 */
	setPinned?(on: boolean): void;
	/** A keyboard move or Dock finished: the view announces it politely (GLIM-151). */
	moved?(sessionId: string, result: LiveMoveResult): void;
}

/** What a keyboard move or Dock did, for the view's polite announcement. */
export interface LiveMoveResult {
	readonly kind: "moved" | "docked";
	/** Work-area edges the popup stopped at. */
	readonly edges: readonly LiveEdge[];
}

/** The remembered moved offsets (settings `live.popupOffsets`). */
export interface LivePopupOffsetStore {
	get(): readonly LivePopupOffset[];
	set(offsets: readonly LivePopupOffset[]): void;
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
	/** Re-read the region on the next grab (a pack landed, GLIM-123). Optional for older fakes. */
	refresh?(reason: "pack-installed"): void;
	/** "Translate these" (GLIM-131): session-only source languages. Optional for older fakes. */
	includeLanguages?(langs: readonly LanguageCode[]): void;
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
	/**
	 * L12 language-pack downloads (the app's TranslationPacks, shared with Snip). Without it the
	 * pack row shows but Download does nothing.
	 */
	readonly packs?: PackPort;
	/** "Edit source languages…" on the skipped line (GLIM-131): Settings › Languages. */
	readonly openSettings?: (section: "languages") => void;
	/** The spend guard's "Continue this month" (GLIM-120). Without it the button only resumes. */
	readonly continueCloud?: () => Promise<unknown>;
	/**
	 * The pointer in global logical px (GLIM-151): drags follow the OS cursor, so the window
	 * moving under the webview never skews the deltas. Without it the view's screen deltas are used.
	 */
	readonly cursor?: () => Point;
	/** Where the popup was last moved, per display (GLIM-151). Without it nothing is remembered. */
	readonly offsets?: LivePopupOffsetStore;
}

export class LivePopupController {
	readonly #d: LivePopupControllerDeps;
	readonly #scheduler: Scheduler;
	readonly #now: () => number;
	#state: LivePopupState = initialLivePopupState;
	#placement: LivePopupPlacement | null = null;
	/** The pinned region of the open session (Dock places next to it again). */
	#region: Rect | null = null;
	/** The user moved the popup this session: no re-docking until Dock. */
	#moved = false;
	/** Above other windows (GLIM-151). Kept across sessions until Glimpse quits. */
	#pinned = true;
	/** The last height the view measured, so a move or Dock keeps the size. */
	#contentHeight = LIVE_INITIAL_HEIGHT;
	/** A drag in progress: the frame and cursor at pointer-down. */
	#drag: { frame: Rect; cursor: Point | null; moved: boolean } | null = null;
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
	readonly #unsubscribePacks: (() => void) | null;
	readonly #listeners = new Set<(prev: LivePopupState, next: LivePopupState) => void>();

	constructor(deps: LivePopupControllerDeps) {
		this.#d = deps;
		this.#scheduler = deps.scheduler ?? realScheduler;
		this.#now = deps.now ?? Date.now;
		this.#unsubscribe = deps.live.onEvent((e) => this.#onSession(e));
		this.#unsubscribePacks = deps.packs?.subscribe((id) => this.#onPackState(id)) ?? null;
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

	/** Moved away from the region by the user (GLIM-151). */
	get moved(): boolean {
		return this.#moved;
	}

	get pinned(): boolean {
		return this.#pinned;
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
		const displays = this.#d.displays();
		this.#region = region;
		this.#drag = null;
		this.#contentHeight = LIVE_INITIAL_HEIGHT;
		this.#placement = placeLivePopup(region, displays, { uiDir: s.uiDir });
		this.#moved = false;
		this.#painted = false;
		if (!this.#placement) {
			this.#d.log.warn("live popup: no display for the region");
			return;
		}
		// GLIM-151: where the user put it last time on this display, relative to the region.
		const remembered = this.#d.offsets ? offsetFor(region, displays, this.#d.offsets.get()) : null;
		const moved = remembered ? moveLivePopup(this.#placement, remembered, displays, LIVE_INITIAL_HEIGHT) : null;
		if (moved) {
			this.#placement = moved.placement;
			this.#moved = true;
		}
		this.#d.window.setPinned?.(this.#pinned);
		this.#setFrame(livePopupFrame(this.#placement, LIVE_INITIAL_HEIGHT));
		this.#d.log.info(this.#moved ? "live popup: placed at the remembered offset" : "live popup: docked", {
			side: this.#placement.side,
			width: this.#placement.width,
			maxHeight: Math.round(this.#placement.maxHeight),
		});
		this.#cancelPaint = this.#scheduler.later(LIVE_PAINT_TIMEOUT_MS, () => this.#show("timeout"));
	}

	#close(): void {
		this.#clearTimers();
		this.#placement = null;
		this.#region = null;
		this.#drag = null;
		this.#moved = false;
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
		this.#contentHeight = contentHeight;
		this.#setFrame(livePopupFrame(this.#placement, contentHeight));
	}

	// ---- moving (GLIM-151, §3.3) -------------------------------------------------------

	/** Pointer-down on the strip: remember where the drag starts. Nothing moves yet. */
	dragStart(sessionId: string): void {
		if (!this.#mine(sessionId) || !this.#frame || !this.#placement) return;
		this.#drag = { frame: this.#frame, cursor: this.#cursor(), moved: false };
	}

	/**
	 * The pointer moved during a drag (the view sends at most one per animation frame).
	 * `dx` / `dy` are the view's screen deltas since pointer-down, used without `cursor`.
	 */
	dragMove(sessionId: string, dx: number, dy: number): void {
		const drag = this.#drag;
		if (!this.#mine(sessionId) || !drag || !this.#placement) return;
		const now = drag.cursor ? this.#cursor() : null;
		const delta =
			drag.cursor && now
				? { x: now.x - drag.cursor.x, y: now.y - drag.cursor.y }
				: { x: Number.isFinite(dx) ? dx : 0, y: Number.isFinite(dy) ? dy : 0 };
		if (!drag.moved && delta.x === 0 && delta.y === 0) return;
		drag.moved = true;
		this.#moveTo(movedOrigin(drag.frame, delta), drag.frame.height);
	}

	/** Pointer-up: a drag that moved is remembered for the next session. */
	dragEnd(sessionId: string): void {
		const drag = this.#drag;
		if (!this.#mine(sessionId) || !drag) return;
		this.#drag = null;
		if (!drag.moved) return;
		this.#remember();
		this.#d.log.info("live popup: moved", { by: "drag" });
		this.#push();
	}

	/** Alt/Option+arrows (Shift: larger steps) in the focused popup. Announced politely. */
	moveBy(sessionId: string, key: LiveMoveKey, large: boolean): void {
		if (!this.#mine(sessionId) || !this.#frame || !this.#placement) return;
		const frame = this.#frame;
		const edges = this.#moveTo(movedOrigin(frame, liveMoveStep(key, large)), frame.height);
		if (!edges) return;
		this.#remember();
		this.#push();
		this.#d.window.moved?.(sessionId, { kind: "moved", edges });
	}

	/** Dock (button, double-click on the strip): next to the region again; forget the offset. */
	dock(sessionId: string): void {
		const region = this.#region;
		if (!this.#mine(sessionId) || !region || !this.#moved) return;
		const displays = this.#d.displays();
		const docked = placeLivePopup(region, displays, { uiDir: this.#d.settings().uiDir });
		if (!docked) return;
		this.#drag = null;
		this.#moved = false;
		this.#placement = docked;
		this.#setFrame(livePopupFrame(docked, this.#contentHeight));
		const offsets = this.#d.offsets;
		if (offsets) {
			const before = offsets.get();
			const after = forgetOffset(before, region, displays);
			if (after !== before) offsets.set(after);
		}
		this.#d.log.info("live popup: docked again", { side: docked.side });
		this.#push();
		this.#d.window.moved?.(sessionId, { kind: "docked", edges: [] });
	}

	/** Pin toggle: above other windows, or a normal window other apps can cover. */
	setPinned(sessionId: string, on: boolean): void {
		if (!this.#mine(sessionId) || on === this.#pinned) return;
		this.#pinned = on;
		this.#d.window.setPinned?.(on);
		this.#d.log.info("live popup: pin", { on });
		this.#push();
	}

	#cursor(): Point | null {
		try {
			return this.#d.cursor?.() ?? null;
		} catch {
			return null;
		}
	}

	/** Put the popup's top-left at `origin` (clamped on screen). The edges it stopped at, or null. */
	#moveTo(origin: Point, height: number): readonly LiveEdge[] | null {
		const p = this.#placement;
		if (!p) return null;
		const m = moveLivePopup(p, origin, this.#d.displays(), height);
		if (!m) return null;
		this.#placement = m.placement;
		this.#moved = true;
		this.#setFrame(livePopupFrame(m.placement, this.#contentHeight));
		return m.edges;
	}

	#remember(): void {
		const offsets = this.#d.offsets;
		const region = this.#region;
		const p = this.#placement;
		if (!offsets || !region || !p) return;
		offsets.set(rememberOffset(offsets.get(), region, this.#d.displays(), { x: p.x, y: p.y }));
	}

	pause(sessionId: string): void {
		if (this.#mine(sessionId)) this.#d.live.pause("user");
	}

	resume(sessionId: string): void {
		if (this.#mine(sessionId)) this.#d.live.resume();
	}

	/**
	 * The spend guard's "Continue this month" (GLIM-120): lift the pause for the rest of the
	 * month, then resume the session it stopped.
	 */
	async continueCloud(sessionId: string): Promise<void> {
		if (!this.#mine(sessionId)) return;
		try {
			await this.#d.continueCloud?.();
		} catch (error) {
			this.#d.log.warn("live popup: continue cloud failed", { error });
			return;
		}
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

	/**
	 * The skipped line's actions (GLIM-131, parity with Snip). "Translate these": the skipped
	 * blocks' languages are translated for the rest of this session (Settings unchanged); the
	 * blocks move into the list once the region is re-read. "Edit source languages…": Settings ›
	 * Languages; the session keeps running and picks the new subset up from there.
	 */
	skippedAction(sessionId: string, action: LiveSkippedAction): void {
		if (!this.#mine(sessionId)) return;
		if (action === "editSources") {
			this.#restoreFocus();
			this.#d.openSettings?.("languages");
			return;
		}
		const langs = [...new Set(skippedLiveBlocks(this.#state).flatMap((b) => (b.lang ? [b.lang] : [])))];
		if (langs.length === 0) return;
		this.#d.log.info("live popup: translate skipped", { langs: langs.length });
		this.#d.live.includeLanguages?.(langs);
	}

	/**
	 * L12 "Download ({size})" on a pack row: the user's consent to fetch that language's pack
	 * (GLIM-57). The session keeps running; the blocks translate once it lands.
	 */
	downloadPack(sessionId: string, lang: string): void {
		const packs = this.#d.packs;
		if (!this.#mine(sessionId) || !packs) return;
		const row = this.#state.packs.find((p) => p.lang === lang);
		if (!row || row.state === "downloading") return;
		this.#d.log.info("live popup: pack download requested", { lang: row.lang, resources: row.resourceIds.length });
		packs.download(row.resourceIds).catch((error) => this.#d.log.warn("live popup: pack download failed", { error }));
		this.#dispatch({ type: "packInstall", lang: row.lang, states: row.resourceIds.map((id) => packs.state(id)) });
	}

	/** A pack resource changed install state: update its row; once it is in, re-read the region. */
	#onPackState(resourceId: string): void {
		const packs = this.#d.packs;
		if (!packs || this.#state.sessionId === null) return;
		const row = this.#state.packs.find((p) => p.resourceIds.includes(resourceId));
		if (!row) return;
		this.#dispatch({ type: "packInstall", lang: row.lang, states: row.resourceIds.map((id) => packs.state(id)) });
		if (!this.#state.packs.some((p) => p.lang === row.lang)) this.#d.live.refresh?.("pack-installed");
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
		this.#unsubscribePacks?.();
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
			const layout: LiveLayout = {
				side: p.side,
				width: p.width,
				maxHeight: p.maxHeight,
				moved: this.#moved,
				pinned: this.#pinned,
			};
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
