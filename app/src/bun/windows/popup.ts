// Electrobun side of the Snip popup (GLIM-65; snip-popup.md §13.1): one BrowserWindow,
// created hidden at launch and reused for every Snip, so showing it is a show, not a
// create. Logic lives in popup-controller.ts; this file only adapts the window.
//
//   macOS    borderless, transparent (the view draws the 12px-radius veil), level 101 (pop-up
//            menu) so it sits above the results layer (overlays lowered to 100).
//   Windows  `hiddenInset` keeps the DWM frame (shadow, 8px corners, spike §3); tool window
//            (no taskbar button, out of Alt+Tab) and HWND_TOPMOST, re-asserted after every
//            show so it stays above the overlays.
//   Both     the first show goes through CaptureExclusion, so the popup is never captured.
//
// Native materials (Acrylic, NSVisualEffectView) aren't wired yet: the view paints the
// solid `surface-popup-solid` veil (`data-material="none"`) until they are.
import { type Display, displayAt } from "@glimpse/core";
import { BrowserView, BrowserWindow } from "electrobun/main";
import {
	SNIP_ACTIONS,
	type SnipAction,
	type SnipPopupRPC,
	type SnipStateMessage,
	type SnipViewInit,
} from "../../shared/popup-rpc.ts";
import { loadMacNative } from "../native/macos.ts";
import { configureOverlayWindow, raiseTopmost } from "../native/windows.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import type { PopupWindowPort, SnipPopupController } from "./popup-controller.ts";
import { macFlipOffset } from "./popup-init.ts";

/** NSWindow level for the Snip popup: NSPopUpMenuWindowLevel, above the lowered overlays (100). */
export const MAC_POPUP_LEVEL = 101;

export interface ElectrobunPopupDeps {
	readonly exclusion: CaptureExclusion;
	readonly init: SnipViewInit;
	/** Late-bound: the controller is created with this window. */
	readonly controller: () => SnipPopupController | null;
	readonly displays: () => readonly Display[];
	readonly log: (message: string) => void;
}

export class ElectrobunPopupWindow implements PopupWindowPort {
	private readonly win: BrowserWindow;
	private readonly rpc;
	private protectedOnce = false;
	private visible = false;
	private last: SnipStateMessage | null = null;
	/** The display the window is on (macOS Y-flip workaround). */
	private displayId: number | null = null;

	constructor(private readonly deps: ElectrobunPopupDeps) {
		const c = () => deps.controller();
		this.rpc = BrowserView.defineRPC<SnipPopupRPC>({
			maxRequestTime: 5_000,
			handlers: {
				requests: {
					getSnipInit: () => {
						// A view that loads late (first Snip right after launch) missed the push: replay it.
						queueMicrotask(() => {
							if (this.last) this.send(this.last);
						});
						return deps.init;
					},
				},
				messages: {
					snipPainted: (m) => {
						if (typeof m?.requestId === "string") c()?.painted(m.requestId);
					},
					snipResized: (m) => {
						if (typeof m?.requestId === "string" && typeof m.contentHeight === "number") {
							c()?.resized(m.requestId, m.contentHeight);
						}
					},
					snipDismiss: (m) => {
						if (typeof m?.requestId !== "string") return;
						c()?.dismiss(m.requestId, m.reason === "close" ? "close" : "esc");
					},
					snipSkipped: (m) => {
						if (typeof m?.requestId === "string") c()?.toggleSkipped(m.requestId, !!m.expanded);
					},
					snipAction: (m) => {
						if (typeof m?.requestId !== "string" || !SNIP_ACTIONS.includes(m.action as SnipAction)) return;
						c()?.action(m.requestId, m.action, typeof m.lang === "string" ? m.lang : undefined);
					},
					snipOriginal: (m) => {
						if (typeof m?.requestId === "string") c()?.toggleOriginal(m.requestId, !!m.on);
					},
					snipRetryBlock: (m) => {
						if (typeof m?.requestId === "string" && typeof m.blockId === "string") {
							c()?.retryBlock(m.requestId, m.blockId);
						}
					},
				},
			},
		});
		const primary = deps.displays().find((d) => d.isPrimary) ?? deps.displays()[0];
		const at = primary?.workArea ?? { x: 0, y: 0 };
		const win32 = process.platform === "win32";
		this.win = new BrowserWindow({
			title: "Glimpse",
			url: "views://popup/index.html",
			frame: { x: at.x + 8, y: at.y + 8, width: 360, height: 124 },
			transparent: !win32,
			titleBarStyle: win32 ? "hiddenInset" : "hidden",
			styleMask: { Borderless: true, Titled: false, Closable: false, Miniaturizable: false, Resizable: false },
			hidden: true,
			activate: false,
			rpc: this.rpc,
		});
		this.displayId = primary?.id ?? null;
		this.configure();
		// Key changes and moves (app switch dismisses; a footer drag re-anchors the popup).
		this.win.on("focus", () => c()?.windowFocus(true));
		this.win.on("blur", () => c()?.windowFocus(false));
		this.win.on("move", (e) => {
			const d = (e as { data?: { x?: unknown; y?: unknown } }).data;
			if (typeof d?.x !== "number" || typeof d.y !== "number") return;
			c()?.moved(d.x, d.y - this.flipOffset());
		});
	}

	/** macOS only: Electrobun's Y-flip error for the window's current display (0 elsewhere). */
	private flipOffset(): number {
		if (process.platform !== "darwin") return 0;
		const displays = this.deps.displays();
		const primary = displays.find((d) => d.isPrimary) ?? displays[0];
		const current = displays.find((d) => d.id === this.displayId) ?? primary;
		return primary && current ? macFlipOffset(current.bounds.height, primary.bounds.height) : 0;
	}

	private configure(): void {
		const handle = this.win.ptr;
		if (!handle) {
			this.deps.log("[popup] window has no native handle");
			return;
		}
		try {
			if (process.platform === "win32") {
				this.deps.log(`[popup] exStyle 0x${configureOverlayWindow(handle).toString(16)}`);
			} else if (process.platform === "darwin") {
				loadMacNative().binding?.setLevel(handle, MAC_POPUP_LEVEL);
			}
		} catch (e) {
			this.deps.log(`[popup] not configured: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	setFrame(frame: { x: number; y: number; width: number; height: number }): void {
		// Electrobun flips against the screen the window is on *before* the move.
		const y = frame.y + this.flipOffset();
		this.win.setFrame(frame.x, y, frame.width, frame.height);
		const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
		this.displayId = displayAt(this.deps.displays(), centre)?.id ?? this.displayId;
	}

	show(): void {
		const show = () => this.win.show();
		if (!this.protectedOnce) {
			this.protectedOnce = true;
			this.deps.exclusion.protect(this.win, show);
		} else {
			show();
		}
		this.visible = true;
		const handle = this.win.ptr;
		if (process.platform === "win32" && handle) {
			try {
				raiseTopmost(handle);
			} catch {
				// best effort
			}
		}
	}

	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.win.hide();
	}

	send(message: SnipStateMessage): void {
		this.last = message;
		try {
			this.rpc.send.snipState(message);
		} catch {
			// The view hasn't connected yet; getSnipInit replays the last state.
		}
	}

	close(): void {
		try {
			this.win.close();
		} catch {
			// already gone
		}
	}
}
