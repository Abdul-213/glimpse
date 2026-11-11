// Electrobun side of the docked Live popup (GLIM-79; live-popup.md §12.1): one BrowserWindow,
// created hidden at launch and reused for every Live session. Logic lives in
// live-popup-controller.ts; this file only adapts the window.
//
//   macOS    borderless, transparent; re-classed by libglimpse.dylib to a non-activating
//            `NSPanel` (level 101, all Spaces, full-screen auxiliary, first click goes through),
//            shown with `showInactive` (`orderFrontRegardless`).
//   Windows  `hiddenInset` keeps the DWM frame; WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE and
//            HWND_TOPMOST, shown with `showInactive` (SW_SHOWNOACTIVATE).
//   Both     the first show goes through CaptureExclusion, so Live never reads its own popup.
//
// Moving and Pin (GLIM-151, live-popup.md §3.3): Electrobun's own drag (`app-region: drag` →
// startWindowMove) moves the window natively without telling us where it went, without
// clamping, and its Windows path rides on raw input; its setAlwaysOnTop drops the macOS panel
// to NSFloatingWindowLevel and calls SetWindowPos without SWP_NOACTIVATE. So the view sends
// pointer events, the controller follows the OS cursor (`Screen.getCursorScreenPoint`) and
// calls `setFrame` (SetWindowPos with SWP_NOACTIVATE / -[NSWindow setFrame:] on the
// non-activating panel), and Pin goes through our own calls: `glim_window_set_level` 101 / 0
// on macOS, HWND_TOPMOST / HWND_NOTOPMOST with SWP_NOACTIVATE on Windows.
//
// Materials and theme (GLIM-132) come from WindowChrome (window-chrome.ts), as for the Snip
// popup: NSVisualEffectView .popover on macOS, Acrylic on Windows 11 22H2+, the solid veil on
// Windows 10 / 21H2 and with reduced transparency (re-read before every show); it also sets the
// view's `data-material` / `data-theme`, so Settings › General › Theme applies at once.
import { type Display, displayAt } from "@glimpse/core";
import { BrowserView, BrowserWindow } from "electrobun/main";
import type { LiveRPC, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import { loadAnnounceNative } from "../native/announce.ts";
import { loadMacNative } from "../native/macos.ts";
import { configureLivePopupWindow, dropTopmost, raiseTopmost } from "../native/windows.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import { electrobunChromeTarget } from "./chrome-target.ts";
import {
	isLiveMarkSprite as isSprite,
	type LiveMoveResult,
	type LivePopupController,
	type LivePopupWindowPort,
} from "./live-popup-controller.ts";
import { macFlipOffset } from "./popup-init.ts";
import type { ChromeHandle, WindowChrome } from "./window-chrome.ts";

export interface ElectrobunLivePopupDeps {
	readonly exclusion: CaptureExclusion;
	readonly init: LiveViewInit;
	/** Late-bound: the controller is created with this window. */
	readonly controller: () => LivePopupController | null;
	readonly displays: () => readonly Display[];
	readonly log: (message: string) => void;
	/** Native material and theme (GLIM-132). Without it: solid veil, OS theme. */
	readonly chrome?: WindowChrome;
}

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const DIRECTIONS = new Set(["up", "down", "left", "right"] as const);
const isDirection = (v: unknown): v is "up" | "down" | "left" | "right" =>
	typeof v === "string" && DIRECTIONS.has(v as "up");

/** macOS levels for the Pin toggle: pop-up menu (101, as configured) and normal (0). */
const MAC_LEVEL_PINNED = 101;
const MAC_LEVEL_NORMAL = 0;

export class ElectrobunLivePopupWindow implements LivePopupWindowPort {
	private readonly win: BrowserWindow;
	private readonly rpc;
	private protectedOnce = false;
	private visible = false;
	private last: LiveStateMessage | null = null;
	private displayId: number | null = null;
	private pinned = true;
	private readonly chrome: ChromeHandle | null;

	constructor(private readonly deps: ElectrobunLivePopupDeps) {
		const c = () => deps.controller();
		this.rpc = BrowserView.defineRPC<LiveRPC>({
			maxRequestTime: 5_000,
			handlers: {
				requests: {
					getLiveInit: () => {
						// A view that loads late missed the push: replay it.
						queueMicrotask(() => {
							if (this.last) this.send(this.last);
						});
						return deps.init;
					},
				},
				messages: {
					livePainted: (m) => str(m?.sessionId) && c()?.painted(m.sessionId),
					liveResized: (m) => {
						if (str(m?.sessionId) && typeof m.contentHeight === "number") c()?.resized(m.sessionId, m.contentHeight);
					},
					pauseRequested: (m) => str(m?.sessionId) && c()?.pause(m.sessionId),
					resumeRequested: (m) => str(m?.sessionId) && c()?.resume(m.sessionId),
					stopRequested: (m) => str(m?.sessionId) && c()?.stop(m.sessionId),
					repinRequested: (m) => str(m?.sessionId) && c()?.repin(m.sessionId),
					continueCloudRequested: (m) => str(m?.sessionId) && void c()?.continueCloud(m.sessionId),
					privateToggled: (m) => str(m?.sessionId) && c()?.setPrivate(m.sessionId, !!m.on),
					consentAnswered: (m) => {
						if (!str(m?.sessionId)) return;
						const answer = m.answer === "cloud" || m.answer === "local" ? m.answer : "cancel";
						c()?.answerConsent(m.sessionId, answer, !!m.remember);
					},
					skippedToggled: (m) => str(m?.sessionId) && c()?.toggleSkipped(m.sessionId, !!m.expanded),
					downloadPack: (m) => {
						if (str(m?.sessionId) && str(m.lang)) c()?.downloadPack(m.sessionId, m.lang);
					},
					skippedAction: (m) => {
						if (!str(m?.sessionId)) return;
						if (m.action === "translateSkipped" || m.action === "editSources")
							c()?.skippedAction(m.sessionId, m.action);
					},
					blockHovered: (m) => {
						if (str(m?.sessionId)) c()?.hoverBlock(m.sessionId, str(m.id) ? m.id : null);
					},
					copyRequested: (m) => {
						if (str(m?.sessionId)) c()?.copy(m.sessionId, m.what === "original" ? "original" : "translation");
					},
					liveBlurred: (m) => str(m?.sessionId) && c()?.blurred(m.sessionId),
					livePointerEntered: (m) => str(m?.sessionId) && c()?.pointerEntered(m.sessionId),
					liveDragStart: (m) => str(m?.sessionId) && c()?.dragStart(m.sessionId),
					liveDragMove: (m) => str(m?.sessionId) && c()?.dragMove(m.sessionId, num(m.dx), num(m.dy)),
					liveDragEnd: (m) => str(m?.sessionId) && c()?.dragEnd(m.sessionId),
					moveRequested: (m) => {
						if (str(m?.sessionId) && isDirection(m.direction)) c()?.moveBy(m.sessionId, m.direction, !!m.large);
					},
					dockRequested: (m) => str(m?.sessionId) && c()?.dock(m.sessionId),
					pinToggled: (m) => str(m?.sessionId) && c()?.setPinned(m.sessionId, !!m.on),
					// GLIM-157: Refresh and the Update mode.
					refreshRequested: (m) => str(m?.sessionId) && c()?.refresh(m.sessionId),
					updateModeChanged: (m) =>
						str(m?.sessionId) && c()?.setUpdateMode(m.sessionId, m.mode === "manual" ? "manual" : "text"),
					// GLIM-154: overlay mode and the badges / cards for the pinned frame.
					overlayToggled: (m) => str(m?.sessionId) && c()?.toggleOverlay(m.sessionId, !!m.on),
					liveMarks: (m) =>
						str(m?.sessionId) && Array.isArray(m.sprites) && c()?.marks(m.sessionId, m.sprites.filter(isSprite)),
				},
			},
		});
		const primary = deps.displays().find((d) => d.isPrimary) ?? deps.displays()[0];
		const at = primary?.workArea ?? { x: 0, y: 0 };
		const win32 = process.platform === "win32";
		this.win = new BrowserWindow({
			title: "Glimpse Live",
			url: "views://live/index.html",
			frame: { x: at.x + 8, y: at.y + 8, width: 360, height: 96 },
			transparent: deps.chrome ? deps.chrome.transparentFor("popup") : !win32,
			titleBarStyle: win32 ? "hiddenInset" : "hidden",
			styleMask: { Borderless: true, Titled: false, Closable: false, Miniaturizable: false, Resizable: false },
			hidden: true,
			activate: false,
			rpc: this.rpc,
		});
		this.displayId = primary?.id ?? null;
		this.configure();
		// After the NSPanel re-class (same NSWindow*), so the effect view lands in the panel.
		this.chrome = deps.chrome?.attach(electrobunChromeTarget(this.win), "popup") ?? null;
		this.chrome?.disableResize();
		this.win.on("focus", () => c()?.windowFocused());
		this.win.on("blur", () => c()?.windowBlurred());
	}

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
			this.deps.log("[live-popup] window has no native handle");
			return;
		}
		try {
			if (process.platform === "win32") {
				this.deps.log(`[live-popup] exStyle 0x${configureLivePopupWindow(handle).toString(16)}`);
			} else if (process.platform === "darwin") {
				const binding = loadMacNative().binding;
				if (!binding) this.deps.log("[live-popup] libglimpse unavailable: plain window, clicks may activate");
				else this.deps.log(`[live-popup] panel swap ${binding.configureLivePopup(handle) === 1 ? "ok" : "skipped"}`);
			}
		} catch (e) {
			this.deps.log(`[live-popup] not configured: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	setFrame(frame: { x: number; y: number; width: number; height: number }): void {
		const y = frame.y + this.flipOffset();
		this.win.setFrame(frame.x, y, frame.width, frame.height);
		const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
		this.displayId = displayAt(this.deps.displays(), centre)?.id ?? this.displayId;
	}

	private reveal(show: () => void): void {
		// Reduced transparency may have changed while hidden: material and veil follow it.
		this.chrome?.refresh();
		if (!this.protectedOnce) {
			this.protectedOnce = true;
			// GLIM-98/128/164: a `popup` follows "Show Glimpse in screen sharing"; with it on, its
			// on-screen frame is painted over in Glimpse's own capture (Windows), so Live never
			// reads its own popup.
			this.deps.exclusion.protect(this.win, show, {
				role: "popup",
				bounds: () => (this.visible ? (this.deps.controller()?.frame ?? null) : null),
			});
		} else {
			show();
		}
		this.visible = true;
		const handle = this.win.ptr;
		if (process.platform === "win32" && handle && this.pinned) {
			try {
				raiseTopmost(handle);
			} catch {
				// best effort
			}
		}
	}

	/** GLIM-151 Pin: above other windows or a normal level. Never activates. */
	setPinned(on: boolean): void {
		if (on === this.pinned) return;
		this.pinned = on;
		const handle = this.win.ptr;
		if (!handle) return;
		try {
			if (process.platform === "win32") {
				if (on) raiseTopmost(handle);
				else dropTopmost(handle);
			} else if (process.platform === "darwin") {
				loadMacNative().binding?.setLevel(handle, on ? MAC_LEVEL_PINNED : MAC_LEVEL_NORMAL);
			}
		} catch (e) {
			this.deps.log(`[live-popup] pin ${on ? "on" : "off"} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** GLIM-151: a keyboard move or Dock happened; the view announces it. */
	moved(sessionId: string, result: LiveMoveResult): void {
		try {
			this.rpc.send.liveMoved({ sessionId, kind: result.kind, edges: [...result.edges] });
		} catch {
			// not connected
		}
	}

	showInactive(): void {
		this.reveal(() => this.win.showInactive());
	}

	activate(): void {
		this.reveal(() => this.win.show());
		this.win.activate();
	}

	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.win.hide();
	}

	send(message: LiveStateMessage): void {
		this.last = message;
		try {
			this.rpc.send.liveState(message);
		} catch {
			// The view hasn't connected yet; getLiveInit replays the last state.
		}
	}

	focusControls(sessionId: string): void {
		try {
			this.rpc.send.liveFocus({ sessionId });
		} catch {
			// not connected
		}
	}

	/** GLIM-92: into the view's live regions (read while the popup has focus). */
	announce(sessionId: string, text: string, kind: "change" | "status"): void {
		try {
			this.rpc.send.liveAnnounce({ sessionId, text, kind });
		} catch {
			// not connected
		}
	}

	/** GLIM-92: the OS announcement (VoiceOver / UIA notification on this window's HWND). */
	speak(text: string, kind: "change" | "status"): boolean {
		const native = loadAnnounceNative().native;
		if (!native) return false;
		try {
			return native.announce(this.win.ptr ?? null, text, kind === "status" ? "high" : "medium");
		} catch {
			return false;
		}
	}

	close(): void {
		this.chrome?.dispose();
		try {
			this.win.close();
		} catch {
			// already gone
		}
	}
}
