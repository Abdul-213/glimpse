// bun:ffi bindings for libglimpse.dylib (macOS). See app/native/macos/glimpse.h for the
// C ABI. Nothing outside app/src/bun/native/ sees a raw pointer from here, except the
// NSWindow* that window controllers already hold (BrowserWindow.ptr).
import { FFIType, type Pointer, ptr } from "bun:ffi";
import type { Rect, RgbaImage } from "@glimpse/core";
import { loadNativeLibrary, type NativeStatus, readNativeString } from "./load.ts";
import { captureErrorFor } from "./status.ts";

const symbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_last_error: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_window_exclude_from_capture: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_window_number: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_capture_set_excluded_windows: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// displayID, src f64[4] (local points), dest i32[4] (px), out, stride, len
	glim_capture_shot: {
		args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64],
		returns: FFIType.i32,
	},
	// displayID, src f64[4], width, height, fps, handleOut
	glim_capture_stream_open: {
		args: [FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
		returns: FFIType.i32,
	},
	// handle, dest i32[4], out, stride, len, seqOut
	glim_capture_stream_read: {
		args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	glim_capture_stream_close: { args: [FFIType.u64], returns: FFIType.i32 },
	glim_capture_reset: { args: [], returns: FFIType.void },
	glim_capture_preflight: { args: [], returns: FFIType.i32 },
	glim_capture_displays_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

/** A display as CoreGraphics reports it: global points + backing scale. */
export interface MacNativeDisplay {
	readonly id: number;
	readonly bounds: Rect;
	readonly scale: number;
	readonly primary: boolean;
}

/** Opaque handle of a running SCStream. */
export type StreamHandle = bigint;

/** What the macOS capture service needs from libglimpse.dylib. Faked in tests. */
export interface MacCaptureBinding {
	readonly status: NativeStatus;
	/** Screen Recording granted to this process (CGPreflightScreenCaptureAccess; never prompts). */
	preflight(): boolean;
	/** CoreGraphics' display list (the harness uses it; the app uses Electrobun's Screen). */
	displays(): MacNativeDisplay[];
	setExcludedWindows(windowIds: readonly number[]): void;
	/** One-shot capture of `source` (display-local points) into `dest` of `out`. Throws CaptureError. */
	shot(displayId: number, source: Rect, dest: Rect, out: RgbaImage): void;
	streamOpen(displayId: number, source: Rect, width: number, height: number, fps: number): StreamHandle;
	/** Latest frame of the stream into `dest` of `out`; returns its sequence. Throws CaptureError. */
	streamRead(handle: StreamHandle, dest: Rect, out: RgbaImage): number;
	streamClose(handle: StreamHandle): void;
	reset(): void;
}

/** What window controllers need on macOS. */
export interface MacWindowBinding {
	/** NSWindow.sharingType = none; returns the CGWindowID (0 if the window has none yet). Throws. */
	excludeWindowFromCapture(nsWindow: Pointer): { windowNumber: number; sharingType: number };
	windowNumber(nsWindow: Pointer): number;
}

type Symbols = NonNullable<ReturnType<typeof loadNativeLibrary<typeof symbols>>["symbols"]>;

class LibGlimpse implements MacCaptureBinding, MacWindowBinding {
	private readonly src = new Float64Array(4);
	private readonly dest = new Int32Array(4);
	private readonly u32 = new Uint32Array(1);
	private readonly i32 = new Int32Array(1);
	private readonly u64 = new BigUint64Array(1);

	constructor(
		readonly status: NativeStatus,
		private readonly sym: Symbols,
	) {}

	private fail(what: string, status: number): never {
		throw captureErrorFor(
			"macos",
			what,
			status,
			readNativeString((b, c) => this.sym.glim_last_error(ptr(b), c), 1024),
		);
	}

	preflight(): boolean {
		return this.sym.glim_capture_preflight() === 1;
	}

	displays(): MacNativeDisplay[] {
		const json = readNativeString((b, c) => this.sym.glim_capture_displays_json(ptr(b), c));
		return (JSON.parse(json) as { displays?: MacNativeDisplay[] }).displays ?? [];
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		const ids = Uint32Array.from(windowIds.filter((id) => id > 0));
		const r = this.sym.glim_capture_set_excluded_windows(ids.length > 0 ? ptr(ids) : null, ids.length);
		if (r !== 0) this.fail("updating the capture exclusion list", r);
	}

	shot(displayId: number, source: Rect, dest: Rect, out: RgbaImage): void {
		this.src.set([source.x, source.y, source.width, source.height]);
		this.dest.set([dest.x, dest.y, dest.width, dest.height]);
		const r = this.sym.glim_capture_shot(
			displayId >>> 0,
			ptr(this.src),
			ptr(this.dest),
			ptr(out.data),
			out.width * 4,
			BigInt(out.data.length),
		);
		if (r !== 0) this.fail("ScreenCaptureKit screenshot", r);
	}

	streamOpen(displayId: number, source: Rect, width: number, height: number, fps: number): StreamHandle {
		this.src.set([source.x, source.y, source.width, source.height]);
		const r = this.sym.glim_capture_stream_open(
			displayId >>> 0,
			ptr(this.src),
			width,
			height,
			Math.max(1, Math.round(fps)),
			ptr(this.u64),
		);
		if (r !== 0) this.fail("starting the ScreenCaptureKit stream", r);
		return this.u64[0] ?? 0n;
	}

	streamRead(handle: StreamHandle, dest: Rect, out: RgbaImage): number {
		this.dest.set([dest.x, dest.y, dest.width, dest.height]);
		const r = this.sym.glim_capture_stream_read(
			handle,
			ptr(this.dest),
			ptr(out.data),
			out.width * 4,
			BigInt(out.data.length),
			ptr(this.u64),
		);
		if (r !== 0) this.fail("reading the ScreenCaptureKit stream", r);
		return Number(this.u64[0] ?? 0n);
	}

	streamClose(handle: StreamHandle): void {
		this.sym.glim_capture_stream_close(handle);
	}

	reset(): void {
		this.sym.glim_capture_reset();
	}

	excludeWindowFromCapture(nsWindow: Pointer): { windowNumber: number; sharingType: number } {
		const r = this.sym.glim_window_exclude_from_capture(nsWindow, ptr(this.u32), ptr(this.i32));
		if (r !== 0) this.fail("NSWindow sharingType", r);
		return { windowNumber: this.u32[0] ?? 0, sharingType: this.i32[0] ?? -1 };
	}

	windowNumber(nsWindow: Pointer): number {
		const r = this.sym.glim_window_number(nsWindow, ptr(this.u32));
		if (r !== 0) this.fail("NSWindow windowNumber", r);
		return this.u32[0] ?? 0;
	}
}

let lib: LibGlimpse | { status: NativeStatus } | undefined;

/** Load libglimpse.dylib once. `binding` is null when it is missing or broken (see `status`). */
export function loadMacNative(): { status: NativeStatus; binding: (MacCaptureBinding & MacWindowBinding) | null } {
	if (!lib) {
		if (process.platform !== "darwin") {
			lib = { status: { available: false, reason: "libglimpse.dylib is macOS-only" } };
		} else {
			const loaded = loadNativeLibrary("macos", symbols, "glim_abi_version");
			lib = loaded.symbols ? new LibGlimpse(loaded.status, loaded.symbols) : { status: loaded.status };
		}
	}
	return { status: lib.status, binding: lib instanceof LibGlimpse ? lib : null };
}
