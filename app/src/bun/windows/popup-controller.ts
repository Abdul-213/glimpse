// The Snip popup's window controller, minus Electrobun (GLIM-65; snip-popup.md §3, §7, §8,
// §13). One pre-created, hidden popup window is reused for every Snip: a confirmed region
// opens a request, the pipeline's events fold into a `SnipPopupState` (@glimpse/core
// `reduceSnip`) and every change is pushed to the view. The window is shown once the view
// has painted the new request (or after 32 ms, whichever is first), so the first frame on
// screen is never the previous Snip.
//
// The window comes in through `PopupWindowPort` (Electrobun in windows/popup.ts, a fake in
// tests and the Linux harness). No electrobun import here.
import {
	type Display,
	type FocusKeeper,
	initialSnipState,
	type Logger,
	type PipelineEvent,
	type PipelineListener,
	type Point,
	placeSnipPopup,
	type Rect,
	reduceSnip,
	type SnipAction,
	type SnipPopupPlacement,
	type SnipPopupState,
	snipPopupFrame,
} from "@glimpse/core";
import type { SnipDismissReason, SnipLayout, SnipStateMessage } from "../../shared/popup-rpc.ts";
import { realScheduler, type Scheduler } from "./picker-controller.ts";

/** Show the window anyway if the view hasn't reported `painted` by then (spec §8). */
export const PAINT_TIMEOUT_MS = 32;
/**
 * After the popup loses key, wait this long before treating it as an app switch: a click
 * on the results layer also takes key from the popup, and that click should dismiss as
 * "outside" (with focus restore), not as "blur" (spec §7.4 vs §7.5).
 */
export const BLUR_GRACE_MS = 120;
/** Height the window starts at, before the view measures: S0 (two skeleton bars + footer). */
export const INITIAL_CONTENT_HEIGHT = 124;

/** The popup window as the controller sees it. Frames are global logical px. */
export interface PopupWindowPort {
	setFrame(frame: Rect): void;
	/** Show with activation (the popup becomes key: Snip needs keys, spec §7.1). */
	show(): void;
	hide(): void;
	send(message: SnipStateMessage): void;
}

/** Runs one Snip through the pipeline (TranslationService.snip in the app). */
export interface SnipRunner {
	snip(rect: Rect, onEvent: PipelineListener, signal: AbortSignal, runId: string): Promise<unknown>;
}

/** The results layer (picker overlays kept up under the popup). */
export interface ResultsLayer {
	dismiss(): void;
}

export interface SnipPopupSettings {
	readonly reducedMotion: boolean;
	readonly alwaysShowLanguages: boolean;
	readonly uiDir: "ltr" | "rtl";
}

export interface SnipPopupControllerDeps {
	readonly window: PopupWindowPort;
	readonly displays: () => readonly Display[];
	readonly runner: SnipRunner;
	readonly focus: FocusKeeper;
	readonly results?: ResultsLayer;
	readonly settings: () => SnipPopupSettings;
	readonly log: Logger;
	readonly pointer?: () => Point | null;
	readonly scheduler?: Scheduler;
	readonly newId?: () => string;
}

interface Request {
	readonly id: string;
	placement: SnipPopupPlacement;
	readonly abort: AbortController;
	state: SnipPopupState;
	shown: boolean;
	contentHeight: number;
	frame: Rect;
	cancelPaintTimer: (() => void) | null;
	cancelBlur: (() => void) | null;
	/** The user dragged the popup: it stays where it was dropped (spec §2.4). */
	dragged: boolean;
}

let counter = 0;
const defaultId = () => `snip-${Date.now().toString(36)}-${(++counter).toString(36)}`;

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class SnipPopupController {
	private request: Request | null = null;
	private pushQueued = false;
	private readonly scheduler: Scheduler;
	private readonly newId: () => string;

	constructor(private readonly deps: SnipPopupControllerDeps) {
		this.scheduler = deps.scheduler ?? realScheduler;
		this.newId = deps.newId ?? defaultId;
	}

	get isOpen(): boolean {
		return this.request !== null;
	}

	/** The current state (tests, the harness). */
	get state(): SnipPopupState | null {
		return this.request?.state ?? null;
	}

	get placement(): SnipPopupPlacement | null {
		return this.request?.placement ?? null;
	}

	get frame(): Rect | null {
		return this.request?.frame ?? null;
	}

	/** A confirmed Snip region: open the popup next to it and run the pipeline. Returns the request id. */
	open(region: Rect): string | null {
		if (this.request) this.close("replaced");
		const settings = this.deps.settings();
		const placement = placeSnipPopup(region, this.deps.displays(), {
			uiDir: settings.uiDir,
			pointer: this.deps.pointer?.() ?? null,
		});
		if (!placement) {
			this.deps.log.warn("snip popup: no display for the region");
			return null;
		}
		const id = this.newId();
		const frame = snipPopupFrame(placement, INITIAL_CONTENT_HEIGHT);
		const request: Request = {
			id,
			placement,
			abort: new AbortController(),
			state: initialSnipState(id, { alwaysShowLanguages: settings.alwaysShowLanguages }),
			shown: false,
			contentHeight: INITIAL_CONTENT_HEIGHT,
			frame,
			cancelPaintTimer: null,
			cancelBlur: null,
			dragged: false,
		};
		this.request = request;
		// Move (and size) the hidden window first, so it re-rasterises at the target display's
		// scale while hidden (spec §3 DPI), then let the view paint S0.
		this.deps.window.setFrame(frame);
		this.flush();
		request.cancelPaintTimer = this.scheduler.later(PAINT_TIMEOUT_MS, () => this.showNow(id, "timeout"));
		this.deps.log.info("snip popup open", {
			side: placement.side,
			displayId: placement.displayId,
			width: placement.width,
			maxHeight: Math.round(placement.maxHeight),
		});
		this.deps.runner
			.snip(region, (event) => this.onPipeline(id, event), request.abort.signal, id)
			.catch((error) => {
				if (request.abort.signal.aborted) return;
				this.deps.log.warn("snip pipeline failed", { error });
			});
		return id;
	}

	// ---- view intents ----

	painted(requestId: string): void {
		this.showNow(requestId, "painted");
	}

	resized(requestId: string, contentHeight: number): void {
		const r = this.current(requestId);
		if (!r || !Number.isFinite(contentHeight) || contentHeight <= 0) return;
		r.contentHeight = contentHeight;
		const frame = snipPopupFrame(r.placement, contentHeight);
		if (sameRect(frame, r.frame)) return;
		r.frame = frame;
		this.deps.window.setFrame(frame);
	}

	toggleSkipped(requestId: string, expanded: boolean): void {
		if (this.current(requestId)) this.dispatch({ type: "toggleSkipped", expanded });
	}

	/**
	 * The popup window gained or lost key. Losing it to another app (Cmd+Tab, Alt+Tab, a
	 * notification) dismisses without restoring focus (spec §7.5, owner question 7), after
	 * a short grace period in case the cause was a click on the results layer.
	 */
	windowFocus(focused: boolean): void {
		const r = this.request;
		if (!r?.shown) return;
		r.cancelBlur?.();
		r.cancelBlur = null;
		if (focused) return;
		const id = r.id;
		r.cancelBlur = this.scheduler.later(BLUR_GRACE_MS, () => this.dismiss(id, "blur"));
	}

	/** A press on the results layer: click outside the popup (spec §5). */
	outsideClick(): void {
		if (this.request) this.close("outside");
	}

	/**
	 * The window moved. Our own `setFrame` moves are ignored; a user drag (the footer is a
	 * drag region) re-anchors the popup where it was dropped, top edge fixed, so later
	 * growth doesn't snap it back next to the region.
	 */
	moved(x: number, y: number): void {
		const r = this.request;
		if (!r || !Number.isFinite(x) || !Number.isFinite(y)) return;
		if (Math.abs(x - r.frame.x) <= 1 && Math.abs(y - r.frame.y) <= 1) return;
		r.dragged = true;
		r.frame = { ...r.frame, x, y };
		r.placement = { ...r.placement, x, y, anchor: "top" };
	}

	/** Esc, Close (from the view), click outside, app switch, a new hotkey. */
	dismiss(requestId: string | null, reason: SnipDismissReason): void {
		const r = requestId === null ? this.request : this.current(requestId);
		if (!r) return;
		this.close(reason);
	}

	dispose(): void {
		if (this.request) this.close("replaced");
	}

	// ---- internals ----

	private current(requestId: string): Request | null {
		return this.request && this.request.id === requestId ? this.request : null;
	}

	private showNow(requestId: string, why: "painted" | "timeout"): void {
		const r = this.current(requestId);
		if (!r || r.shown) return;
		r.shown = true;
		r.cancelPaintTimer?.();
		r.cancelPaintTimer = null;
		this.deps.window.show();
		this.deps.log.debug("snip popup shown", { why });
	}

	private onPipeline(requestId: string, event: PipelineEvent): void {
		if (!this.current(requestId)) return;
		this.dispatch({ type: "pipeline", event });
		if (event.type === "done") {
			const res = event.result;
			this.deps.log.info("snip done", {
				blocks: res.blocks.length,
				translated: Object.keys(res.translations).length,
				error: res.error?.kind ?? null,
				totalMs: Math.round(res.timings.totalMs),
			});
		}
	}

	private dispatch(action: SnipAction): void {
		const r = this.request;
		if (!r) return;
		const next = reduceSnip(r.state, action);
		if (next === r.state) return;
		r.state = next;
		this.queuePush();
	}

	/** Coalesce pushes to one per microtask: a burst of cache hits sends one message. */
	private queuePush(): void {
		if (this.pushQueued) return;
		this.pushQueued = true;
		queueMicrotask(() => {
			this.pushQueued = false;
			this.flush();
		});
	}

	private flush(): void {
		const r = this.request;
		if (!r) return;
		const layout: SnipLayout = { side: r.placement.side, width: r.placement.width, maxHeight: r.placement.maxHeight };
		this.deps.window.send({
			requestId: r.id,
			layout,
			state: r.state,
			reducedMotion: this.deps.settings().reducedMotion,
		});
	}

	private close(reason: SnipDismissReason | "replaced"): void {
		const r = this.request;
		if (!r) return;
		this.request = null;
		r.cancelPaintTimer?.();
		r.cancelBlur?.();
		r.abort.abort();
		this.deps.window.hide();
		this.deps.results?.dismiss();
		this.deps.log.info("snip popup closed", { reason });
		// Spec §7.4: Esc and Close hand focus back to the app that had it before the picker.
		// A new hotkey doesn't (the new picker takes over); "replaced" is that case too.
		if (reason === "esc" || reason === "close" || reason === "outside") {
			const restored = this.deps.focus.restore();
			this.deps.log.debug("focus restore", { restored });
		}
	}
}
