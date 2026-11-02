// Changing the tray / menu-bar icon after start (GLIM-99: the state badges).
//
// - macOS: Electrobun's `Tray.setImage` (nativeWrapper.mm setTrayImage) swaps the button image
//   without `setTemplate:` or the 16 pt size its createTray sets, so the badged icon would draw
//   black on a dark menu bar and at 32 pt. `glim_tray_set_template_image` in libglimpse.dylib
//   sets it the way createTray does. Loaded on its own dlopen (like tray-label.ts), so an older
//   helper only loses the badge: the icon stays as it was, never a broken one.
// - Windows and Linux: `Tray.setImage` is right (plain light / dark PNGs, the size is the
//   notification area's).
import { FFIType, ptr } from "bun:ffi";
import type { Platform } from "../../shared/rpc.ts";
import { loadNativeLibrary, type NativeStatus } from "./load.ts";

const symbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_tray_set_template_image: {
		args: [FFIType.u32, FFIType.ptr, FFIType.f64, FFIType.f64],
		returns: FFIType.i32,
	},
} as const;

/** The macOS helper call (faked in tests). */
export interface TrayImageNative {
	/** Set tray `trayId`'s image to the PNG at `path` as a `size` pt template; false on failure. */
	setTemplateImage(trayId: number, path: string, size: number): boolean;
}

let loaded: { status: NativeStatus; native: TrayImageNative | null } | undefined;

/** macOS only; elsewhere `native` is null. */
export function loadTrayImageNative(): { status: NativeStatus; native: TrayImageNative | null } {
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
					setTemplateImage: (trayId, path, size) =>
						sym.glim_tray_set_template_image(trayId, ptr(new TextEncoder().encode(`${path}\0`)), size, size) === 0,
				}
			: null,
	};
	return loaded;
}

/** The parts of Electrobun's Tray this needs. */
export interface ImageTray {
	readonly id: number;
	setImage(image: string): void;
	/** `views://…` -> a file path (Electrobun's own resolution). */
	resolveImagePath(image: string): string;
}

/** The menu-bar icon's size in points (Electrobun's createTray uses the Tray's width/height). */
export const TRAY_POINTS = 16;

/**
 * A `TrayHost.setImage` for `tray` on `platform`. On macOS a failed call is logged once and the
 * icon is left as it was.
 */
export function trayImageSetter(
	platform: Platform,
	tray: ImageTray,
	native: () => TrayImageNative | null = () => loadTrayImageNative().native,
	warn: (message: string) => void = (m) => console.warn(m),
): (image: string) => void {
	if (platform !== "macos") return (image) => tray.setImage(image);
	let warned = false;
	const fail = (why: string) => {
		if (warned) return;
		warned = true;
		warn(`tray: badge not shown (${why})`);
	};
	return (image) => {
		if (!tray.id) return fail("no tray");
		const n = native();
		if (!n) return fail(`helper unavailable: ${loadReason()}`);
		if (!n.setTemplateImage(tray.id, tray.resolveImagePath(image), TRAY_POINTS)) fail("status item not found");
	};
}

function loadReason(): string {
	const s = loaded?.status;
	return s && !s.available ? s.reason : "not loaded";
}
