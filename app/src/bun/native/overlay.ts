// Per-OS window setup for picker overlays (GLIM-91, region-picker spec 9.1), used by the
// picker window controller. Like exclusion.ts: a BrowserWindow's `ptr` goes in, nothing
// native comes out.
//
//   macOS    glim_window_configure (level 1000, collection behaviour for Spaces and
//            fullscreen apps, no shadow, not movable, mouse-moved events, sharingType none)
//            and glim_window_set_level (100 under the Snip popup on confirm)
//   Windows  WS_EX_TOOLWINDOW instead of WS_EX_APPWINDOW, HWND_TOPMOST; level changes
//            are a no-op (the popup re-asserts HWND_TOPMOST above the overlays instead)
import type { Pointer } from "bun:ffi";
import { loadMacNative, MAC_LEVEL } from "./macos.ts";
import { configureOverlayWindow } from "./windows.ts";

export type OverlayLevel = "picking" | "belowPopup";

export interface OverlayOps {
	/** Configure a hidden overlay window. Returns a detail string for logs. Throws on failure. */
	configure(handle: Pointer): string;
	setLevel(handle: Pointer, level: OverlayLevel): void;
}

/** Null when the platform has no overlay setup (Linux) or the macOS helper is missing. */
export function overlayOpsFor(platform: string = process.platform): OverlayOps | null {
	if (platform === "win32") {
		return {
			configure: (hwnd) => `exStyle 0x${configureOverlayWindow(hwnd).toString(16)}`,
			setLevel: () => {},
		};
	}
	if (platform === "darwin") {
		const { binding } = loadMacNative();
		if (!binding) return null;
		return {
			configure: (win) => `collectionBehavior 0x${binding.configureOverlay(win).toString(16)}`,
			setLevel: (win, level) =>
				binding.setLevel(win, level === "picking" ? MAC_LEVEL.picking : MAC_LEVEL.belowSnipPopup),
		};
	}
	return null;
}
