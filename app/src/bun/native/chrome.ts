// Native window chrome: materials, light / dark appearance, hide by cloaking, frame (GLIM-116,
// GLIM-110). The binding interface both OSes implement and the constants they share; no FFI,
// so the window-chrome logic (windows/window-chrome.ts) is tested on Linux with a fake.
import type { Pointer } from "bun:ffi";
import type { Rect } from "@glimpse/core";

/** What to put behind a window's webview. */
export type NativeMaterial =
	| { readonly kind: "none" }
	/** NSVisualEffectView (behind-window, active) with a rounded mask; `material` = NSVisualEffectMaterial raw value. */
	| { readonly kind: "mac-effect"; readonly material: number; readonly radius: number }
	/**
	 * DWM system backdrop (`DWMWA_SYSTEMBACKDROP_TYPE`, Windows 11 22H2+) over a glass sheet
	 * (`DwmExtendFrameIntoClientArea(-1)`), with the corner preference and no DWM border (the
	 * webview draws the hairline).
	 */
	| { readonly kind: "win-backdrop"; readonly backdrop: number; readonly corner: number };

/** NSVisualEffectMaterial raw values Glimpse uses. */
export const NS_MATERIAL = { popover: 6, windowBackground: 12, hudWindow: 13 } as const;
/** DWM_SYSTEMBACKDROP_TYPE */
export const DWMSBT = { auto: 0, none: 1, mainWindow: 2, transientWindow: 3, tabbedWindow: 4 } as const;
/** DWM_WINDOW_CORNER_PREFERENCE */
export const DWMWCP = { default: 0, doNotRound: 1, round: 2, roundSmall: 3 } as const;
/** Windows 11 22H2: the first build with DWMWA_SYSTEMBACKDROP_TYPE (Acrylic, Mica). */
export const WIN11_22H2_BUILD = 22621;
/** Windows 11 21H2: rounded corners (DWMWA_WINDOW_CORNER_PREFERENCE). */
export const WIN11_BUILD = 22000;

/** Theme as stored in settings.appearance.theme. */
export type ThemeSetting = "system" | "light" | "dark";

export interface WindowChromeNative {
	/** macOS "Reduce transparency" / Windows "Transparency effects" off. */
	reduceTransparency(): boolean;
	/** Whether the OS app theme is dark, when the helper can read it (Windows registry); else null. */
	systemDark(): boolean | null;
	/** Windows build number (RtlGetVersion), null on macOS. */
	windowsBuild(): number | null;
	/** Apply (or remove) the material. Throws on failure. */
	setMaterial(window: Pointer, material: NativeMaterial): void;
	/**
	 * Light / dark for the native parts (material tint, title bar). macOS: NSWindow.appearance
	 * (`system` = nil, the webview follows it too). Windows: DWMWA_USE_IMMERSIVE_DARK_MODE = `dark`.
	 */
	setAppearance(window: Pointer, theme: ThemeSetting, dark: boolean): void;
	/** Windows: DWM cloak (hidden from the screen, still "shown" for the webview, so no stale frame). */
	setCloaked?(window: Pointer, cloaked: boolean): void;
	/** Windows: the hiddenInset frame's sizing border acts as client area (no edge resize). */
	disableResize?(window: Pointer): void;
	/** macOS: one native setFrame from global top-left points (no Electrobun Y-flip). */
	setFrame?(window: Pointer, frame: Rect): void;
}
