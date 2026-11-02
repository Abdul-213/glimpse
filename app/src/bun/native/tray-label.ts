// The tray / menu-bar item's accessible name (GLIM-136): what VoiceOver and Narrator read.
//
// - macOS: `glim_tray_set_accessibility_label` in libglimpse.dylib sets the status-bar button's
//   accessibilityLabel. Electrobun's Tray `title` would be visible text beside the icon, so it
//   is not used there. Loaded on its own dlopen (like announce.ts), so an older helper only
//   loses the label.
// - Windows: Electrobun's Tray `title` *is* the notification icon's tooltip (NOTIFYICONDATA
//   szTip, nativeWrapper.cpp createTray / setTrayTitle), which Narrator reads as the name. No
//   native helper needed.
// - Linux (dev only): nothing; an AppIndicator title would show as text.
import { FFIType, ptr } from "bun:ffi";
import type { Platform } from "../../shared/rpc.ts";
import { loadNativeLibrary, type NativeStatus } from "./load.ts";

const symbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_tray_set_accessibility_label: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
} as const;

/** The macOS helper call (faked in tests). */
export interface TrayLabelNative {
	/** Label Electrobun tray `trayId`'s status-bar button; false when it wasn't found. */
	setAccessibilityLabel(trayId: number, label: string): boolean;
}

let loaded: { status: NativeStatus; native: TrayLabelNative | null } | undefined;

/** macOS only; elsewhere `native` is null. */
export function loadTrayLabelNative(): { status: NativeStatus; native: TrayLabelNative | null } {
	if (loaded) return loaded;
	if (process.platform !== "darwin") {
		loaded = { status: { available: false, reason: "macOS only" }, native: null };
		return loaded;
	}
	const lib = loadNativeLibrary("macos", symbols, "glim_abi_version");
	const sym = lib.symbols;
	loaded = {
		status: lib.status,
		native: sym
			? {
					setAccessibilityLabel: (trayId, label) =>
						sym.glim_tray_set_accessibility_label(trayId, ptr(new TextEncoder().encode(`${label}\0`))) === 0,
				}
			: null,
	};
	return loaded;
}

/** The parts of Electrobun's Tray this needs. */
export interface LabelledTray {
	readonly id: number;
	setTitle(title: string): void;
}

/** Windows tooltips (szTip) hold 127 characters plus the terminator. */
const WINDOWS_TIP_MAX = 127;

/**
 * A `TrayHost.setAccessibleName` for `tray` on `platform`. Failures are logged once and
 * otherwise ignored: a missing label must never break the tray.
 */
export function trayAccessibleNameSetter(
	platform: Platform,
	tray: LabelledTray,
	native: () => TrayLabelNative | null = () => loadTrayLabelNative().native,
	warn: (message: string) => void = (m) => console.warn(m),
): (name: string) => void {
	let warned = false;
	const fail = (why: string) => {
		if (warned) return;
		warned = true;
		warn(`tray: accessible name not set (${why})`);
	};
	switch (platform) {
		case "windows":
			return (name) => tray.setTitle(name.slice(0, WINDOWS_TIP_MAX));
		case "macos":
			return (name) => {
				if (!tray.id) return fail("no tray");
				const n = native();
				if (!n) return fail(`helper unavailable: ${loadReason()}`);
				if (!n.setAccessibilityLabel(tray.id, name)) fail("status item not found");
			};
		default:
			return () => {};
	}
}

function loadReason(): string {
	const s = loaded?.status;
	return s && !s.available ? s.reason : "not loaded";
}
