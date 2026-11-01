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
// Native materials aren't wired yet (as Snip): the view paints the solid veil.
import { type Display, displayAt } from "@glimpse/core";
import { BrowserView, BrowserWindow } from "electrobun/main";
import type { LiveRPC, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import { loadAnnounceNative } from "../native/announce.ts";
import { loadMacNative } from "../native/macos.ts";
import { configureLivePopupWindow, raiseTopmost } from "../native/windows.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import type { LivePopupController, LivePopupWindowPort } from "./live-popup-controller.ts";
import { macFlipOffset } from "./popup-init.ts";

export interface ElectrobunLivePopupDeps {
	readonly exclusion: CaptureExclusion;
	readonly init: LiveViewInit;
	/** Late-bound: the controller is created with this window. */
	readonly controller: () => LivePopupController | null;
	readonly displays: () => readonly Display[];
	readonly log: (message: string) => void;
}

const str = (v: unknown): v is string => typeof v === "string";

export class ElectrobunLivePopupWindow implements LivePopupWindowPort {
	private readonly win: BrowserWindow;
	private readonly rpc;
	private protectedOnce = false;
	private visible = false;
	private last: LiveStateMessage | null = null;
	private displayId: number | null = null;

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
					privateToggled: (m) => str(m?.sessionId) && c()?.setPrivate(m.sessionId, !!m.on),
					consentAnswered: (m) => {
						if (!str(m?.sessionId)) return;
						const answer = m.answer === "cloud" || m.answer === "local" ? m.answer : "cancel";
						c()?.answerConsent(m.sessionId, answer, !!m.remember);
					},
					skippedToggled: (m) => str(m?.sessionId) && c()?.toggleSkipped(m.sessionId, !!m.expanded),
					blockHovered: (m) => {
						if (str(m?.sessionId)) c()?.hoverBlock(m.sessionId, str(m.id) ? m.id : null);
					},
					copyRequested: (m) => {
						if (str(m?.sessionId)) c()?.copy(m.sessionId, m.what === "original" ? "original" : "translation");
					},
					liveBlurred: (m) => str(m?.sessionId) && c()?.blurred(m.sessionId),
					livePointerEntered: (m) => str(m?.sessionId) && c()?.pointerEntered(m.sessionId),
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
			transparent: !win32,
			titleBarStyle: win32 ? "hiddenInset" : "hidden",
			styleMask: { Borderless: true, Titled: false, Closable: false, Miniaturizable: false, Resizable: false },
			hidden: true,
			activate: false,
			rpc: this.rpc,
		});
		this.displayId = primary?.id ?? null;
		this.configure();
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
		try {
			this.win.close();
		} catch {
			// already gone
		}
	}
}
