// bun:ffi bindings for Windows: glimpse.dll (capture) and plain user32 calls that need
// no helper (display affinity). See app/native/windows/glimpse.h for the C ABI.
// Nothing outside app/src/bun/native/ sees a raw pointer from here.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import type { CapturePiece, Rect, RgbaImage } from "@glimpse/core";
import type { FrameHandle, FrameNativeBinding, FrameNativeStyle } from "./frame.ts";
import { loadNativeLibrary, type NativeStatus, readNativeString } from "./load.ts";
import { captureErrorFor } from "./status.ts";
import { listNativeWindows, type NativeWindowInfo } from "./window-info.ts";

const glimpseSymbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_last_error: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_capture_displays_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_capture_piece: {
		// backend, HMONITOR, geom[10], out, stride, len, seqOut
		args: [FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	glim_capture_release: { args: [FFIType.i32], returns: FFIType.void },
	// GLIM-91 picker helpers (picker.cpp)
	glim_list_windows: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_focus_save: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_focus_restore: { args: [FFIType.ptr], returns: FFIType.i32 },
	// GLIM-90 pinned Live frame (frame.{m,cpp}): handle, rect f64[4], scale / style, palette u32[7], tag, text, below
	glim_frame_create: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_frame_set_rect: { args: [FFIType.u64, FFIType.ptr, FFIType.f64], returns: FFIType.i32 },
	glim_frame_set_style: {
		args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
		returns: FFIType.i32,
	},
	glim_frame_set_highlight: { args: [FFIType.u64, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	glim_frame_show: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
	glim_frame_window_id: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	glim_frame_destroy: { args: [FFIType.u64], returns: FFIType.i32 },
	glim_frame_info: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

export type WindowsBackend = "gdi" | "dxgi";
const BACKEND_ID: Record<WindowsBackend | "all", number> = { all: 0, gdi: 1, dxgi: 2 };

/** A monitor as glimpse.dll reports it: physical virtual-desktop pixels, keyed by HMONITOR. */
export interface PhysicalDisplay {
	readonly id: number;
	readonly name: string;
	readonly bounds: Rect;
	readonly dpi: number;
	readonly primary: boolean;
}

/** What the Windows capture service needs from glimpse.dll. Faked in tests. */
export interface WindowsCaptureBinding {
	readonly status: NativeStatus;
	physicalDisplays(): PhysicalDisplay[];
	/** Capture `piece` into `out` at `piece.dest`. Returns the backend's content sequence. Throws CaptureError. */
	capturePiece(backend: WindowsBackend, piece: CapturePiece, out: RgbaImage): number;
	release(backend: WindowsBackend | "all"): void;
}

/** What the region picker needs from glimpse.dll (GLIM-91). Faked in tests. */
export interface WindowsPickerBinding {
	/** Visible top-level windows of other processes, front to back, in PHYSICAL px. Throws CaptureError. */
	listWindows(): NativeWindowInfo[];
	/** Remember the foreground window; returns its HWND value (0 if none). */
	focusSave(): number;
	/** Give it the foreground back; true if asked to. Throws CaptureError if Windows refused. */
	focusRestore(): boolean;
}

type GlimpseSymbols = NonNullable<ReturnType<typeof loadNativeLibrary<typeof glimpseSymbols>>["symbols"]>;

class GlimpseDll implements WindowsCaptureBinding, WindowsPickerBinding, FrameNativeBinding {
	private readonly geom = new Int32Array(10);
	private readonly seq = new BigUint64Array(1);

	constructor(
		readonly status: NativeStatus,
		private readonly sym: GlimpseSymbols,
	) {}

	private lastError(): string {
		return readNativeString((b, c) => this.sym.glim_last_error(ptr(b), c), 1024);
	}

	physicalDisplays(): PhysicalDisplay[] {
		const json = readNativeString((b, c) => this.sym.glim_capture_displays_json(ptr(b), c));
		const parsed = JSON.parse(json) as { displays?: PhysicalDisplay[] };
		return parsed.displays ?? [];
	}

	capturePiece(backend: WindowsBackend, piece: CapturePiece, out: RgbaImage): number {
		const s = piece.source;
		const l = piece.sourceLocal;
		const d = piece.dest;
		this.geom.set([s.x, s.y, l.x, l.y, s.width, s.height, d.x, d.y, d.width, d.height]);
		const r = this.sym.glim_capture_piece(
			BACKEND_ID[backend],
			BigInt(piece.displayId),
			ptr(this.geom),
			ptr(out.data),
			out.width * 4,
			BigInt(out.data.length),
			ptr(this.seq),
		);
		if (r !== 0) throw captureErrorFor("windows", `${backend} capture`, r, this.lastError());
		return Number(this.seq[0]);
	}

	release(backend: WindowsBackend | "all"): void {
		this.sym.glim_capture_release(BACKEND_ID[backend]);
	}

	listWindows(): NativeWindowInfo[] {
		const { status, windows } = listNativeWindows((buf, cap, counts) =>
			this.sym.glim_list_windows(ptr(buf), cap, ptr(counts), ptr(counts, 4)),
		);
		if (status !== 0) throw captureErrorFor("windows", "EnumWindows", status, this.lastError());
		return windows;
	}

	focusSave(): number {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_focus_save(ptr(out));
		if (r !== 0) throw captureErrorFor("windows", "GetForegroundWindow", r, this.lastError());
		return Number(out[0] ?? 0n);
	}

	focusRestore(): boolean {
		const out = new Int32Array(1);
		const r = this.sym.glim_focus_restore(ptr(out));
		if (r !== 0) throw captureErrorFor("windows", "SetForegroundWindow", r, this.lastError());
		return out[0] === 1;
	}

	// ---- GLIM-90 pinned Live frame ----

	private frameFail(what: string, status: number): never {
		throw captureErrorFor("windows", what, status, this.lastError());
	}

	frameCreate(): FrameHandle {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_frame_create(ptr(out));
		if (r !== 0) this.frameFail("creating the Live frame window", r);
		return out[0] ?? 0n;
	}

	frameSetRect(handle: FrameHandle, region: Rect, scale: number): void {
		const r = this.sym.glim_frame_set_rect(
			handle,
			ptr(Float64Array.of(region.x, region.y, region.width, region.height)),
			scale,
		);
		if (r !== 0) this.frameFail("placing the Live frame", r);
	}

	frameSetStyle(handle: FrameHandle, style: FrameNativeStyle): void {
		const text = new TextEncoder().encode(`${style.tagText}\0`);
		const r = this.sym.glim_frame_set_style(
			handle,
			style.paused ? 1 : 0,
			ptr(style.palette),
			style.tag,
			ptr(text),
			style.tagBelow ? 1 : 0,
		);
		if (r !== 0) this.frameFail("styling the Live frame", r);
	}

	frameSetHighlight(handle: FrameHandle, box: Rect | null): void {
		const r = box
			? this.sym.glim_frame_set_highlight(handle, 1, ptr(Float64Array.of(box.x, box.y, box.width, box.height)))
			: this.sym.glim_frame_set_highlight(handle, 0, null);
		if (r !== 0) this.frameFail("highlighting a block on the Live frame", r);
	}

	frameShow(handle: FrameHandle, visible: boolean): void {
		const r = this.sym.glim_frame_show(handle, visible ? 1 : 0);
		if (r !== 0) this.frameFail("showing the Live frame", r);
	}

	frameWindowId(handle: FrameHandle): number {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_frame_window_id(handle, ptr(out));
		if (r !== 0) this.frameFail("reading the Live frame window id", r);
		return Number(out[0] ?? 0n);
	}

	frameDestroy(handle: FrameHandle): void {
		this.sym.glim_frame_destroy(handle);
	}

	frameInfo(handle: FrameHandle): Record<string, number> | null {
		const json = readNativeString((b, c) => this.sym.glim_frame_info(handle, ptr(b), c), 512);
		return json.startsWith("{") ? (JSON.parse(json) as Record<string, number>) : null;
	}
}

let dll: GlimpseDll | { status: NativeStatus } | undefined;

/** Load glimpse.dll once. `binding` is null when it is missing or broken (see `status`). */
export function loadWindowsCapture(): {
	status: NativeStatus;
	binding: (WindowsCaptureBinding & WindowsPickerBinding & FrameNativeBinding) | null;
} {
	if (!dll) {
		if (process.platform !== "win32") {
			dll = { status: { available: false, reason: "glimpse.dll is Windows-only" } };
		} else {
			const lib = loadNativeLibrary("windows", glimpseSymbols, "glim_abi_version");
			dll = lib.symbols ? new GlimpseDll(lib.status, lib.symbols) : { status: lib.status };
		}
	}
	return { status: dll.status, binding: dll instanceof GlimpseDll ? dll : null };
}

// ---- user32: display affinity (no helper needed, any thread may call it) ----------

export const WDA_NONE = 0x0;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;

const user32Symbols = {
	SetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	GetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
	SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
	SetWindowPos: {
		args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
		returns: FFIType.i32,
	},
} as const;

type User32 = ReturnType<typeof dlopen<typeof user32Symbols>>["symbols"];
let user32: User32 | null = null;

/** Opened on first use: dlopen("user32.dll") only makes sense on Windows. */
function openUser32(): User32 {
	user32 ??= dlopen("user32.dll", user32Symbols).symbols;
	return user32;
}

export interface AffinityResult {
	/** True when the read-back affinity is WDA_EXCLUDEFROMCAPTURE. */
	readonly excluded: boolean;
	/** GetWindowDisplayAffinity after the set, or null if it failed. */
	readonly affinity: number | null;
}

/**
 * SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE). The HWND must be a top-level
 * window of this process; there is no same-thread rule, so the Bun worker may call it
 * on Electrobun's windows. The read-back is the reliable signal (GetLastError may be
 * clobbered between FFI calls). Before Windows 10 2004 the OS silently treats it as
 * WDA_MONITOR (a black box in captures), which the read-back shows as 0x1.
 */
export function setWindowExcludedFromCapture(hwnd: Pointer, excluded = true): AffinityResult {
	const u = openUser32();
	u.SetWindowDisplayAffinity(hwnd, excluded ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
	const out = new Uint32Array(1);
	const ok = u.GetWindowDisplayAffinity(hwnd, ptr(out)) !== 0;
	const affinity = ok ? (out[0] ?? null) : null;
	return { excluded: affinity === WDA_EXCLUDEFROMCAPTURE, affinity };
}

// ---- user32: picker overlay styles (GLIM-91, region-picker spec 9.1) ------------

const GWL_EXSTYLE = -20;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_APPWINDOW = 0x00040000;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_ASYNCWINDOWPOS = 0x4000;

/** Overlay ex-style: out of the taskbar and Alt+Tab (WS_EX_TOOLWINDOW instead of WS_EX_APPWINDOW). Pure. */
export const overlayExStyle = (exStyle: number): number => (exStyle & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;

/**
 * Make an Electrobun HWND a picker overlay: tool-window ex-style and HWND_TOPMOST. Call
 * while it is still hidden. Win32 marshals both to the window's thread, and
 * SWP_ASYNCWINDOWPOS keeps the Bun worker from blocking on Electrobun's UI thread.
 * Returns the ex-style read back.
 */
export function configureOverlayWindow(hwnd: Pointer): number {
	const u = openUser32();
	const before = Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	const after = overlayExStyle(before);
	if (after !== before) u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, after);
	raiseTopmost(hwnd, SWP_FRAMECHANGED);
	return Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
}

/** Re-assert HWND_TOPMOST without activating (the Snip popup above the results layer, spec 9.1). */
export function raiseTopmost(hwnd: Pointer, extraFlags = 0): void {
	openUser32().SetWindowPos(
		hwnd,
		HWND_TOPMOST,
		0,
		0,
		0,
		0,
		SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | extraFlags,
	);
}
