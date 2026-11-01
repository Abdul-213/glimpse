// The region picker's window controller, minus Electrobun (GLIM-44; region-picker spec
// 3, 7, 8, 9.1). Owns one overlay per display (pre-created hidden at launch so opening is
// a show, not a create), runs one PickerSession per open, ticks it at 60 Hz, and emits
// RegionSelected for Snip (GLIM-65) and Live (GLIM-59).
//
// Overlays come from an OverlayFactory: Electrobun BrowserWindows in the app
// (windows/picker.ts), fakes in tests and the Linux harness. No electrobun import here.
import {
	type Display,
	type FocusKeeper,
	type Logger,
	type LoupePatch,
	type PickerMode,
	type PickerOutcome,
	PickerSession,
	type PickerViewState,
	type PixelSampler,
	type PointerProbe,
	type RegionSelected,
	type Settings,
	type WindowListSource,
} from "@glimpse/core";
import type {
	PickerKeyMessage,
	PickerLoupeMessage,
	PickerOpenInfo,
	PickerPointerMessage,
	PickerViewInit,
	Platform,
} from "../../shared/rpc.ts";

/** Picker frame rate for cursor polling and loupe scheduling (spec 4.1: 60 Hz). */
export const PICKER_TICK_MS = 16;
/** Exit fade (`duration-exit`, spec 8). */
export const EXIT_FADE_MS = 80;

/** One overlay window, as the controller sees it. */
export interface OverlayWindow {
	readonly display: Display;
	reset(info: PickerOpenInfo): void;
	state(view: PickerViewState): void;
	loupe(message: PickerLoupeMessage): void;
	/** Tell the view to fade out (or clear at once). */
	fadeOut(animate: boolean): void;
	/** Show the window; `activate` makes it the key window (the one under the pointer). */
	show(activate: boolean): void;
	hide(): void;
	/** Raise (picking) or lower under the Snip popup (results layer). */
	setLevel(level: "picking" | "belowPopup"): void;
	close(): void;
}

export interface OverlayFactory {
	create(display: Display): OverlayWindow;
}

export interface Scheduler {
	every(ms: number, fn: () => void): () => void;
	later(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
	every(ms, fn) {
		const id = setInterval(fn, ms);
		return () => clearInterval(id);
	},
	later(ms, fn) {
		const id = setTimeout(fn, ms);
		return () => clearTimeout(id);
	},
};

export interface PickerSettings {
	readonly confirmOnRelease: boolean;
	readonly showLoupe: boolean;
	readonly reducedMotion: boolean;
}

export interface PickerControllerDeps {
	readonly factory: OverlayFactory;
	readonly displays: () => readonly Display[];
	readonly probe: PointerProbe;
	readonly windows: WindowListSource;
	readonly sampler: PixelSampler;
	readonly focus: FocusKeeper;
	readonly os: Platform;
	readonly log: Logger;
	readonly now?: () => number;
	readonly scheduler?: Scheduler;
	readonly settings?: () => PickerSettings;
	/** Egress notice per mode (spec 2 J). */
	readonly egress?: (mode: PickerMode) => string | null;
	/** A Live session is running (spec 2 K). */
	readonly liveRunning?: () => boolean;
}

/**
 * Return "keep" to keep the overlays up as the results layer (Snip: the popup takes over
 * and calls `dismiss()` when it closes). Otherwise the overlays hide.
 */
export type RegionListener = (region: RegionSelected) => "keep" | undefined;

const DEFAULT_SETTINGS: PickerSettings = { confirmOnRelease: true, showLoupe: true, reducedMotion: false };

/** The picker's settings from the app's (GLIM-105). The controller asks on every open. */
export const pickerSettingsFrom = (s: Settings): PickerSettings => ({
	confirmOnRelease: s.picker.confirmOnRelease,
	showLoupe: s.picker.showLoupe,
	reducedMotion: s.appearance.motion === "reduced",
});

/**
 * Does a view cover its display at the display's scale (GLIM-54)? Returns what is off, or
 * null. A window that comes up the wrong size (Electrobun maps frames through the monitor
 * at the top-left on Windows; the macOS Y-flip bug) or at the wrong DPI shows here.
 */
export function overlayMismatch(
	d: Display,
	got: { devicePixelRatio?: number; innerWidth?: number; innerHeight?: number },
): string | null {
	const out: string[] = [];
	if (got.innerWidth !== undefined && Math.abs(got.innerWidth - d.bounds.width) > 1) {
		out.push(`width ${got.innerWidth} != ${d.bounds.width}`);
	}
	if (got.innerHeight !== undefined && Math.abs(got.innerHeight - d.bounds.height) > 1) {
		out.push(`height ${got.innerHeight} != ${d.bounds.height}`);
	}
	if (got.devicePixelRatio !== undefined && Math.abs(got.devicePixelRatio - d.scaleFactor) > 0.01) {
		out.push(`devicePixelRatio ${got.devicePixelRatio} != scale ${d.scaleFactor}`);
	}
	return out.length > 0 ? out.join(", ") : null;
}

/** Stable signature of a display layout: overlays are recreated when it changes. */
export const displaySignature = (displays: readonly Display[]): string =>
	JSON.stringify(displays.map((d) => [d.id, d.bounds, d.workArea, d.scaleFactor]));

export class PickerController {
	private overlays = new Map<number, OverlayWindow>();
	private signature = "";
	private session: PickerSession | null = null;
	private stopTick: (() => void) | null = null;
	private cancelHide: (() => void) | null = null;
	private lastReset: PickerOpenInfo | null = null;
	private lastView: PickerViewState | null = null;
	private pendingView: PickerViewState | null = null;
	private loupeSeq = 0;
	private keeping = false;
	private readonly listeners = new Set<RegionListener>();
	private readonly outcomeListeners = new Set<(o: PickerOutcome) => void>();
	private readonly resultsClickListeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly scheduler: Scheduler;

	constructor(private readonly deps: PickerControllerDeps) {
		this.now = deps.now ?? Date.now;
		this.scheduler = deps.scheduler ?? realScheduler;
	}

	get isOpen(): boolean {
		return !!this.session && !this.session.done;
	}

	get mode(): PickerMode | null {
		return this.isOpen ? (this.session?.mode ?? null) : null;
	}

	/** Displays that currently have an overlay (tests, diagnostics). */
	get overlayDisplayIds(): number[] {
		return [...this.overlays.keys()];
	}

	/** The running session (tests, the harness). */
	get current(): PickerSession | null {
		return this.session;
	}

	/** Snip / Live subscribe here. Returns an unsubscribe function. */
	onRegionSelected(listener: RegionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * A press on the results layer (the overlays kept up under the Snip popup): a click
	 * outside the popup. The overlays catch it, so it never reaches the app below
	 * (snip-popup.md §5, owner question 6). The popup dismisses itself.
	 */
	onResultsPointerDown(listener: () => void): () => void {
		this.resultsClickListeners.add(listener);
		return () => this.resultsClickListeners.delete(listener);
	}

	/** Every outcome, cancels included (logs, tests, the harness). */
	onOutcome(listener: (o: PickerOutcome) => void): () => void {
		this.outcomeListeners.add(listener);
		return () => this.outcomeListeners.delete(listener);
	}

	/** Create one hidden overlay per display, or recreate them if the layout changed. */
	prepare(): void {
		const displays = this.deps.displays();
		const sig = displaySignature(displays);
		if (sig === this.signature && this.overlays.size === displays.length) return;
		for (const o of this.overlays.values()) o.close();
		this.overlays.clear();
		for (const d of displays) this.overlays.set(d.id, this.deps.factory.create(d));
		this.signature = sig;
		this.deps.log.info("picker overlays ready", { displays: displays.length });
	}

	/**
	 * The Snip / Live command (hotkey or tray). Opens the picker in `mode`; if it is already
	 * open, the same mode's command cancels it and the other mode's switches to it (spec 6).
	 */
	toggle(mode: PickerMode): void {
		if (this.isOpen && this.session) {
			if (this.session.mode === mode) this.session.cancel("hotkey");
			else this.session.setMode(mode);
			return;
		}
		this.open(mode);
	}

	open(mode: PickerMode): void {
		if (this.isOpen) return;
		this.finishResults();
		this.cancelHide?.();
		this.cancelHide = null;
		this.prepare();
		const displays = this.deps.displays();
		if (displays.length === 0) {
			this.deps.log.warn("picker: no displays");
			return;
		}
		// Spec 7.1: remember the foreground app before anything shows.
		this.deps.focus.save();
		const settings = this.deps.settings?.() ?? DEFAULT_SETTINGS;
		const session = new PickerSession({
			env: { displays, os: this.deps.os, confirmOnRelease: settings.confirmOnRelease },
			mode,
			probe: this.deps.probe,
			windows: this.deps.windows,
			sampler: this.deps.sampler,
			now: this.now,
			showLoupe: settings.showLoupe,
			...(this.deps.egress ? { egress: this.deps.egress } : {}),
			liveRunning: this.deps.liveRunning?.() ?? false,
			onView: (v) => this.queueView(v),
			onLoupe: (p) => this.sendLoupe(p),
			onDone: (o) => this.finish(o, settings),
			log: (m) => this.deps.log.debug(m),
			displaysNow: this.deps.displays,
		});
		this.session = session;
		this.lastReset = { mode, reducedMotion: settings.reducedMotion, showLoupe: settings.showLoupe };
		for (const o of this.overlays.values()) {
			o.reset(this.lastReset);
			o.setLevel("picking");
		}
		session.start();
		this.flushView();
		// The overlay under the pointer is shown last, with activation, so it becomes key and
		// Esc works (spec 7.2). The others show without activation.
		const pointerDisplay = session.view?.pointerDisplayId ?? displays[0]?.id;
		for (const o of this.overlays.values()) if (o.display.id !== pointerDisplay) o.show(false);
		if (pointerDisplay !== undefined) this.overlays.get(pointerDisplay)?.show(true);
		this.stopTick = this.scheduler.every(PICKER_TICK_MS, () => this.session?.tick());
		this.deps.log.info("picker open", { mode, displays: displays.length });
	}

	cancel(reason: "external" | "escape" = "external"): void {
		this.session?.cancel(reason);
	}

	/** Snip popup closed: take the results layer down (no focus restore here: the popup does it, snip-popup.md 7). */
	dismiss(): void {
		if (!this.keeping) return;
		this.keeping = false;
		this.hideAll(this.lastReset?.reducedMotion === false);
	}

	// ---- view input (from each overlay's RPC handlers) ----

	viewInit(
		displayId: number,
		got: { devicePixelRatio?: number; innerWidth?: number; innerHeight?: number } = {},
	): PickerViewInit | null {
		const o = this.overlays.get(displayId);
		if (!o) return null;
		const d = o.display;
		const problem = overlayMismatch(d, got);
		if (problem) this.deps.log.warn("picker overlay mismatch", { displayId, problem, ...got });
		// A view that loads after an open missed the reset/state pushes: replay them.
		queueMicrotask(() => {
			if (this.lastReset) o.reset(this.lastReset);
			if (this.lastView) o.state(this.lastView);
		});
		return {
			displayId,
			origin: { x: d.bounds.x, y: d.bounds.y },
			size: { width: d.bounds.width, height: d.bounds.height },
			scaleFactor: d.scaleFactor,
			os: this.deps.os,
			uiDir: "ltr",
		};
	}

	viewPointer(m: PickerPointerMessage): void {
		if (!this.overlays.has(m.displayId)) return;
		if (!this.isOpen && this.keeping) {
			if (m.phase === "down") for (const l of this.resultsClickListeners) l();
			return;
		}
		this.session?.pointer(m);
	}

	viewKey(m: PickerKeyMessage): void {
		if (!this.overlays.has(m.displayId)) return;
		this.session?.key(m);
	}

	viewFocus(displayId: number, focused: boolean): void {
		if (!this.overlays.has(displayId)) return;
		this.session?.focus(displayId, focused);
	}

	modeClicked(mode: PickerMode): void {
		this.session?.setMode(mode);
	}

	hintHover(displayId: number, over: boolean): void {
		this.session?.hintHover(displayId, over);
	}

	measured(
		displayId: number,
		m: { hint?: { width: number; height: number }; readout?: { text: string; width: number; height: number } },
	): void {
		this.session?.measured(displayId, {
			...(m.hint ? { hint: m.hint } : {}),
			...(m.readout
				? { readout: { text: m.readout.text, size: { width: m.readout.width, height: m.readout.height } } }
				: {}),
		});
	}

	dispose(): void {
		this.session?.cancel("external");
		this.stopTick?.();
		this.cancelHide?.();
		for (const o of this.overlays.values()) o.close();
		this.overlays.clear();
		this.signature = "";
	}

	// ---- internals ----

	/** Coalesce view pushes to one per microtask (several inputs can land in one turn). */
	private queueView(v: PickerViewState): void {
		const first = this.pendingView === null;
		this.pendingView = v;
		if (first) queueMicrotask(() => this.flushView());
	}

	private flushView(): void {
		const v = this.pendingView;
		if (!v) return;
		this.pendingView = null;
		this.lastView = v;
		for (const o of this.overlays.values()) o.state(v);
	}

	private sendLoupe(p: LoupePatch): void {
		const o = this.overlays.get(p.displayId);
		if (!o) return;
		o.loupe({
			seq: ++this.loupeSeq,
			displayId: p.displayId,
			size: p.size,
			rgba: Buffer.from(p.rgba.buffer, p.rgba.byteOffset, p.rgba.byteLength).toString("base64"),
		});
	}

	private finish(outcome: PickerOutcome, settings: PickerSettings): void {
		this.stopTick?.();
		this.stopTick = null;
		this.flushView();
		const animate = !settings.reducedMotion;
		const stats = this.session?.stats;
		if (stats && (stats.substituted || stats.polledMoves || stats.polledRelease)) {
			this.deps.log.debug("picker cross-display tracking", { ...stats });
		}
		for (const l of this.outcomeListeners) l(outcome);
		if (outcome.kind === "cancelled") {
			this.deps.log.info("picker cancelled", { reason: outcome.reason });
			this.hideAll(animate);
			// Spec 7.4 / 7.7: give focus back, unless the user moved it elsewhere themselves.
			if (outcome.reason !== "focus-lost") this.restoreFocus();
			// Overlays sized for displays that changed or vanished go now, not on the next open.
			if (outcome.reason === "display-change") this.prepareAfterHide(animate);
			return;
		}
		const region = outcome.region;
		this.deps.log.info("region selected", {
			mode: region.mode,
			source: region.source,
			width: region.rect.width,
			height: region.rect.height,
			displays: region.pieces.length,
		});
		let keep = false;
		for (const l of this.listeners) {
			try {
				if (l(region) === "keep") keep = true;
			} catch (error) {
				this.deps.log.error("region listener failed", { error });
			}
		}
		if (region.mode === "snip" && keep) {
			// Results layer: scrim gone, selection edge stays, under the Snip popup, which takes
			// focus itself (spec 7.5, 9.1).
			this.keeping = true;
			for (const o of this.overlays.values()) o.setLevel("belowPopup");
			return;
		}
		this.hideAll(animate);
		// Live confirm (spec 7.6): focus goes straight back so a game keeps its frame budget.
		// A Snip nobody kept (no popup yet) is treated the same way.
		this.restoreFocus();
	}

	private restoreFocus(): void {
		const restored = this.deps.focus.restore();
		this.deps.log.debug("focus restore", { restored });
	}

	private prepareAfterHide(animate: boolean): void {
		const run = () => {
			if (!this.isOpen) this.prepare();
		};
		if (animate) this.scheduler.later(EXIT_FADE_MS + 1, run);
		else run();
	}

	/** A new open while the results layer is up replaces it. */
	private finishResults(): void {
		if (this.keeping) {
			this.keeping = false;
			for (const o of this.overlays.values()) o.hide();
		}
	}

	private hideAll(animate: boolean): void {
		for (const o of this.overlays.values()) o.fadeOut(animate);
		const hide = () => {
			this.cancelHide = null;
			for (const o of this.overlays.values()) o.hide();
		};
		if (animate) this.cancelHide = this.scheduler.later(EXIT_FADE_MS, hide);
		else hide();
	}
}
