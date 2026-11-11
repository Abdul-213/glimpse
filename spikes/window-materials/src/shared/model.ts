// Pure logic shared by the Bun process, the views and the unit tests.
// No Electrobun or bun:ffi imports here.

export type OsKind = "macos" | "windows" | "other";
export type ThemeMode = "system" | "light" | "dark";
/** "auto" follows the OS setting; "on" simulates reduce transparency; "off" ignores it. */
export type ReduceTransparencyMode = "auto" | "on" | "off";

// ---------------------------------------------------------------------------
// DESIGN.md tokens used by the popup (GLIM-27 proposal, provisional).

export const TOKENS = {
	light: {
		surfacePopup: "#F5F5F7E6",
		surfacePopupSolid: "#F5F5F7",
		textPrimary: "#1D1D1F",
		textSecondary: "#55555C",
		borderHairline: "#0000001F",
		divider: "#00000014",
		accent: "#0A63C9",
	},
	dark: {
		surfacePopup: "#262628E6",
		surfacePopupSolid: "#262628",
		textPrimary: "#F4F4F6",
		textSecondary: "#B6B6BE",
		borderHairline: "#FFFFFF1F",
		divider: "#FFFFFF14",
		accent: "#2A6FD9",
	},
	radius: { popupMac: 12, popupWin: 8, controlMac: 6, controlWin: 4 },
} as const;

// ---------------------------------------------------------------------------
// Windows feature detection by build number.

export interface WindowsCaps {
	build: number;
	isWin11: boolean;
	/** DWMWA_SYSTEMBACKDROP_TYPE (38): Windows 11 22H2, build 22621+. */
	systemBackdrop: boolean;
	/** Undocumented DWMWA_MICA_EFFECT (1029): Windows 11 21H2 (22000-22620) only. */
	legacyMica: boolean;
	/** DWMWA_WINDOW_CORNER_PREFERENCE (33): Windows 11 (22000+). */
	cornerPreference: boolean;
	/** WDA/ACCENT tricks exist on Windows 10 1803+ (17134), undocumented. */
	accentAcrylic: boolean;
}

export function windowsCaps(build: number): WindowsCaps {
	return {
		build,
		isWin11: build >= 22000,
		systemBackdrop: build >= 22621,
		legacyMica: build >= 22000 && build < 22621,
		cornerPreference: build >= 22000,
		accentAcrylic: build >= 17134,
	};
}

// DWM constants (dwmapi.h, Windows SDK 10.0.22621).
export const DWMWA = {
	USE_IMMERSIVE_DARK_MODE: 20,
	WINDOW_CORNER_PREFERENCE: 33,
	BORDER_COLOR: 34,
	SYSTEMBACKDROP_TYPE: 38,
	CLOAK: 13,
	CLOAKED: 14,
	MICA_EFFECT: 1029,
} as const;

export const DWMSBT = { AUTO: 0, NONE: 1, MAINWINDOW: 2, TRANSIENTWINDOW: 3, TABBEDWINDOW: 4 } as const;
export const DWMWCP = { DEFAULT: 0, DONOTROUND: 1, ROUND: 2, ROUNDSMALL: 3 } as const;
export const DWMWA_COLOR_NONE = 0xfffffffe;
export const DWMWA_COLOR_DEFAULT = 0xffffffff;

// ---------------------------------------------------------------------------
// Materials offered per OS.

export type WinMaterial = "none" | "acrylic" | "mica" | "tabbed" | "auto" | "accent-acrylic" | "accent-blur";
export type MacMaterial =
	| "none"
	| "popover"
	| "hudWindow"
	| "menu"
	| "sidebar"
	| "windowBackground"
	| "underWindowBackground"
	| "sheet"
	| "glass";

/** NSVisualEffectMaterial raw values (AppKit NSVisualEffectView.h); glass is our sentinel. */
export const MAC_MATERIAL_CODE: Record<MacMaterial, number> = {
	none: -1,
	menu: 5,
	popover: 6,
	sidebar: 7,
	sheet: 11,
	windowBackground: 12,
	hudWindow: 13,
	underWindowBackground: 21,
	glass: 1000,
};

export const WIN_MATERIALS: WinMaterial[] = ["acrylic", "mica", "tabbed", "auto", "none", "accent-acrylic", "accent-blur"];
export const MAC_MATERIALS: MacMaterial[] = [
	"popover",
	"hudWindow",
	"menu",
	"sidebar",
	"windowBackground",
	"underWindowBackground",
	"sheet",
	"glass",
	"none",
];

/** DESIGN.md defaults: popover on macOS, Acrylic (transient) on Windows 11. */
export function defaultMaterial(os: OsKind): WinMaterial | MacMaterial {
	return os === "macos" ? "popover" : "acrylic";
}

/** Can this material actually render on this OS build? */
export function materialSupported(
	os: OsKind,
	material: string,
	opts: { winBuild?: number; macGlass?: boolean } = {},
): boolean {
	if (material === "none") return true;
	if (os === "macos") return material === "glass" ? !!opts.macGlass : material in MAC_MATERIAL_CODE;
	if (os === "windows") {
		const caps = windowsCaps(opts.winBuild ?? 0);
		if (material === "accent-acrylic" || material === "accent-blur") return caps.accentAcrylic;
		if (material === "mica") return caps.systemBackdrop || caps.legacyMica;
		return caps.systemBackdrop;
	}
	return false;
}

// ---------------------------------------------------------------------------
// The surface decision: native material on/off and which veil the webview paints.

export interface SurfaceInputs {
	os: OsKind;
	/** The material the user picked in the control window. */
	material: string;
	/** Whether the OS build can draw it (materialSupported). */
	supported: boolean;
	/** OS reduce-transparency / transparency-effects-off state. */
	osReduceTransparency: boolean;
	rtMode: ReduceTransparencyMode;
}

export interface SurfaceDecision {
	/** Apply the native material. */
	nativeMaterial: boolean;
	/** "tint": surface-popup (90% veil) over the material; "solid": surface-popup-solid. */
	veil: "tint" | "solid";
	reason: string;
}

export function decideSurface(i: SurfaceInputs): SurfaceDecision {
	const reduce = i.rtMode === "on" || (i.rtMode === "auto" && i.osReduceTransparency);
	if (reduce) {
		return {
			nativeMaterial: false,
			veil: "solid",
			reason: i.rtMode === "on" ? "reduce transparency simulated" : "OS reduce transparency is on",
		};
	}
	if (i.material === "none") return { nativeMaterial: false, veil: "solid", reason: "material off" };
	if (!i.supported) return { nativeMaterial: false, veil: "solid", reason: `material ${i.material} unavailable on this OS build` };
	return { nativeMaterial: true, veil: "tint", reason: `material ${i.material}` };
}

/** Popup corner radius: 12px macOS, 8px Windows 11, square on Windows 10 (DWM can't round it). */
export function popupRadius(os: OsKind, winBuild = 0): number {
	if (os === "macos") return TOKENS.radius.popupMac;
	if (os === "windows") return windowsCaps(winBuild).cornerPreference ? TOKENS.radius.popupWin : 0;
	return TOKENS.radius.popupWin;
}

export function effectiveDark(mode: ThemeMode, systemDark: boolean): boolean {
	return mode === "dark" || (mode === "system" && systemDark);
}

// ---------------------------------------------------------------------------
// Windows 10 SetWindowCompositionAttribute (undocumented) structs.

export const ACCENT = { DISABLED: 0, ENABLE_BLURBEHIND: 3, ENABLE_ACRYLICBLURBEHIND: 4 } as const;
export const WCA_ACCENT_POLICY = 19;

/** ACCENT_POLICY { int AccentState; int AccentFlags; DWORD GradientColor (AABBGGRR); int AnimationId }. */
export function accentPolicy(state: number, rgba: { r: number; g: number; b: number; a: number }, flags = 2): Uint8Array {
	const buf = new ArrayBuffer(16);
	const v = new DataView(buf);
	v.setInt32(0, state, true);
	v.setInt32(4, flags, true);
	const abgr = ((rgba.a & 0xff) << 24) | ((rgba.b & 0xff) << 16) | ((rgba.g & 0xff) << 8) | (rgba.r & 0xff);
	v.setUint32(8, abgr >>> 0, true);
	v.setInt32(12, 0, true);
	return new Uint8Array(buf);
}

/** WINDOWCOMPOSITIONATTRIBDATA { DWORD Attrib; PVOID pvData; SIZE_T cbData } on x64: 24 bytes. */
export function compositionAttribData(attrib: number, dataPtr: number, size: number): Uint8Array {
	const buf = new ArrayBuffer(24);
	const v = new DataView(buf);
	v.setUint32(0, attrib, true);
	v.setBigUint64(8, BigInt(dataPtr), true);
	v.setBigUint64(16, BigInt(size), true);
	return new Uint8Array(buf);
}

/** MARGINS { int cxLeftWidth, cxRightWidth, cyTopHeight, cyBottomHeight }. -1 = sheet of glass. */
export function margins(all: number): Int32Array {
	return new Int32Array([all, all, all, all]);
}

// ---------------------------------------------------------------------------
// Colour maths: checks that the 90% veil keeps text legible over the worst
// backdrops (DESIGN.md "Ninety Rule"), and powers the veil-alpha experiment.

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

export function parseHex(hex: string): Rgba {
	const h = hex.replace("#", "");
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
	return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) / 255 : 1 };
}

export function over(top: Rgba, bottom: Rgba): Rgba {
	const a = top.a + bottom.a * (1 - top.a);
	if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
	const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function channel(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Worst-case contrast of `text` on `veil` (with alpha override) composited over pure white and pure black. */
export function worstCaseContrast(textHex: string, veilHex: string, veilAlpha?: number): number {
	const veil = parseHex(veilHex);
	if (veilAlpha !== undefined) veil.a = veilAlpha;
	const text = parseHex(textHex);
	const backdrops = [
		{ r: 255, g: 255, b: 255, a: 1 },
		{ r: 0, g: 0, b: 0, a: 1 },
	];
	return Math.min(...backdrops.map((bg) => contrast(over(text, over(veil, bg)), over(veil, bg))));
}

/** "#RRGGBBAA" with a new alpha. */
export function withAlpha(hex: string, alpha: number): string {
	const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
		.toString(16)
		.padStart(2, "0")
		.toUpperCase();
	return `#${hex.replace("#", "").slice(0, 6)}${a}`;
}

// ---------------------------------------------------------------------------
// Latency statistics.

export interface LatencyStats {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
	under100: number;
}

export function stats(samples: number[]): LatencyStats | null {
	const xs = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (xs.length === 0) return null;
	const q = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]!;
	const round = (x: number) => Math.round(x * 10) / 10;
	return {
		n: xs.length,
		min: round(xs[0]!),
		p50: round(q(0.5)),
		p95: round(q(0.95)),
		max: round(xs[xs.length - 1]!),
		mean: round(xs.reduce((s, x) => s + x, 0) / xs.length),
		under100: xs.filter((x) => x < 100).length,
	};
}
