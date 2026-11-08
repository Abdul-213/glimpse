// bun:ffi bindings for Windows: glimpse.dll (capture) and plain user32 calls that need
// no helper (display affinity). See app/native/windows/glimpse.h for the C ABI.
// Nothing outside app/src/bun/native/ sees a raw pointer from here.
import { dlopen, FFIType, JSCallback, type Pointer, ptr } from "bun:ffi";
import type { CapturePiece, Rect, RgbaImage } from "@glimpse/core";
import type { NativeMaterial, ThemeSetting, WindowChromeNative } from "./chrome.ts";
import {
	type FrameHandle,
	type FrameNativeBinding,
	type FrameNativeStyle,
	type FramePointer,
	type FrameSprite,
	packSprites,
} from "./frame.ts";
import { loadNativeLibrary, type NativeStatus, readNativeString } from "./load.ts";
import {
	SESSION_KIND_CODE,
	type SessionEventKind,
	type SessionNativeBinding,
	sessionKindFor,
	sessionSourceName,
} from "./session.ts";
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
	// GLIM-154: handle, count, geom f64[n*5], meta i32[n*3], pixels, bytes, peek / handle, out i32[2]
	glim_frame_set_sprites: {
		args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.f64],
		returns: FFIType.i32,
	},
	glim_frame_pointer: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	// GLIM-119 lock / sleep notifications (session.cpp)
	glim_session_start: { args: [FFIType.function], returns: FFIType.i32 },
	glim_session_stop: { args: [], returns: FFIType.i32 },
	glim_session_simulate: { args: [FFIType.i32], returns: FFIType.i32 },
	glim_session_pump: { args: [FFIType.i32], returns: FFIType.i32 },
	glim_session_info: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// GLIM-116 popup edges (window.cpp)
	glim_window_disable_resize: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_window_test_create: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_window_test_hit_test: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	glim_window_test_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
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

/** Window procedure helpers in glimpse.dll (GLIM-116). */
export interface WindowsWindowBinding {
	/** The hiddenInset frame's sizing border acts as client area (no edge resize). Throws CaptureError. */
	disableResize(hwnd: Pointer): void;
	/** Smoke tests: a hidden WS_POPUP | WS_THICKFRAME window at (100, 100), 320 x 120, on this thread. */
	testWindowCreate(): Pointer;
	/** Smoke tests: WM_NCHITTEST at a screen point (HTLEFT = 10, HTCLIENT = 1). */
	testHitTest(hwnd: Pointer, x: number, y: number): number;
	testWindowDestroy(hwnd: Pointer): void;
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

class GlimpseDll
	implements WindowsCaptureBinding, WindowsPickerBinding, FrameNativeBinding, SessionNativeBinding, WindowsWindowBinding
{
	private readonly geom = new Int32Array(10);
	private sessionCallback: JSCallback | null = null;
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

	// ---- GLIM-116 popup edges ----

	disableResize(hwnd: Pointer): void {
		const r = this.sym.glim_window_disable_resize(hwnd);
		if (r !== 0) throw captureErrorFor("windows", "subclassing the popup window", r, this.lastError());
	}

	testWindowCreate(): Pointer {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_window_test_create(ptr(out));
		if (r !== 0) throw captureErrorFor("windows", "creating a test window", r, this.lastError());
		return Number(out[0] ?? 0n) as Pointer;
	}

	testHitTest(hwnd: Pointer, x: number, y: number): number {
		return this.sym.glim_window_test_hit_test(hwnd, x, y);
	}

	testWindowDestroy(hwnd: Pointer): void {
		this.sym.glim_window_test_destroy(hwnd);
	}

	// ---- GLIM-119 lock / sleep notifications ----

	sessionStart(onEvent: (kind: SessionEventKind, source: string) => void): number {
		// Runs on the helper's watcher thread; threadsafe queues it onto this worker.
		const cb = new JSCallback(
			(kind: number, source: number) => {
				const k = sessionKindFor(kind);
				if (k) onEvent(k, sessionSourceName("windows", source));
			},
			{ args: [FFIType.i32, FFIType.i32], returns: FFIType.void, threadsafe: true },
		);
		const r = this.sym.glim_session_start(cb);
		if (r !== 0) {
			cb.close();
			return r;
		}
		// The helper now calls the new callback; the old one can go.
		this.sessionCallback?.close();
		this.sessionCallback = cb;
		return 0;
	}

	sessionStop(): void {
		this.sym.glim_session_stop();
		this.sessionCallback?.close();
		this.sessionCallback = null;
	}

	sessionSimulate(kind: SessionEventKind): number {
		return this.sym.glim_session_simulate(SESSION_KIND_CODE[kind]);
	}

	sessionPump(ms: number): void {
		this.sym.glim_session_pump(Math.max(0, Math.round(ms)));
	}

	sessionInfo(): Record<string, number> | null {
		const json = readNativeString((b, c) => this.sym.glim_session_info(ptr(b), c), 256);
		return json.startsWith("{") ? (JSON.parse(json) as Record<string, number>) : null;
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

	frameSetSprites(handle: FrameHandle, sprites: readonly FrameSprite[], peek: number): void {
		const p = packSprites(sprites);
		const r = this.sym.glim_frame_set_sprites(
			handle,
			p.count,
			ptr(p.geom),
			ptr(p.meta),
			ptr(p.pixels),
			BigInt(p.count === 0 ? 0 : p.pixels.byteLength),
			peek,
		);
		if (r !== 0) this.frameFail("drawing the Live marks", r);
	}

	framePointer(handle: FrameHandle): FramePointer {
		const out = new Int32Array(2);
		const r = this.sym.glim_frame_pointer(handle, ptr(out));
		if (r !== 0) this.frameFail("reading the pointer over the Live marks", r);
		return { hover: out[0] ?? -1, click: out[1] ?? -1 };
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
	binding:
		| (WindowsCaptureBinding & WindowsPickerBinding & FrameNativeBinding & SessionNativeBinding & WindowsWindowBinding)
		| null;
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

export const WS_EX_NOACTIVATE = 0x08000000;

/**
 * Docked Live popup ex-style (GLIM-79, live-popup.md §7, §12.1): tool window (out of the
 * taskbar and Alt+Tab) and WS_EX_NOACTIVATE, so clicking its controls doesn't take focus from
 * the game. Pure.
 */
export const livePopupExStyle = (exStyle: number): number => overlayExStyle(exStyle) | WS_EX_NOACTIVATE;

/**
 * Make an Electrobun HWND the Live popup: `livePopupExStyle` + HWND_TOPMOST. WebView2's child
 * HWND may still take focus on click (spikes/window-materials check 8); the controller restores
 * the game's focus if it does. Returns the ex-style read back.
 */
export function configureLivePopupWindow(hwnd: Pointer): number {
	const u = openUser32();
	const before = Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	const after = livePopupExStyle(before);
	if (after !== before) u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, after);
	raiseTopmost(hwnd, SWP_FRAMECHANGED);
	return Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
}

const HWND_NOTOPMOST = -2;

/**
 * The Live popup's Pin toggle off (GLIM-151): HWND_NOTOPMOST puts it at the top of the normal
 * windows, below every topmost one, so other apps can cover it. Never activates.
 */
export function dropTopmost(hwnd: Pointer): void {
	openUser32().SetWindowPos(
		hwnd,
		HWND_NOTOPMOST,
		0,
		0,
		0,
		0,
		SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
	);
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

// ---- dwmapi / ntdll / advapi32: window materials, cloak, dark mode (GLIM-116, GLIM-110) ----
//
// DwmSetWindowAttribute and DwmExtendFrameIntoClientArea talk to DWM, not to the window
// procedure, so the Bun worker calls them directly on Electrobun's HWND
// (spikes/window-materials/FINDINGS.md §3, ARCHITECTURE.md §3). The sizing-border fix needs
// a window procedure and lives in glimpse.dll (`disableResize`).

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_CLOAK = 13;
const DWMWA_CLOAKED = 14;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_SYSTEMBACKDROP_TYPE = 38;
const DWMWA_COLOR_NONE = 0xfffffffe;
const DWMWA_COLOR_DEFAULT = 0xffffffff;
// HKEY_CURRENT_USER is ((HKEY)(ULONG_PTR)((LONG)0x80000001)): sign-extended on x64.
const HKCU = -2147483647;
const RRF_RT_REG_DWORD = 0x00000010;
const PERSONALIZE = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

const chromeSymbols = {
	dwm: {
		DwmSetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		DwmGetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		DwmExtendFrameIntoClientArea: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	},
	ntdll: { RtlGetVersion: { args: [FFIType.ptr], returns: FFIType.i32 } },
	advapi: {
		RegGetValueW: {
			args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
	},
} as const;

function openChromeLibs() {
	return {
		dwm: dlopen("dwmapi.dll", chromeSymbols.dwm).symbols,
		ntdll: dlopen("ntdll.dll", chromeSymbols.ntdll).symbols,
		advapi: dlopen("advapi32.dll", chromeSymbols.advapi).symbols,
	};
}

const wide = (s: string): Uint8Array => new Uint8Array(Buffer.from(`${s}\0`, "utf16le"));
const hresult = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, "0")}`;

/** Window chrome on Windows over DWM (+ glimpse.dll for the sizing border, when loaded). */
class WindowsChrome implements WindowChromeNative {
	private libs: ReturnType<typeof openChromeLibs> | null = null;
	private build: number | null | undefined;

	constructor(private readonly dll: WindowsWindowBinding | null) {}

	private w() {
		this.libs ??= openChromeLibs();
		return this.libs;
	}

	private setDword(hwnd: Pointer, attr: number, value: number): number {
		return this.w().dwm.DwmSetWindowAttribute(hwnd, attr, ptr(Uint32Array.of(value >>> 0)), 4);
	}

	private personalize(name: string): number | null {
		const data = new Uint32Array(1);
		const size = Uint32Array.of(4);
		const rc = this.w().advapi.RegGetValueW(
			HKCU,
			ptr(wide(PERSONALIZE)),
			ptr(wide(name)),
			RRF_RT_REG_DWORD,
			null,
			ptr(data),
			ptr(size),
		);
		return rc === 0 ? (data[0] ?? null) : null;
	}

	/** Settings › Personalization › Colors › Transparency effects (missing = on). */
	reduceTransparency(): boolean {
		return this.personalize("EnableTransparency") === 0;
	}

	/** Settings › Personalization › Colors › app mode (missing = light). */
	systemDark(): boolean | null {
		return this.personalize("AppsUseLightTheme") === 0;
	}

	windowsBuild(): number | null {
		if (this.build === undefined) {
			// OSVERSIONINFOW: size, major, minor, build, platform, WCHAR[128] = 276 bytes.
			const info = new Uint32Array(69);
			info[0] = 276;
			this.build = this.w().ntdll.RtlGetVersion(ptr(info)) === 0 ? (info[3] ?? null) : null;
		}
		return this.build;
	}

	setMaterial(hwnd: Pointer, material: NativeMaterial): void {
		const build = this.windowsBuild() ?? 0;
		if (material.kind === "win-backdrop") {
			// The glass sheet: the backdrop shows wherever the webview is transparent.
			const margins = Int32Array.of(-1, -1, -1, -1);
			const hr = this.w().dwm.DwmExtendFrameIntoClientArea(hwnd, ptr(margins));
			if (hr !== 0) throw new Error(`DwmExtendFrameIntoClientArea failed: ${hresult(hr)}`);
			const backdrop = this.setDword(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, material.backdrop);
			if (backdrop !== 0) throw new Error(`DWMWA_SYSTEMBACKDROP_TYPE failed: ${hresult(backdrop)}`);
			// Titled windows (Settings) keep DWM's corners and border; Mica also fills the caption.
			if (material.systemFrame) return;
			this.setDword(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, material.corner);
			this.setDword(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE);
			return;
		}
		// Solid: no backdrop (22H2+), DWM's own border back; Windows 11 keeps its round corners.
		if (build >= 22621) this.setDword(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, 1);
		if (build >= 22000) this.setDword(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT);
	}

	setAppearance(hwnd: Pointer, _theme: ThemeSetting, dark: boolean): void {
		// Switches Acrylic / Mica between their light and dark tints. Electrobun sets it from the
		// registry at creation and on WM_SETTINGCHANGE; Glimpse re-applies after a theme change.
		this.setDword(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0);
	}

	setCloaked(hwnd: Pointer, cloaked: boolean): void {
		const hr = this.setDword(hwnd, DWMWA_CLOAK, cloaked ? 1 : 0);
		if (hr !== 0) throw new Error(`DWMWA_CLOAK failed: ${hresult(hr)}`);
	}

	/** Diagnostics / smoke tests: DWMWA_CLOAKED (0 = shown, 1 = cloaked by the app). */
	cloaked(hwnd: Pointer): number | null {
		const out = new Uint32Array(1);
		return this.w().dwm.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ptr(out), 4) === 0 ? (out[0] ?? null) : null;
	}

	disableResize(hwnd: Pointer): void {
		if (!this.dll) throw new Error("glimpse.dll is not loaded");
		this.dll.disableResize(hwnd);
	}
}

let windowsChrome: WindowsChrome | null = null;

/** Window chrome over DWM (Windows only); the sizing-border fix needs glimpse.dll. */
export function loadWindowsChrome(): WindowsChrome {
	windowsChrome ??= new WindowsChrome(loadWindowsCapture().binding);
	return windowsChrome;
}
