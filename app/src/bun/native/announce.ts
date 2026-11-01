// Screen-reader announcements (GLIM-92, live-popup.md §10, §12.3): `glim_announce` and
// `glim_screen_reader_active` in libglimpse.dylib / glimpse.dll.
//
// Loaded on their own (a second dlopen of the same helper with just these symbols), so an
// older helper without them only turns announcements off; every other native feature keeps
// working and the ABI version doesn't move.
import { FFIType, type Pointer, ptr } from "bun:ffi";
import { loadNativeLibrary, type NativeStatus, nativeOsFor } from "./load.ts";

const symbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_announce: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_screen_reader_active: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;

/** What the Live announcer needs from the OS (faked in tests). */
export interface AnnounceNative {
	/** Post `text` to the screen reader; `window` is the popup (HWND, used on Windows). */
	announce(window: Pointer | null, text: string, priority: "low" | "medium" | "high"): boolean;
	/** VoiceOver / a Windows screen reader is running (null when unknown). */
	screenReaderActive(): boolean | null;
}

let loaded: { status: NativeStatus; native: AnnounceNative | null } | undefined;

export function loadAnnounceNative(): { status: NativeStatus; native: AnnounceNative | null } {
	if (loaded) return loaded;
	const os = nativeOsFor(process.platform);
	if (!os) {
		loaded = { status: { available: false, reason: "no native helper on this OS" }, native: null };
		return loaded;
	}
	const lib = loadNativeLibrary(os, symbols, "glim_abi_version");
	const sym = lib.symbols;
	if (!sym) {
		loaded = { status: lib.status, native: null };
		return loaded;
	}
	const out = new Int32Array(1);
	const level = { low: 0, medium: 1, high: 2 } as const;
	loaded = {
		status: lib.status,
		native: {
			announce: (window, text, priority) => {
				const bytes = new TextEncoder().encode(`${text}\0`);
				// The Windows path needs the popup's HWND; macOS posts on NSApp and ignores it.
				if (os === "windows" && !window) return false;
				return sym.glim_announce(window, ptr(bytes), level[priority]) === 0;
			},
			screenReaderActive: () => {
				out[0] = 0;
				return sym.glim_screen_reader_active(ptr(out)) === 0 ? out[0] === 1 : null;
			},
		},
	};
	return loaded;
}
