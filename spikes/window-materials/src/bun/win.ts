// Windows: DWM materials, corners, cloaking and system settings through bun:ffi
// on the HWND that Electrobun exposes as BrowserWindow.ptr. No native code.
//
// Threading: these run on Bun's worker thread, not on Electrobun's UI thread.
//   * DwmSetWindowAttribute / DwmExtendFrameIntoClientArea talk to DWM, not to
//     the window procedure, so they don't need the owner thread.
//   * SetWindowLongPtrW(GWL_EXSTYLE) on a same-process window from another
//     thread is allowed. SetWindowPos uses SWP_ASYNCWINDOWPOS so we never block
//     on the UI thread.
//   * We never subclass the window (a WNDPROC would have to run synchronously on
//     the UI thread; bun:ffi JSCallbacks run on the worker). So no
//     WM_NCCALCSIZE / WM_NCHITTEST / WM_SETTINGCHANGE handling: settings are polled.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import {
	ACCENT,
	compositionAttribData,
	accentPolicy,
	DWMSBT,
	DWMWA,
	DWMWA_COLOR_DEFAULT,
	DWMWA_COLOR_NONE,
	DWMWCP,
	margins,
	WCA_ACCENT_POLICY,
	windowsCaps,
	type WinMaterial,
	type WindowsCaps,
} from "../shared/model";

const GWL_EXSTYLE = -20;
const GWL_STYLE = -16;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_POPUP = 0x80000000;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SWP_ASYNCWINDOWPOS = 0x4000;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
// HKEY_CURRENT_USER is ((HKEY)(ULONG_PTR)((LONG)0x80000001)): sign-extended on x64.
const HKCU = -2147483647;
const RRF_RT_REG_DWORD = 0x00000010;

function open() {
	const dwm = dlopen("dwmapi.dll", {
		DwmSetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		DwmGetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		DwmExtendFrameIntoClientArea: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		DwmFlush: { args: [], returns: FFIType.i32 },
	});
	const user32 = dlopen("user32.dll", {
		GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
		SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
		SetWindowPos: {
			args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
			returns: FFIType.i32,
		},
		ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetForegroundWindow: { args: [], returns: FFIType.ptr },
		GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetDpiForWindow: { args: [FFIType.ptr], returns: FFIType.u32 },
		SetWindowCompositionAttribute: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const advapi = dlopen("advapi32.dll", {
		RegGetValueW: {
			args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
	});
	const ntdll = dlopen("ntdll.dll", {
		RtlGetVersion: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const kernel32 = dlopen("kernel32.dll", {
		SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	return { dwm: dwm.symbols, user32: user32.symbols, advapi: advapi.symbols, ntdll: ntdll.symbols, kernel32: kernel32.symbols };
}

let lib: ReturnType<typeof open> | null = null;
function w() {
	if (!lib) lib = open();
	return lib;
}

function wide(s: string): Buffer {
	return Buffer.from(`${s}\0`, "utf16le");
}

function hex(hr: number): string {
	return `0x${(hr >>> 0).toString(16).padStart(8, "0")}`;
}

function setDword(hwnd: Pointer, attr: number, value: number): string {
	const v = new Uint32Array([value >>> 0]);
	return hex(w().dwm.DwmSetWindowAttribute(hwnd, attr, v, 4));
}

function getDword(hwnd: Pointer, attr: number): number | string {
	const v = new Uint32Array(1);
	const hr = w().dwm.DwmGetWindowAttribute(hwnd, attr, v, 4);
	return hr === 0 ? v[0]! : `err ${hex(hr)}`;
}

/**
 * Must run before the first WebView2 is created: WebView2 reads it when the
 * controller is created and uses it as the initial background instead of white.
 * Electrobun sets DefaultBackgroundColor = transparent only after the
 * controller exists, so without this a first-show white flash is possible.
 */
export function setWebView2TransparentDefault(): boolean {
	return w().kernel32.SetEnvironmentVariableW(wide("WEBVIEW2_DEFAULT_BACKGROUND_COLOR"), wide("0")) !== 0;
}

export function windowsBuild(): { major: number; minor: number; build: number } {
	// OSVERSIONINFOW is 276 bytes: size, major, minor, build, platform, WCHAR[128].
	const info = new Uint32Array(69);
	info[0] = 276;
	w().ntdll.RtlGetVersion(info);
	return { major: info[1]!, minor: info[2]!, build: info[3]! };
}

export function caps(): WindowsCaps {
	return windowsCaps(windowsBuild().build);
}

function readPersonalizeDword(name: string): number | null {
	const data = new Uint32Array(1);
	const size = new Uint32Array([4]);
	const rc = w().advapi.RegGetValueW(
		HKCU,
		wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
		wide(name),
		RRF_RT_REG_DWORD,
		null,
		data,
		size,
	);
	return rc === 0 ? data[0]! : null;
}

/** Settings > Personalization > Colors > "Transparency effects". Missing value = on. */
export function transparencyEffectsEnabled(): boolean {
	return readPersonalizeDword("EnableTransparency") !== 0;
}

/** Settings > Personalization > Colors > "Choose your app mode". Missing value = light. */
export function systemAppsDark(): boolean {
	return readPersonalizeDword("AppsUseLightTheme") === 0;
}

function exFlags(ex: number): string[] {
	const names: [number, string][] = [
		[WS_EX_TOPMOST, "TOPMOST"],
		[WS_EX_TOOLWINDOW, "TOOLWINDOW"],
		[WS_EX_APPWINDOW, "APPWINDOW"],
		[WS_EX_LAYERED, "LAYERED"],
		[WS_EX_NOREDIRECTIONBITMAP, "NOREDIRECTIONBITMAP"],
		[WS_EX_NOACTIVATE, "NOACTIVATE"],
	];
	return names.filter(([b]) => (ex & b) !== 0).map(([, n]) => n);
}

function styleFlags(style: number): string[] {
	const names: [number, string][] = [
		[WS_POPUP, "POPUP"],
		[WS_CAPTION, "CAPTION"],
		[WS_THICKFRAME, "THICKFRAME"],
	];
	return names.filter(([b]) => (style & b) >>> 0 !== 0).map(([, n]) => n);
}

function rect(fn: "GetWindowRect" | "GetClientRect", hwnd: Pointer) {
	const r = new Int32Array(4);
	w().user32[fn](hwnd, r);
	return { x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]! };
}

export function describeWindow(hwnd: Pointer): Record<string, unknown> {
	const u = w().user32;
	const ex = Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	const style = Number(u.GetWindowLongPtrW(hwnd, GWL_STYLE));
	return {
		exStyle: exFlags(ex),
		style: styleFlags(style),
		visible: u.IsWindowVisible(hwnd) !== 0,
		cloaked: getDword(hwnd, DWMWA.CLOAKED),
		backdrop: getDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE),
		corner: getDword(hwnd, DWMWA.WINDOW_CORNER_PREFERENCE),
		dpi: u.GetDpiForWindow(hwnd),
		windowRect: rect("GetWindowRect", hwnd),
		clientRect: rect("GetClientRect", hwnd),
	};
}

/**
 * One-time popup setup: out of the taskbar and Alt+Tab, never activated by a
 * click (WS_EX_NOACTIVATE), and the whole client area is "sheet of glass" so
 * the system backdrop shows wherever the webview is transparent.
 */
export function installPopup(hwnd: Pointer, opts: { noActivate: boolean; extendFrame: boolean }): Record<string, unknown> {
	const u = w().user32;
	const before = Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	let after = (before & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
	if (opts.noActivate) after |= WS_EX_NOACTIVATE;
	u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, after);
	const extend = opts.extendFrame ? hex(w().dwm.DwmExtendFrameIntoClientArea(hwnd, margins(-1))) : "skipped";
	u.SetWindowPos(
		hwnd,
		HWND_TOPMOST,
		0,
		0,
		0,
		0,
		SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS,
	);
	return {
		exStyleBefore: exFlags(before),
		exStyleRequested: exFlags(after),
		extendFrameIntoClientArea: extend,
		window: describeWindow(hwnd),
	};
}

export function setDark(hwnd: Pointer, dark: boolean): string {
	return setDword(hwnd, DWMWA.USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0);
}

export type WinCorner = "round" | "roundsmall" | "donotround" | "default";
export function setCorner(hwnd: Pointer, corner: WinCorner): string {
	const v = { round: DWMWCP.ROUND, roundsmall: DWMWCP.ROUNDSMALL, donotround: DWMWCP.DONOTROUND, default: DWMWCP.DEFAULT }[corner];
	return setDword(hwnd, DWMWA.WINDOW_CORNER_PREFERENCE, v);
}

/** Win11's 1px DWM border; DESIGN.md wants the webview's own hairline instead. */
export function setBorder(hwnd: Pointer, none: boolean): string {
	return setDword(hwnd, DWMWA.BORDER_COLOR, none ? DWMWA_COLOR_NONE : DWMWA_COLOR_DEFAULT);
}

function setAccent(hwnd: Pointer, state: number, dark: boolean): string {
	// Gradient colour is the tint the OS paints over the blur (AABBGGRR).
	// Keep it light: the webview paints the real veil on top.
	const tint = dark ? { r: 0x26, g: 0x26, b: 0x28, a: 0x40 } : { r: 0xf5, g: 0xf5, b: 0xf7, a: 0x40 };
	const policy = accentPolicy(state, tint);
	const data = compositionAttribData(WCA_ACCENT_POLICY, ptr(policy), policy.byteLength);
	return w().user32.SetWindowCompositionAttribute(hwnd, data) !== 0 ? "ok" : "failed";
}

/**
 * Applies a material. Always clears the other mechanism first so switching is
 * clean. Returns the HRESULTs for the log.
 */
export function setMaterial(hwnd: Pointer, material: WinMaterial | "off", build: number, dark: boolean): Record<string, string> {
	const c = windowsCaps(build);
	const out: Record<string, string> = {};
	if (c.accentAcrylic) out.accentReset = setAccent(hwnd, ACCENT.DISABLED, dark);
	if (c.systemBackdrop) out.backdropReset = setDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE, DWMSBT.NONE);
	if (c.legacyMica) out.micaReset = setDword(hwnd, DWMWA.MICA_EFFECT, 0);
	switch (material) {
		case "acrylic":
			out.backdrop = setDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE, DWMSBT.TRANSIENTWINDOW);
			break;
		case "mica":
			out.backdrop = c.systemBackdrop
				? setDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE, DWMSBT.MAINWINDOW)
				: setDword(hwnd, DWMWA.MICA_EFFECT, 1);
			break;
		case "tabbed":
			out.backdrop = setDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE, DWMSBT.TABBEDWINDOW);
			break;
		case "auto":
			out.backdrop = setDword(hwnd, DWMWA.SYSTEMBACKDROP_TYPE, DWMSBT.AUTO);
			break;
		case "accent-acrylic":
			out.accent = setAccent(hwnd, ACCENT.ENABLE_ACRYLICBLURBEHIND, dark);
			break;
		case "accent-blur":
			out.accent = setAccent(hwnd, ACCENT.ENABLE_BLURBEHIND, dark);
			break;
		default:
			break;
	}
	return out;
}

/** Show without activating (the same calls Electrobun's showInactive makes, minus the UI-thread hop). */
export function showNoActivate(hwnd: Pointer): void {
	const u = w().user32;
	u.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
	u.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

export function hide(hwnd: Pointer): void {
	w().user32.ShowWindow(hwnd, SW_HIDE);
}

/** DWM cloaking: the window stays "shown" for Chromium (keeps rendering) but DWM doesn't draw it. */
export function cloak(hwnd: Pointer, on: boolean): string {
	return setDword(hwnd, DWMWA.CLOAK, on ? 1 : 0);
}

/** Blocks until the next DWM composition pass. */
export function dwmFlush(): number {
	return w().dwm.DwmFlush();
}

export function foreground(): { hwnd: number; pid: number; title: string } {
	const u = w().user32;
	const h = u.GetForegroundWindow() as Pointer | null;
	if (!h) return { hwnd: 0, pid: 0, title: "" };
	const pid = new Uint32Array(1);
	u.GetWindowThreadProcessId(h, pid);
	const buf = new Uint16Array(256);
	const n = u.GetWindowTextW(h, buf, 256);
	return { hwnd: Number(h), pid: pid[0]!, title: Buffer.from(buf.buffer, 0, n * 2).toString("utf16le") };
}
