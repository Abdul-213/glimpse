// One open picker (region-picker spec 3, 4.1, 7, 8, 9.4). Pure orchestration over ports,
// so the Linux harness and tests drive it without Electrobun:
//
//   views ──pointer/key/focus (display-local)──▶ PickerSession ──reducePicker──▶ state
//   window controller ──tick() at 60 Hz──▶        │ onView(PickerViewState)  → every overlay
//                                                 │ onLoupe(LoupePatch)      → pointer's overlay
//                                                 └ onDone(PickerOutcome)    → Snip / Live / cancel
//
// The session never sets timers: the window controller calls tick() (cursor polling,
// loupe sampling, hint expiry); tests call it by hand with a manual clock.
import type { Point, Size } from "../geometry.ts";
import type { Display } from "../region.ts";
import { displayAt } from "./geometry.ts";
import type { UiDir } from "./hud-layout.ts";
import { initialPickerState, type PickerEnv, type PickerEvent, type PickerState, reducePicker } from "./machine.ts";
import type { LoupePatch, PixelSampler, WindowListSource } from "./ports.ts";
import { LOUPE_CELLS } from "./sampler.ts";
import type { CancelReason, Modifiers, PickerMode, PickerOutcome, RegionSelected } from "./types.ts";
import { type PickerViewState, pickerView } from "./view.ts";

/** Where the pointer is when no view reports it (Electrobun Screen API). */
export interface PointerProbe {
	/** Global logical. */
	cursor(): Point;
	/** Primary button held right now. */
	primaryDown(): boolean;
}

/** Loupe pixels at most this often (spec 8: ≤ 33 ms old). */
export const LOUPE_INTERVAL_MS = 33;
/** Poll the cursor when no view event arrived for this long (spec 4.1). */
export const POLL_QUIET_MS = 100;
/** While dragging, poll sooner: the pointer may be over another display's overlay (spec 4.1). */
export const DRAG_POLL_QUIET_MS = 40;
/** A drag with no view event for this long checks the OS button state for a release (spec 4.1). */
export const RELEASE_POLL_MS = 120;
/**
 * Focus loss cancels once no overlay has had focus for this long (spec 7.7). Clicking from
 * one display's overlay to another's blurs one and focuses the other within a few ms.
 */
export const FOCUS_LOSS_GRACE_MS = 150;
/** Re-read the display list at most this often (spec 7.8: "at most once per second"). */
export const DISPLAY_CHECK_MS = 1000;

/** A pointer event from an overlay, in its own display-local CSS px. */
export interface ViewPointer {
	readonly displayId: number;
	readonly phase: "down" | "move" | "up" | "leave";
	readonly x: number;
	readonly y: number;
	readonly button: number;
	readonly mods: Modifiers;
	readonly detail: number;
}

export interface ViewKey {
	readonly displayId: number;
	readonly key: string;
	readonly down: boolean;
	readonly repeat: boolean;
	readonly mods: Modifiers;
}

export interface PickerSessionOptions {
	readonly env: Omit<PickerEnv, "windows">;
	readonly mode: PickerMode;
	readonly probe: PointerProbe;
	readonly windows: WindowListSource;
	readonly sampler: PixelSampler;
	readonly now: () => number;
	readonly onView: (view: PickerViewState) => void;
	readonly onLoupe?: (patch: LoupePatch) => void;
	readonly onDone: (outcome: PickerOutcome) => void;
	readonly dir?: UiDir;
	readonly showLoupe?: boolean;
	/** Egress notice for a mode (spec 2 J), or null when its pipeline is local. */
	readonly egress?: (mode: PickerMode) => string | null;
	/** A Live session is running (spec 2 K). */
	readonly liveRunning?: boolean;
	/** Diagnostics (window list failures). */
	readonly log?: (message: string) => void;
	/**
	 * The current display list (Electrobun has no display-change event). Polled at most
	 * once a second; a change cancels with "display-change" (spec 7.8).
	 */
	readonly displaysNow?: () => readonly Display[];
}

export class PickerSession {
	private state: PickerState;
	private seq = 0;
	private lastViewEventAt = Number.NEGATIVE_INFINITY;
	private lastLoupeAt = Number.NEGATIVE_INFINITY;
	private loupeInFlight = false;
	private lastView: PickerViewState | null = null;
	private lastViewKey = "";
	private finished = false;
	private readonly hintSizes = new Map<number, Size>();
	private readoutSize: { text: string; size: Size } | null = null;
	private readonly overHint = new Set<number>();
	private readonly focused = new Set<number>();
	private hadFocus = false;
	private unfocusedSince: number | null = null;
	private lastDisplayCheck: number;
	private readonly displayKey: string;
	/** How cross-display drags were tracked (diagnostics for the GLIM-54 manual checks). */
	readonly stats = { substituted: 0, polledMoves: 0, polledRelease: 0 };

	constructor(private readonly o: PickerSessionOptions) {
		const cursor = o.probe.cursor();
		this.state = initialPickerState({ ...o.env, windows: [] }, o.mode, cursor);
		this.displayKey = displaysKey(o.env.displays);
		this.lastDisplayCheck = o.now();
	}

	get phase() {
		return this.state.phase;
	}
	get mode(): PickerMode {
		return this.state.mode;
	}
	get done(): boolean {
		return this.finished;
	}
	get displays(): readonly Display[] {
		return this.state.env.displays;
	}
	/** The current machine state (tests, diagnostics). */
	get snapshot(): PickerState {
		return this.state;
	}
	/** The last view state sent. */
	get view(): PickerViewState | null {
		return this.lastView;
	}

	/** Publish the first frame and fetch the window list (≤ 50 ms target, spec 8). */
	start(): void {
		this.publish(true);
		const t0 = this.o.now();
		this.o.windows.list().then(
			(windows) => {
				if (this.finished) return;
				this.dispatch({ type: "windows", windows });
				this.o.log?.(`window list: ${windows.length} windows in ${Math.round(this.o.now() - t0)} ms`);
			},
			(e) => this.o.log?.(`window list unavailable: ${e instanceof Error ? e.message : String(e)}`),
		);
	}

	/** Display-local CSS px from the view → global logical. */
	private toGlobal(displayId: number, x: number, y: number): Point | null {
		const d = this.state.env.displays.find((d) => d.id === displayId);
		return d ? { x: d.bounds.x + x, y: d.bounds.y + y } : null;
	}

	pointer(e: ViewPointer): void {
		if (this.finished || e.phase === "leave") return;
		const p = this.toGlobal(e.displayId, e.x, e.y);
		if (!p) return;
		this.lastViewEventAt = this.o.now();
		this.dispatch({
			type: "pointer",
			phase: e.phase,
			p: this.resolvePoint(e, p),
			button: e.button,
			mods: e.mods,
			detail: e.detail,
			t: this.o.now(),
		});
	}

	/**
	 * The point to use for a view event. A view keeps pointer capture while a drag crosses
	 * onto another display, and reports points outside its own bounds by extrapolating its
	 * own CSS px. That is wrong across mixed DPI on Windows (each monitor has its own
	 * physical-to-logical mapping), so those points come from the OS cursor instead.
	 */
	private resolvePoint(e: ViewPointer, p: Point): Point {
		if (e.phase === "down") return p;
		const d = this.state.env.displays.find((x) => x.id === e.displayId);
		if (!d) return p;
		const b = d.bounds;
		const outside = p.x < b.x || p.y < b.y || p.x > b.x + b.width || p.y > b.y + b.height;
		if (!outside) return p;
		this.stats.substituted++;
		return this.o.probe.cursor();
	}

	key(e: ViewKey): void {
		if (this.finished) return;
		// Holding Enter or Tab must not confirm / flip repeatedly.
		if (e.repeat && (e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) return;
		this.dispatch({ type: "key", key: e.key, down: e.down, mods: e.mods, t: this.o.now() });
	}

	/** Mode segment click, Tab from outside, or the other mode's hotkey. */
	setMode(mode: PickerMode): void {
		this.dispatch({ type: "set-mode", mode });
	}

	/** Re-pin / Snip again: open in `adjusting` around `rect`. */
	preset(rect: { x: number; y: number; width: number; height: number }, source: "repin" | "snipAgain"): void {
		this.dispatch({ type: "preset", rect, source });
	}

	cancel(reason: CancelReason): void {
		this.dispatch({ type: "cancel", reason });
	}

	/** The view measured its hint bar or readout chip (they size to their copy). */
	measured(displayId: number, m: { hint?: Size; readout?: { text: string; size: Size } }): void {
		if (m.hint) this.hintSizes.set(displayId, m.hint);
		if (m.readout) this.readoutSize = m.readout;
		this.publish();
	}

	hintHover(displayId: number, over: boolean): void {
		if (over) this.overHint.add(displayId);
		else this.overHint.delete(displayId);
		this.publish();
	}

	/**
	 * An overlay gained or lost OS focus. Once one has had focus, losing it everywhere for
	 * FOCUS_LOSS_GRACE_MS cancels with "focus-lost": the user went to another app on purpose,
	 * so focus is not handed back (spec 7.7). If no overlay ever gets focus (Windows refused
	 * the foreground), the picker keeps working with the pointer (spec 7.3).
	 */
	focus(displayId: number, focused: boolean): void {
		if (this.finished) return;
		if (focused) {
			this.focused.add(displayId);
			this.hadFocus = true;
			this.unfocusedSince = null;
		} else {
			this.focused.delete(displayId);
			if (this.hadFocus && this.focused.size === 0) this.unfocusedSince = this.o.now();
		}
	}

	/** Called by the window controller at ~60 Hz while the picker is visible. */
	tick(): void {
		if (this.finished) return;
		const now = this.o.now();
		if (this.unfocusedSince !== null && now - this.unfocusedSince >= FOCUS_LOSS_GRACE_MS) {
			this.cancel("focus-lost");
			return;
		}
		if (this.o.displaysNow && now - this.lastDisplayCheck >= DISPLAY_CHECK_MS) {
			this.lastDisplayCheck = now;
			if (displaysKey(this.o.displaysNow()) !== this.displayKey) {
				this.o.log?.("display layout changed while picking");
				this.cancel("display-change");
				return;
			}
		}
		this.pollCursor(now);
		if (this.finished) return;
		this.sampleLoupe(now);
		// The "too small" hint expires on its own.
		if (this.lastView?.hint?.key === "tooSmall" && now >= this.state.tooSmallUntil) this.publish();
	}

	/**
	 * Follow the pointer when views are quiet: WebKit may not deliver mouse-moved events to
	 * a non-key overlay, so the crosshair and loupe on other displays come from polling
	 * (spec 4.1).
	 */
	private pollCursor(now: number): void {
		const pressed = this.state.phase === "dragging" || !!this.state.grab || !!this.state.press;
		const quiet = now - this.lastViewEventAt;
		if (quiet < (pressed ? DRAG_POLL_QUIET_MS : POLL_QUIET_MS)) return;
		const c = this.o.probe.cursor();
		const prev = this.state.cursor;
		if (!prev || Math.abs(prev.x - c.x) >= 0.01 || Math.abs(prev.y - c.y) >= 0.01) {
			if (pressed) this.stats.polledMoves++;
			this.dispatch({ type: "pointer", phase: "move", p: c, button: 0, mods: this.state.mods, detail: 0, t: now });
			if (this.finished) return;
		}
		// The release may land on an overlay that never saw the press (or on none): if the
		// views went quiet, ask the OS whether the button is still down.
		if (pressed && quiet >= RELEASE_POLL_MS && !this.o.probe.primaryDown()) {
			this.stats.polledRelease++;
			this.dispatch({ type: "pointer", phase: "up", p: c, button: 0, mods: this.state.mods, detail: 1, t: now });
		}
	}

	private sampleLoupe(now: number): void {
		const loupe = this.lastView?.loupe;
		const cursor = this.state.cursor;
		if (!loupe || !cursor || this.loupeInFlight || now - this.lastLoupeAt < LOUPE_INTERVAL_MS) return;
		this.loupeInFlight = true;
		this.lastLoupeAt = now;
		this.o.sampler.sample(cursor, LOUPE_CELLS).then(
			(patch) => {
				this.loupeInFlight = false;
				if (patch && !this.finished) this.o.onLoupe?.(patch);
			},
			() => {
				this.loupeInFlight = false;
			},
		);
	}

	/** Feed an event to the machine, publish, and finish on a final phase. */
	private dispatch(e: PickerEvent): void {
		if (this.finished) return;
		this.state = reducePicker(this.state, e);
		this.publish();
		const outcome = this.state.outcome;
		if (outcome) this.finish(outcome);
	}

	private finish(outcome: PickerOutcome): void {
		if (this.finished) return;
		this.finished = true;
		this.o.sampler.stop();
		this.o.onDone(outcome);
	}

	private publish(force = false): void {
		const view = pickerView(this.state, {
			seq: this.seq + 1,
			now: this.o.now(),
			...(this.o.dir ? { dir: this.o.dir } : {}),
			showLoupe: this.o.showLoupe ?? true,
			...this.hintSizeFor(),
			readoutSize: this.readoutSize,
			...(this.lastView?.hint ? { lastPlacement: this.lastView.hint.placement } : {}),
			egress: this.o.egress?.(this.state.mode) ?? null,
			liveRunning: this.o.liveRunning ?? false,
			overHint: this.pointerOverHint(),
		});
		// Skip identical frames (polling, repeated measurements): only `seq` would differ.
		const key = JSON.stringify({ ...view, seq: 0 });
		if (!force && key === this.lastViewKey) return;
		this.seq = view.seq;
		this.lastViewKey = key;
		this.lastView = view;
		this.o.onView(view);
	}

	private hintSizeFor(): { hintSize?: Size } {
		const c = this.state.cursor;
		const d = c ? displayAt(this.state.env.displays, c) : null;
		const size = d ? this.hintSizes.get(d.id) : undefined;
		return size ? { hintSize: size } : {};
	}

	private pointerOverHint(): boolean {
		const c = this.state.cursor;
		const d = c ? displayAt(this.state.env.displays, c) : null;
		return !!d && this.overHint.has(d.id);
	}
}

const displaysKey = (displays: readonly Display[]): string =>
	JSON.stringify(displays.map((d) => [d.id, d.bounds, d.scaleFactor]));

/** Narrow an outcome to its region, for Snip / Live consumers. */
export const regionOf = (o: PickerOutcome): RegionSelected | null => (o.kind === "confirmed" ? o.region : null);
