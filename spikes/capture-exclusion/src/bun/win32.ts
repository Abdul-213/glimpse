// Windows: display affinity + GDI capture, straight through bun:ffi.
//
// No native helper library is needed here (unlike macOS):
//   * SetWindowDisplayAffinity only requires that the HWND is a top-level window
//     owned by the calling *process*. There is no same-thread requirement, so the
//     Bun worker thread can call it on the HWND that Electrobun's main thread
//     created (BrowserWindow.ptr is that HWND on Windows).
//   * GDI screen capture (GetDC(NULL) + BitBlt) is thread-agnostic.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { type Rect, describeWin32Error } from "../shared/analysis";

const GA_ROOT = 2;
const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const DIB_RGB_COLORS = 0;

type Libs = ReturnType<typeof openLibs>;

function openLibs() {
	const user32 = dlopen("user32.dll", {
		SetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
		GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		IsWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
		GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
		ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetThreadDpiAwarenessContext: { args: [], returns: FFIType.ptr },
		GetAwarenessFromDpiAwarenessContext: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const gdi32 = dlopen("gdi32.dll", {
		CreateCompatibleDC: { args: [FFIType.ptr], returns: FFIType.ptr },
		CreateCompatibleBitmap: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
		SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		BitBlt: {
			args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.u32],
			returns: FFIType.i32,
		},
		GetDIBits: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		DeleteObject: { args: [FFIType.ptr], returns: FFIType.i32 },
		DeleteDC: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const kernel32 = dlopen("kernel32.dll", {
		GetLastError: { args: [], returns: FFIType.u32 },
		GetCurrentProcessId: { args: [], returns: FFIType.u32 },
	});
	const ntdll = dlopen("ntdll.dll", {
		RtlGetVersion: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	return { user32: user32.symbols, gdi32: gdi32.symbols, kernel32: kernel32.symbols, ntdll: ntdll.symbols };
}

let libs: Libs | null = null;
function L(): Libs {
	if (process.platform !== "win32") throw new Error("win32 module used off Windows");
	libs ??= openLibs();
	return libs;
}

export interface WinVersion {
	major: number;
	minor: number;
	build: number;
}

export function windowsVersion(): WinVersion {
	// RTL_OSVERSIONINFOW: 5 x ULONG + WCHAR[128] = 276 bytes
	const buf = new Uint8Array(276);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, 276, true);
	L().ntdll.RtlGetVersion(ptr(buf));
	return { major: dv.getUint32(4, true), minor: dv.getUint32(8, true), build: dv.getUint32(12, true) };
}

export interface HwndInfo {
	hwnd: Pointer;
	root: Pointer | null;
	isTopLevel: boolean;
	ownedByUs: boolean;
	rect: Rect | null;
}

export function inspectHwnd(hwnd: Pointer): HwndInfo {
	const { user32, kernel32 } = L();
	const root = user32.GetAncestor(hwnd, GA_ROOT) as Pointer | null;
	const pidBuf = new Uint32Array(1);
	user32.GetWindowThreadProcessId(hwnd, ptr(pidBuf));
	return {
		hwnd,
		root,
		isTopLevel: root !== null && Number(root) === Number(hwnd),
		ownedByUs: pidBuf[0] === kernel32.GetCurrentProcessId(),
		rect: windowRect(hwnd),
	};
}

/** Physical-pixel window rect (includes the invisible resize border on Win10+). */
export function windowRect(hwnd: Pointer): Rect | null {
	const r = new Int32Array(4);
	if (!L().user32.GetWindowRect(hwnd, ptr(r))) return null;
	return { x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]! };
}

export interface AffinityResult {
	ok: boolean;
	lastError: number;
	readBack: number | null;
	detail: string;
}

export function setDisplayAffinity(hwnd: Pointer, affinity: number): AffinityResult {
	const { user32, kernel32 } = L();
	const ok = user32.SetWindowDisplayAffinity(hwnd, affinity) !== 0;
	// Read immediately; Bun may run other code between calls, so treat as a hint.
	const lastError = ok ? 0 : kernel32.GetLastError();
	const readBack = getDisplayAffinity(hwnd);
	return {
		ok,
		lastError,
		readBack,
		detail: ok
			? `SetWindowDisplayAffinity(0x${affinity.toString(16)}) -> TRUE, GetWindowDisplayAffinity -> 0x${readBack?.toString(16)}`
			: `SetWindowDisplayAffinity(0x${affinity.toString(16)}) -> FALSE, GetLastError=${describeWin32Error(lastError)}`,
	};
}

export function getDisplayAffinity(hwnd: Pointer): number | null {
	const out = new Uint32Array(1);
	return L().user32.GetWindowDisplayAffinity(hwnd, ptr(out)) ? out[0]! : null;
}

export function dpiAwareness(): string {
	const { user32 } = L();
	const ctx = user32.GetThreadDpiAwarenessContext();
	const a = user32.GetAwarenessFromDpiAwarenessContext(ctx);
	return ["unaware", "system", "per-monitor"][a] ?? `unknown(${a})`;
}

export interface Capture {
	rgba: Uint8Array; // filled as BGRA by GDI; caller converts
	width: number;
	height: number;
	origin: { x: number; y: number };
	ms: number;
}

/**
 * GDI BitBlt of the whole virtual screen (all monitors), physical pixels when
 * the thread is per-monitor DPI aware. Returns BGRA, top-down.
 */
export function captureVirtualScreenBitBlt(): Capture {
	const { user32, gdi32 } = L();
	const t0 = performance.now();
	const x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN);
	const y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN);
	const width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN);
	const height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN);
	if (width <= 0 || height <= 0) throw new Error(`virtual screen is ${width}x${height}`);

	const screen = user32.GetDC(null);
	if (!screen) throw new Error("GetDC(NULL) failed");
	const mem = gdi32.CreateCompatibleDC(screen);
	const bmp = gdi32.CreateCompatibleBitmap(screen, width, height);
	if (!mem || !bmp) {
		if (bmp) gdi32.DeleteObject(bmp);
		if (mem) gdi32.DeleteDC(mem);
		user32.ReleaseDC(null, screen);
		throw new Error("CreateCompatibleDC/Bitmap failed");
	}
	try {
		const old = gdi32.SelectObject(mem, bmp);
		const blt = gdi32.BitBlt(mem, 0, 0, width, height, screen, x, y, (SRCCOPY | CAPTUREBLT) >>> 0);
		gdi32.SelectObject(mem, old); // GetDIBits wants the bitmap deselected
		if (!blt) throw new Error("BitBlt failed");

		// BITMAPINFOHEADER (40 bytes) + one RGBQUAD
		const bmi = new Uint8Array(44);
		const dv = new DataView(bmi.buffer);
		dv.setUint32(0, 40, true); // biSize
		dv.setInt32(4, width, true); // biWidth
		dv.setInt32(8, -height, true); // biHeight < 0: top-down rows
		dv.setUint16(12, 1, true); // biPlanes
		dv.setUint16(14, 32, true); // biBitCount
		dv.setUint32(16, 0, true); // BI_RGB
		const rgba = new Uint8Array(width * height * 4);
		const lines = gdi32.GetDIBits(mem, bmp, 0, height, ptr(rgba), ptr(bmi), DIB_RGB_COLORS);
		if (lines !== height) throw new Error(`GetDIBits copied ${lines}/${height} lines`);
		return { rgba, width, height, origin: { x, y }, ms: performance.now() - t0 };
	} finally {
		gdi32.DeleteObject(bmp);
		gdi32.DeleteDC(mem);
		user32.ReleaseDC(null, screen);
	}
}
