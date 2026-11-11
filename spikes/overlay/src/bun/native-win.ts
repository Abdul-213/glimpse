// Windows escape hatch: Win32 calls through bun:ffi on the HWND that
// Electrobun exposes as BrowserWindow.ptr, and on the HMONITOR that Electrobun
// uses as Display.id (serializeWindowsDisplay writes the HMONITOR value).
//
// Used for:
//   * physical monitor rects (Electrobun only reports logical/DIP bounds),
//   * verifying the overlay HWND really covers the monitor in physical pixels,
//   * WS_EX_TOOLWINDOW so overlays stay out of the taskbar and Alt+Tab,
//   * re-asserting HWND_TOPMOST.
//
// Threading: these calls run on Bun's worker thread. Reads are thread-safe.
// SetWindowLongPtrW / SetWindowPos on another thread's HWND are legal in Win32
// (they marshal messages to the owner thread). SetWindowPos uses
// SWP_ASYNCWINDOWPOS so we never block on Electrobun's UI thread.

import { dlopen, FFIType, type Pointer } from "bun:ffi";

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const WS_EX_NOACTIVATE = 0x08000000;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_ASYNCWINDOWPOS = 0x4000;
const MONITOR_DEFAULTTONEAREST = 2;
const MONITORINFOF_PRIMARY = 1;
// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
const DPI_CTX_PMV2 = -4;

type User32 = ReturnType<typeof openUser32>;
function openUser32() {
	return dlopen("user32.dll", {
		GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
		SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
		SetWindowPos: {
			args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
			returns: FFIType.i32,
		},
		GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		MonitorFromWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
		GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetDpiForWindow: { args: [FFIType.ptr], returns: FFIType.u32 },
		GetThreadDpiAwarenessContext: { args: [], returns: FFIType.ptr },
		SetThreadDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.ptr },
		GetAwarenessFromDpiAwarenessContext: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetForegroundWindow: { args: [], returns: FFIType.ptr },
		GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
	});
}
type Shcore = ReturnType<typeof openShcore>;
function openShcore() {
	return dlopen("shcore.dll", {
		GetDpiForMonitor: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
}

let u32: User32 | null = null;
let shcore: Shcore | null = null;
function user32(): User32 {
	if (!u32) u32 = openUser32();
	return u32;
}

export interface WinRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function readRect(buf: Int32Array, offset = 0): WinRect {
	const left = buf[offset]!;
	const top = buf[offset + 1]!;
	const right = buf[offset + 2]!;
	const bottom = buf[offset + 3]!;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 0 unaware, 1 system, 2 per-monitor (v1 or v2), -1 invalid. */
export function threadDpiAwareness(): number {
	const s = user32().symbols;
	return s.GetAwarenessFromDpiAwarenessContext(s.GetThreadDpiAwarenessContext());
}

/**
 * Make sure *this* (Bun worker) thread is per-monitor-v2 aware, otherwise
 * GetMonitorInfo / GetWindowRect / GetCursorPos return DPI-virtualised values.
 * Electrobun sets PMv2 process-wide and on its UI thread
 * (configurePerMonitorDpiAwareness), but a worker created before that call, or
 * a host that chose a weaker default, could still differ.
 */
export function ensureWorkerThreadPmv2(): { before: number; after: number } {
	const before = threadDpiAwareness();
	if (before !== 2) user32().symbols.SetThreadDpiAwarenessContext(DPI_CTX_PMV2);
	return { before, after: threadDpiAwareness() };
}

export interface WinMonitorNative {
	hmonitor: number;
	physicalBounds: WinRect;
	physicalWorkArea: WinRect;
	isPrimary: boolean;
	dpiX: number;
	dpiY: number;
}

/** MONITORINFO for an HMONITOR (Electrobun's Display.id on Windows). */
export function monitorInfo(hmonitor: number): WinMonitorNative | null {
	// MONITORINFO: DWORD cbSize; RECT rcMonitor; RECT rcWork; DWORD dwFlags  => 40 bytes
	const buf = new Int32Array(10);
	buf[0] = 40;
	const ok = user32().symbols.GetMonitorInfoW(hmonitor as unknown as Pointer, buf);
	if (!ok) return null;
	let dpiX = 0;
	let dpiY = 0;
	try {
		if (!shcore) shcore = openShcore();
		const x = new Uint32Array(1);
		const y = new Uint32Array(1);
		// MDT_EFFECTIVE_DPI = 0
		if (shcore.symbols.GetDpiForMonitor(hmonitor as unknown as Pointer, 0, x, y) === 0) {
			dpiX = x[0]!;
			dpiY = y[0]!;
		}
	} catch {
		// shcore missing (pre-8.1): leave 0
	}
	return {
		hmonitor,
		physicalBounds: readRect(buf, 1),
		physicalWorkArea: readRect(buf, 5),
		isPrimary: (buf[9]! & MONITORINFOF_PRIMARY) !== 0,
		dpiX,
		dpiY,
	};
}

export interface WinWindowNative {
	hwnd: number;
	windowRect: WinRect;
	clientRect: WinRect;
	dpi: number;
	monitor: number;
	exStyle: number;
	exStyleFlags: string[];
}

function exStyleFlags(ex: number): string[] {
	const names: [number, string][] = [
		[WS_EX_TOPMOST, "TOPMOST"],
		[WS_EX_TOOLWINDOW, "TOOLWINDOW"],
		[WS_EX_APPWINDOW, "APPWINDOW"],
		[WS_EX_LAYERED, "LAYERED"],
		[WS_EX_NOREDIRECTIONBITMAP, "NOREDIRECTIONBITMAP"],
		[WS_EX_NOACTIVATE, "NOACTIVATE"],
	];
	return names.filter(([bit]) => (ex & bit) !== 0).map(([, n]) => n);
}

export function windowNative(hwnd: Pointer): WinWindowNative {
	const s = user32().symbols;
	const wr = new Int32Array(4);
	const cr = new Int32Array(4);
	s.GetWindowRect(hwnd, wr);
	s.GetClientRect(hwnd, cr);
	const ex = Number(s.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	return {
		hwnd: Number(hwnd),
		windowRect: readRect(wr),
		clientRect: readRect(cr),
		dpi: s.GetDpiForWindow(hwnd),
		monitor: Number(s.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) ?? 0),
		exStyle: ex,
		exStyleFlags: exStyleFlags(ex),
	};
}

export interface WinOverlayOptions {
	toolWindow: boolean;
}

/** Hide from taskbar/Alt+Tab and force HWND_TOPMOST. Call while the window is still hidden. */
export function configureWinOverlayWindow(hwnd: Pointer, opts: WinOverlayOptions): { exStyleBefore: number; exStyleAfter: number } {
	const s = user32().symbols;
	const before = Number(s.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	let after = before;
	if (opts.toolWindow) after = (after & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
	if (after !== before) s.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, after);
	s.SetWindowPos(
		hwnd,
		HWND_TOPMOST,
		0,
		0,
		0,
		0,
		SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS,
	);
	return { exStyleBefore: before, exStyleAfter: Number(s.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) };
}

export function foregroundWindow(): number {
	return Number(user32().symbols.GetForegroundWindow() ?? 0);
}

/** Physical cursor position (virtual-screen pixels, PMv2). */
export function physicalCursor(): { x: number; y: number } | null {
	const p = new Int32Array(2);
	if (!user32().symbols.GetCursorPos(p)) return null;
	return { x: p[0]!, y: p[1]! };
}

/** SM_XVIRTUALSCREEN etc: the physical virtual-desktop rect. */
export function virtualScreen(): WinRect {
	const s = user32().symbols;
	return {
		x: s.GetSystemMetrics(76),
		y: s.GetSystemMetrics(77),
		width: s.GetSystemMetrics(78),
		height: s.GetSystemMetrics(79),
	};
}
