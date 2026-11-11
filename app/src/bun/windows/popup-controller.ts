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
	blockNumbers,
	clipboardText,
	type Display,
	type FocusKeeper,
	type InstallState,
	initialSnipState,
	type Logger,
	overlayCards,
	type PipelineEvent,
	type PipelineListener,
	type Point,
	placeSnipPopup,
	type RecognisedBlock,
	type Rect,
	type ResultsLayerState,
	reduceSnip,
	resultsBoxes,
	type SnipAction,
	type SnipPopupPlacement,
	type SnipPopupState,
	shouldAutoCopy,
	snipPopupFrame,
} from "@glimpse/core";
import type {
	SnipDismissReason,
	SnipLayout,
	SnipStateMessage,
	SnipAction as SnipViewAction,
} from "../../shared/popup-rpc.ts";
import { realScheduler, type Scheduler } from "./picker-controller.ts";

/** Show the window anyway if the view hasn't reported `painted` by then (spec §8). */
export const PAINT_TIMEOUT_MS = 32;
/**
 * After the popup loses key, wait this long before treating it as an app switch: a click
 * on the results layer also takes key from the popup, and that click should dismiss as
 * "outside" (with focus restore), not as "blur" (spec §7.4 vs §7.5).
 */
export const BLUR_GRACE_MS = 120;
/** After a click on a box, the popup's loss of key within this long is ours, not an app switch (GLIM-152). */
export const KEEP_KEY_MS = 400;
/** "Copied" stays in the footer this long (spec §2.4). */
export const COPIED_MS = 2_000;
/** Height the window starts at, before the view measures: S0 (two skeleton bars + footer). */
export const INITIAL_CONTENT_HEIGHT = 124;

/** The popup window as the controller sees it. Frames are global logical px. */
export interface PopupWindowPort {
	setFrame(frame: Rect): void;
	/** Show with activation (the popup becomes key: Snip needs keys, spec §7.1). */
	show(): void;
	hide(): void;
	send(message: SnipStateMessage): void;
	/**
	 * Make the (shown) popup key again: a click on a box on the results layer takes key from
	 * it, and the popup takes it back (GLIM-152). Optional: without it focus stays where it went.
	 */
	activate?(): void;
}

/** Runs one Snip through the pipeline (TranslationService in the app). */
export interface SnipRunner {
	snip(rect: Rect, onEvent: PipelineListener, signal: AbortSignal, runId: string): Promise<unknown>;
	/**
	 * Translate already-recognised blocks with the same run id: Retry (`bypassCache`), a pack
	 * that just landed, "Translate these" (`includeSkipped`). Optional: without it those
	 * actions do nothing.
	 */
	translate?(
		blocks: readonly RecognisedBlock[],
		onEvent: PipelineListener,
		signal: AbortSignal,
		runId: string,
		opts: { bypassCache?: boolean; includeSkipped?: boolean; localOnly?: boolean },
	): Promise<unknown>;
	/** E3 "Translate on this device" is possible for these blocks (GLIM-80). Optional: without it, never offered. */
	canTranslateLocally?(blocks: readonly RecognisedBlock[]): boolean;
}

/** Language-pack downloads (the app's TranslationPacks over the model manager). */
export interface PackPort {
	/** The user's consent: install these resources. */
	download(resourceIds: readonly string[]): Promise<unknown>;
	state(resourceId: string): InstallState;
	subscribe(listener: (resourceId: string, state: InstallState) => void): () => void;
}

/** Plain-text clipboard writes (Electrobun `Utils.clipboardWriteText` in the app). */
export interface ClipboardPort {
	writeText(text: string): void;
}

/** Where the error actions lead (snip-popup.md §12): the picker, Settings, a URL. */
export interface SnipActionTargets {
	snipAgain(): void;
	openSettings(section: "providers" | "languages" | "models"): void;
	openExternal(url: string): void;
	/** Spend guard (GLIM-120) "Continue this month". Optional: without it the button only retries. */
	continueCloud?(): Promise<unknown>;
}

/** macOS Screen Recording pane (E4 "Open System Settings"). */
export const SCREEN_RECORDING_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** E4 "Why does this happen?" (README section, GLIM-63/GLIM-78). */
export const SCREEN_RECORDING_HELP_URL = "https://github.com/Abdul-213/glimpse#screen-recording-permission-macos";

/** The results layer (picker overlays kept up under the popup). */
export interface ResultsLayer {
	dismiss(): void;
	/**
	 * Detection boxes on screen (GLIM-115, spec §2.3), global logical px; null clears them.
	 * Optional: without it the layer only shows the selection edge.
	 */
	showBoxes?(state: ResultsLayerState | null): void;
}

export interface SnipPopupSettings {
	readonly reducedMotion: boolean;
	readonly alwaysShowLanguages: boolean;
	/** Settings › Show original under translation (off by default, owner question 9). */
	readonly showOriginalUnder?: boolean;
	/** Settings › Copy translation after Snip (on by default, spec §6). */
	readonly autoCopy?: boolean;
	/** Settings › Show translations on screen (GLIM-152): Snips open in overlay mode. Off by default. */
	readonly showOnScreen?: boolean;
	readonly uiDir: "ltr" | "rtl";
}

export interface SnipPopupControllerDeps {
	readonly window: PopupWindowPort;
	readonly displays: () => readonly Display[];
	readonly runner: SnipRunner;
	readonly focus: FocusKeeper;
	readonly results?: ResultsLayer;
	readonly packs?: PackPort;
	readonly clipboard?: ClipboardPort;
	/** Line ends for the clipboard: `\r\n` on Windows. */
	readonly eol?: "\n" | "\r\n";
	readonly targets?: SnipActionTargets;
	readonly settings: () => SnipPopupSettings;
	readonly log: Logger;
	readonly pointer?: () => Point | null;
	readonly scheduler?: Scheduler;
	readonly newId?: () => string;
	/** Registry short name (vendor) for a provider id: "Sent to Google" in a narrow footer (GLIM-80). */
	readonly providerShortName?: (id: string) => string | null;
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
	cancelCopied: (() => void) | null;
	/** What auto-copy last wrote, so a follow-up rewrites only when the text changed. */
	autoCopiedText: string | null;
	/** The user dragged the popup: it stays where it was dropped (spec §2.4). */
	dragged: boolean;
	/** The pipeline's blocks, for follow-up translation. */
	recognised: readonly RecognisedBlock[];
	/** The Snip region (global logical) and the capture's px per logical unit, for the boxes. */
	readonly region: Rect;
	scale: number;
	/** Detected boxes before recognition (region-local device px). */
	detected: readonly { readonly id: string; readonly box: Rect }[];
	/** Block hovered or focused in the popup: its box lights (GLIM-115). */
	hovered: string | null;
	/** What the results layer last got, so unchanged state isn't re-sent. */
	boxesKey: string;
	/** A box was just clicked on screen: the popup takes key back instead of treating the blur as an app switch. */
	keepKey: boolean;
	cancelKeepKey: (() => void) | null;
}

let counter = 0;
const defaultId = () => `snip-${Date.now().toString(36)}-${(++counter).toString(36)}`;

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class SnipPopupController {
	private request: Request | null = null;
	private pushQueued = false;
	private readonly scheduler: Scheduler;
	private readonly newId: () => string;

	private readonly unsubscribePacks: (() => void) | null;

	constructor(private readonly deps: SnipPopupControllerDeps) {
		this.scheduler = deps.scheduler ?? realScheduler;
		this.newId = deps.newId ?? defaultId;
		this.unsubscribePacks = deps.packs?.subscribe((id) => this.onPackState(id)) ?? null;
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
			state: initialSnipState(id, {
				alwaysShowLanguages: settings.alwaysShowLanguages,
				showOriginalUnder: settings.showOriginalUnder ?? false,
				autoCopy: settings.autoCopy ?? true,
				overlay: settings.showOnScreen ?? false,
			}),
			shown: false,
			contentHeight: INITIAL_CONTENT_HEIGHT,
			frame,
			cancelPaintTimer: null,
			cancelBlur: null,
			cancelCopied: null,
			autoCopiedText: null,
			dragged: false,
			recognised: [],
			region,
			scale: captureScale(region, this.deps.displays()),
			detected: [],
			hovered: null,
			boxesKey: "",
			keepKey: false,
			cancelKeepKey: null,
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

	/**
	 * A block is hovered or focused in the popup (null: none): its box lights on screen
	 * (spec §2.3, §7.2). Only blocks of this request count.
	 */
	hoverBlock(requestId: string, blockId: string | null): void {
		const r = this.current(requestId);
		if (!r) return;
		const id = blockId !== null && r.state.blocks.some((b) => b.id === blockId) ? blockId : null;
		if (id === r.hovered) return;
		r.hovered = id;
		this.pushBoxes(r);
	}

	/** Overlay mode on or off (GLIM-152, §2.5): the footer toggle, Ctrl/⌘⇧T, Esc while it is on. */
	toggleOverlay(requestId: string, on: boolean): void {
		if (this.current(requestId)) this.dispatch({ type: "toggleOverlay", on });
	}

	/** The peek key is held or released in the popup (GLIM-152): overlay cards step aside. */
	peek(requestId: string, on: boolean): void {
		if (this.current(requestId)) this.dispatch({ type: "peek", on });
	}

	/**
	 * A press on the results layer (GLIM-152): on a box or its badge (`blockId`), the popup
	 * scrolls to that block and highlights it, and takes key back; anywhere else it is a click
	 * outside, which dismisses (spec §5).
	 */
	screenPress(blockId: string | null): void {
		const r = this.request;
		if (!r) return;
		if (blockId === null || !r.state.blocks.some((b) => b.id === blockId && b.cls !== "neutral")) {
			this.close("outside");
			return;
		}
		r.cancelBlur?.();
		r.cancelBlur = null;
		r.keepKey = true;
		r.cancelKeepKey?.();
		const id = r.id;
		r.cancelKeepKey = this.scheduler.later(KEEP_KEY_MS, () => {
			const cur = this.current(id);
			if (cur) cur.keepKey = false;
		});
		this.dispatch({ type: "select", id: blockId });
		if (r.shown) this.deps.window.activate?.();
	}

	/** The pointer moved onto a box on screen, or off every box (null). GLIM-152. */
	screenHover(blockId: string | null): void {
		if (this.request) this.dispatch({ type: "screenHover", id: blockId });
	}

	/** Original view on or off (§4 S6). The clipboard is unchanged by it. */
	toggleOriginal(requestId: string, on: boolean): void {
		if (this.current(requestId)) this.dispatch({ type: "toggleOriginal", on });
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
		// A click on a box took key from the popup: take it back, it isn't an app switch.
		if (r.keepKey) {
			this.deps.window.activate?.();
			return;
		}
		const id = r.id;
		r.cancelBlur = this.scheduler.later(BLUR_GRACE_MS, () => this.dismiss(id, "blur"));
	}

	/** A press on the results layer outside every box: click outside the popup (spec §5). */
	outsideClick(): void {
		this.screenPress(null);
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

	/** An error-body or pack-row button (snip-popup.md §4.1, §12). */
	action(requestId: string, action: SnipViewAction, lang?: string): void {
		const r = this.current(requestId);
		if (!r) return;
		const t = this.deps.targets;
		switch (action) {
			case "close":
				this.close("close");
				return;
			case "snipAgain":
				// The picker takes over; focus goes back when it is cancelled or the next popup closes.
				this.close("hotkey");
				t?.snipAgain();
				return;
			case "download":
				this.download(r, lang);
				return;
			case "copyOriginal":
				this.copy(requestId, "original");
				return;
			case "retry":
				this.followUp(
					r,
					r.state.blocks.filter((b) => b.cls === "translate" && b.state === "failed").map((b) => b.id),
					{ bypassCache: true },
				);
				return;
			case "local":
				// One-off: this Snip's blocks through the local translators; settings unchanged.
				this.followUp(
					r,
					r.state.blocks.filter((b) => b.cls === "translate" && b.state !== "done").map((b) => b.id),
					{ localOnly: true },
				);
				return;
			case "checkKey":
				t?.openSettings("providers");
				return;
			case "continueCloud":
				void this.continueCloud(r);
				return;
			case "editSources":
				t?.openSettings("languages");
				return;
			case "ocrSettings":
				t?.openSettings("providers");
				return;
			case "openSystemSettings":
				t?.openExternal(SCREEN_RECORDING_SETTINGS_URL);
				return;
			case "why":
				t?.openExternal(SCREEN_RECORDING_HELP_URL);
				return;
			case "translateSkipped":
				this.followUp(
					r,
					r.state.blocks.filter((b) => b.cls === "skip" && b.lang).map((b) => b.id),
					{ includeSkipped: true },
				);
				return;
		}
	}

	/**
	 * Copy again (Ctrl/⌘C with no selection, the Copy button) or copy the original
	 * (Ctrl/⌘⇧C). Shows "Copied" for 2 s. Nothing is written in an error state, or when
	 * there is no text.
	 */
	copy(requestId: string, what: "translation" | "original"): void {
		const r = this.current(requestId);
		if (!r || r.state.blocks.length === 0) return;
		if (what === "translation" && r.state.error && r.state.error !== "packMissing") return;
		if (this.writeClipboard(r, what)) this.confirmCopied(r, what, false);
	}

	/** "Retry" on one failed block (§2.2). */
	retryBlock(requestId: string, blockId: string): void {
		const r = this.current(requestId);
		if (r) this.followUp(r, [blockId], { bypassCache: true });
	}

	dispose(): void {
		if (this.request) this.close("replaced");
		this.unsubscribePacks?.();
	}

	// ---- follow-ups: retry, packs, translate these ----

	/**
	 * Spend guard (GLIM-120) "Continue this month": lift the pause, then redo what it stopped:
	 * the failed blocks (translation paused), or the whole Snip of the same region (cloud OCR
	 * paused, so nothing was read).
	 */
	private async continueCloud(r: Request): Promise<void> {
		try {
			await this.deps.targets?.continueCloud?.();
		} catch (error) {
			this.deps.log.warn("continue cloud failed", { error });
			return;
		}
		if (!this.current(r.id)) return;
		if (r.state.blocks.length === 0) {
			this.open(r.region);
			return;
		}
		this.followUp(
			r,
			r.state.blocks.filter((b) => b.cls === "translate" && b.state === "failed").map((b) => b.id),
			{ bypassCache: true },
		);
	}

	private followUp(
		r: Request,
		ids: readonly string[],
		opts: { bypassCache?: boolean; includeSkipped?: boolean; localOnly?: boolean },
	): void {
		const translate = this.deps.runner.translate;
		if (!translate || ids.length === 0) return;
		const set = new Set(ids);
		const blocks = r.recognised
			.filter((b) => set.has(b.id))
			.map((b) => (b.waitingForPack ? { ...b, waitingForPack: false } : b));
		if (blocks.length === 0) return;
		this.dispatch({ type: "followUp", phase: "start", blockIds: ids, promote: !!opts.includeSkipped });
		const id = r.id;
		translate
			.call(this.deps.runner, blocks, (event) => this.onPipeline(id, event), r.abort.signal, id, opts)
			.catch((error) => {
				if (!r.abort.signal.aborted) this.deps.log.warn("snip follow-up failed", { error });
			})
			.finally(() => {
				if (this.current(id)) this.dispatch({ type: "followUp", phase: "end" });
			});
	}

	private download(r: Request, lang: string | undefined): void {
		const packs = this.deps.packs;
		if (!packs) return;
		const rows = r.state.packs.filter((p) => (lang ? p.lang === lang : true) && p.state !== "downloading");
		for (const row of rows) {
			this.deps.log.info("pack download requested", { lang: row.lang, resources: row.resourceIds.length });
			packs.download(row.resourceIds).catch((error) => this.deps.log.warn("pack download failed", { error }));
			this.dispatch({ type: "packInstall", lang: row.lang, states: row.resourceIds.map((id) => packs.state(id)) });
		}
	}

	private onPackState(resourceId: string): void {
		const r = this.request;
		const packs = this.deps.packs;
		if (!r || !packs) return;
		const row = r.state.packs.find((p) => p.resourceIds.includes(resourceId));
		if (!row) return;
		this.dispatch({ type: "packInstall", lang: row.lang, states: row.resourceIds.map((id) => packs.state(id)) });
		// Installed: the row is gone; its blocks translate in place.
		if (!this.request?.state.packs.some((p) => p.lang === row.lang)) {
			const waiting = r.state.blocks.filter((b) => b.state === "waiting" && b.lang === row.lang).map((b) => b.id);
			this.followUp(r, waiting.length > 0 ? waiting : row.blockIds, {});
		}
	}

	private writeClipboard(r: Request, what: "translation" | "original"): boolean {
		const text = clipboardText(r.state, what, this.deps.eol ?? "\n");
		if (!this.deps.clipboard || text.length === 0) return false;
		try {
			this.deps.clipboard.writeText(text);
			return true;
		} catch (error) {
			this.deps.log.warn("clipboard write failed", { error });
			return false;
		}
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
		const r = this.current(requestId);
		if (!r) return;
		if (event.type === "recognised") r.recognised = event.blocks;
		if (event.type === "detected") {
			r.detected = event.boxes;
			if (r.region.width > 0 && event.image.width > 0) r.scale = event.image.width / r.region.width;
		}
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
		if (action.type !== "copied" && action.type !== "copiedExpired") this.maybeAutoCopy(r);
	}

	/**
	 * Spec §6: once every translate-class block is final and at least one was translated,
	 * the translation goes on the clipboard (if the setting is on). Written once per result:
	 * a follow-up ("Translate these", Retry, a pack landing) rewrites it only if the text changed.
	 */
	private maybeAutoCopy(r: Request): void {
		if (!shouldAutoCopy(r.state)) return;
		const text = clipboardText(r.state, "translation", this.deps.eol ?? "\n");
		if (text === r.autoCopiedText) return;
		r.autoCopiedText = text;
		if (this.writeClipboard(r, "translation")) {
			this.confirmCopied(r, "translation", true);
			this.deps.log.info("translation copied", { blocks: r.state.blocks.length });
		}
	}

	private confirmCopied(r: Request, what: "translation" | "original", auto: boolean): void {
		r.cancelCopied?.();
		this.dispatch({ type: "copied", what, auto });
		const id = r.id;
		r.cancelCopied = this.scheduler.later(COPIED_MS, () => {
			const cur = this.current(id);
			if (!cur) return;
			cur.cancelCopied = null;
			this.dispatch({ type: "copiedExpired" });
		});
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
		this.pushBoxes(r);
		const badge = r.state.provider;
		this.deps.window.send({
			requestId: r.id,
			layout,
			state: r.state,
			reducedMotion: this.deps.settings().reducedMotion,
			providerShortName: badge.kind === "cloud" ? (this.deps.providerShortName?.(badge.id) ?? null) : null,
			localAvailable:
				r.state.error !== null &&
				r.recognised.length > 0 &&
				(this.deps.runner.canTranslateLocally?.(r.recognised) ?? false),
		});
	}

	/** Send the results layer its boxes when they changed (detection, recognition, class, hover). */
	private pushBoxes(r: Request): void {
		const layer = this.deps.results;
		if (!layer?.showBoxes) return;
		const byId = new Map(r.recognised.map((b) => [b.id, b.box]));
		const numbers = blockNumbers(r.state.blocks);
		const blocks =
			r.state.blocks.length > 0
				? r.state.blocks.flatMap((b) => {
						const box = byId.get(b.id);
						const badge = numbers.get(b.id);
						return box ? [{ id: b.id, box, cls: b.cls, ...(badge !== undefined ? { badge } : {}) }] : [];
					})
				: r.detected.map((d) => ({ id: d.id, box: d.box, cls: null }));
		const s = r.state;
		const settings = this.deps.settings();
		const state: ResultsLayerState = {
			requestId: r.id,
			boxes: resultsBoxes(r.region, r.scale, blocks),
			// The popup's hover or focus wins; otherwise the box under the pointer on screen.
			linkedId: r.hovered ?? s.screenLinked,
			selectedId: s.selected?.id ?? null,
			overlay:
				s.overlay && !s.error
					? { cards: overlayCards(s.blocks, s.target), peek: s.peek || s.view === "original" }
					: null,
			uiDir: settings.uiDir,
			reducedMotion: settings.reducedMotion,
		};
		const key = JSON.stringify(state);
		if (key === r.boxesKey) return;
		r.boxesKey = key;
		layer.showBoxes(state);
	}

	private close(reason: SnipDismissReason | "replaced"): void {
		const r = this.request;
		if (!r) return;
		this.request = null;
		r.cancelPaintTimer?.();
		r.cancelBlur?.();
		r.cancelCopied?.();
		r.cancelKeepKey?.();
		r.abort.abort();
		this.deps.window.hide();
		// Boxes clear with the popup (spec §2.3), then the layer goes.
		if (r.boxesKey !== "") this.deps.results?.showBoxes?.(null);
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

/** Snip captures at the highest scale factor the region touches (core capture default). */
function captureScale(region: Rect, displays: readonly Display[]): number {
	let scale = 0;
	for (const d of displays) {
		const b = d.bounds;
		const overlaps =
			region.x < b.x + b.width &&
			region.x + region.width > b.x &&
			region.y < b.y + b.height &&
			region.y + region.height > b.y;
		if (overlaps) scale = Math.max(scale, d.scaleFactor);
	}
	return scale > 0 ? scale : 1;
}
