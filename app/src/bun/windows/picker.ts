// Electrobun side of the region picker (GLIM-44; region-picker spec 9.1): one transparent,
// borderless BrowserWindow per display, exactly display.bounds, created hidden at launch
// and configured for overlay duty (macOS level 1000 + Spaces/fullscreen collection
// behaviour through libglimpse.dylib; Windows WS_EX_TOOLWINDOW + HWND_TOPMOST) before it is
// ever shown. Every first show goes through CaptureExclusion, so overlays never appear in
// captures. The logic lives in picker-controller.ts.
import type { Display, PointerProbe } from "@glimpse/core";
import { BrowserView, BrowserWindow, Screen } from "electrobun/main";
import type { PickerLoupeMessage, PickerOpenInfo, PickerRPC } from "../../shared/rpc.ts";
import type { OverlayLevel, OverlayOps } from "../native/overlay.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import type { OverlayFactory, OverlayWindow, PickerController } from "./picker-controller.ts";

/** Electrobun's cursor and button state (global logical). */
export const screenProbe: PointerProbe = {
	cursor: () => Screen.getCursorScreenPoint(),
	primaryDown: () => (Screen.getMouseButtons() & 1n) !== 0n,
};

export interface ElectrobunOverlayDeps {
	readonly exclusion: CaptureExclusion;
	readonly ops: OverlayOps | null;
	/** Late-bound: the controller is created with this factory. */
	readonly controller: () => PickerController | null;
	readonly log: (message: string) => void;
}

class ElectrobunOverlay implements OverlayWindow {
	private readonly win: BrowserWindow;
	private readonly rpc;
	private shown = false;
	private protectedOnce = false;
	private level: OverlayLevel = "picking";

	constructor(
		readonly display: Display,
		private readonly deps: ElectrobunOverlayDeps,
	) {
		const id = display.id;
		const c = () => deps.controller();
		this.rpc = BrowserView.defineRPC<PickerRPC>({
			maxRequestTime: 5_000,
			handlers: {
				requests: {
					getPickerInit: ({ displayId }) => c()?.viewInit(typeof displayId === "number" ? displayId : id) ?? null,
				},
				messages: {
					pickerPointer: (m) => c()?.viewPointer({ ...m, displayId: id }),
					pickerKey: (m) => c()?.viewKey({ ...m, displayId: id }),
					pickerFocus: (m) => c()?.viewFocus(id, !!m.focused),
					pickerModeClicked: (m) => {
						if (m.mode === "snip" || m.mode === "live") c()?.modeClicked(m.mode);
					},
					pickerHintHover: (m) => c()?.hintHover(id, !!m.over),
					pickerMeasured: (m) => c()?.measured(id, m),
				},
			},
		});
		const b = display.bounds;
		this.win = new BrowserWindow({
			title: "Glimpse picker",
			url: `views://picker/index.html?display=${id}`,
			frame: { x: b.x, y: b.y, width: b.width, height: b.height },
			transparent: true,
			titleBarStyle: "hidden",
			styleMask: { Borderless: true, Titled: false, Closable: false, Miniaturizable: false, Resizable: false },
			hidden: true,
			activate: false,
			rpc: this.rpc,
		});
		// Native focus events back up the view's window focus/blur (GLIM-55: focus loss cancels).
		this.win.on("focus", () => c()?.viewFocus(id, true));
		this.win.on("blur", () => c()?.viewFocus(id, false));
		const handle = this.win.ptr;
		if (process.platform === "win32") this.win.setAlwaysOnTop(true);
		if (deps.ops && handle) {
			try {
				deps.log(`[picker] overlay ${id}: ${deps.ops.configure(handle)}`);
			} catch (e) {
				deps.log(`[picker] overlay ${id} not configured: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else if (!handle) {
			deps.log(`[picker] overlay ${id} has no native handle`);
		}
	}

	reset(info: PickerOpenInfo): void {
		this.send(() => this.rpc.send.pickerReset(info));
	}
	state(view: Parameters<OverlayWindow["state"]>[0]): void {
		this.send(() => this.rpc.send.pickerState(view));
	}
	loupe(message: PickerLoupeMessage): void {
		this.send(() => this.rpc.send.pickerLoupe(message));
	}
	fadeOut(animate: boolean): void {
		this.send(() => this.rpc.send.pickerHide({ animate }));
	}

	private send(fn: () => void): void {
		try {
			fn();
		} catch {
			// The view hasn't connected yet; it asks for the state when it does (viewInit).
		}
	}

	show(activate: boolean): void {
		const show = () => (activate ? this.win.show() : this.win.showInactive());
		if (!this.protectedOnce) {
			this.protectedOnce = true;
			this.deps.exclusion.protect(this.win, show);
		} else {
			show();
		}
		if (process.platform === "win32" && !this.shown) this.win.setAlwaysOnTop(true);
		this.shown = true;
	}

	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.win.hide();
	}

	setLevel(level: OverlayLevel): void {
		if (level === this.level) return;
		this.level = level;
		const handle = this.win.ptr;
		if (this.deps.ops && handle) {
			try {
				this.deps.ops.setLevel(handle, level);
			} catch (e) {
				this.deps.log(`[picker] level change failed: ${e instanceof Error ? e.message : String(e)}`);
			}
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

export function electrobunOverlayFactory(deps: ElectrobunOverlayDeps): OverlayFactory {
	return { create: (display) => new ElectrobunOverlay(display, deps) };
}
