// Pure logic for the capture-exclusion spike: marker detection in captured
// pixels, the verdict for each capture, rectangle maths, OS-version checks.
// No Electrobun or FFI imports, so `bun test` runs it anywhere.

export type Platform = "win32" | "darwin" | "linux";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

// The popup (the window that must be excluded) is painted solid magenta; the
// control window (a normal Glimpse window that is NOT excluded) has a solid
// green panel. Both colours are rare on real desktops, so counting them tells
// us whether each window is in a capture without a human looking at the PNG.
export const POPUP_RGB = [255, 0, 255] as const;
export const CONTROL_RGB = [0, 255, 0] as const;

export function isPopupPixel(r: number, g: number, b: number): boolean {
	return r >= 200 && g <= 70 && b >= 200;
}

export function isControlPixel(r: number, g: number, b: number): boolean {
	return g >= 200 && r <= 70 && b <= 70;
}

export interface MarkerCounts {
	total: number;
	popup: number;
	control: number;
	/** pixels that are not (near) black: a black capture means "no permission" or WDA_MONITOR */
	nonBlack: number;
}

export function countMarkers(rgba: Uint8Array, width: number, height: number): MarkerCounts {
	const total = width * height;
	if (rgba.length < total * 4) throw new Error("pixel buffer too small");
	let popup = 0;
	let control = 0;
	let nonBlack = 0;
	for (let i = 0; i < total * 4; i += 4) {
		const r = rgba[i]!;
		const g = rgba[i + 1]!;
		const b = rgba[i + 2]!;
		if (isPopupPixel(r, g, b)) popup++;
		else if (isControlPixel(r, g, b)) control++;
		if (r > 16 || g > 16 || b > 16) nonBlack++;
	}
	return { total, popup, control, nonBlack };
}

export function mergeCounts(list: MarkerCounts[]): MarkerCounts {
	return list.reduce(
		(a, c) => ({
			total: a.total + c.total,
			popup: a.popup + c.popup,
			control: a.control + c.control,
			nonBlack: a.nonBlack + c.nonBlack,
		}),
		{ total: 0, popup: 0, control: 0, nonBlack: 0 },
	);
}

export type Presence = "present" | "absent";
/** "observe": no expectation, just report (used for the open questions). */
export type Expectation = Presence | "observe" | "any";

export interface Expect {
	popup: Expectation;
	control: Expectation;
}

export type ResultKind = "PASS" | "FAIL" | "INCONCLUSIVE" | "OBSERVED";

export interface Verdict {
	result: ResultKind;
	popup: Presence;
	control: Presence;
	reason: string;
}

/**
 * Minimum marker pixels to call a window "present". The popup's magenta area is
 * ~300x150 logical px (45k px at 1x), so 500 is far above anti-aliasing noise
 * and far below a partially covered popup.
 */
export const PRESENCE_THRESHOLD = 500;

export function presence(count: number, threshold = PRESENCE_THRESHOLD): Presence {
	return count >= threshold ? "present" : "absent";
}

export function verdict(counts: MarkerCounts, expect: Expect, threshold = PRESENCE_THRESHOLD): Verdict {
	const popup = presence(counts.popup, threshold);
	const control = presence(counts.control, threshold);
	const base = `popup ${popup} (${counts.popup} px), control ${control} (${counts.control} px)`;
	if (counts.total === 0) {
		return { result: "INCONCLUSIVE", popup, control, reason: "empty capture" };
	}
	if (counts.nonBlack / counts.total < 0.01) {
		return {
			result: "INCONCLUSIVE",
			popup,
			control,
			reason: `${base}; capture is (almost) all black: missing Screen Recording permission, or the capture API failed`,
		};
	}
	if (expect.control === "present" && control === "absent") {
		return {
			result: "INCONCLUSIVE",
			popup,
			control,
			reason: `${base}; the non-excluded control window is missing too, so the capture did not see our windows at all (covered? wallpaper-only capture?)`,
		};
	}
	if (expect.control === "absent" && control === "present") {
		return { result: "FAIL", popup, control, reason: `${base}; control window expected absent` };
	}
	if (expect.popup === "observe" || expect.popup === "any") {
		return { result: "OBSERVED", popup, control, reason: base };
	}
	if (expect.popup !== popup) {
		return { result: "FAIL", popup, control, reason: `${base}; popup expected ${expect.popup}` };
	}
	return { result: "PASS", popup, control, reason: base };
}

// ---- rectangles ------------------------------------------------------------

export function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const r = Math.min(a.x + a.width, b.x + b.width);
	const btm = Math.min(a.y + a.height, b.y + b.height);
	if (r <= x || btm <= y) return null;
	return { x, y, width: r - x, height: btm - y };
}

export function inflate(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** Integer rect for Screen.captureRegion: floor origin, ceil far edge. */
export function toIntRect(r: Rect): Rect {
	const x = Math.floor(r.x);
	const y = Math.floor(r.y);
	return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

/**
 * Region "under the popup" to capture: the popup frame plus a margin, clipped
 * to the display it is on (or the first display it overlaps).
 */
export function regionAroundPopup(popup: Rect, displays: Rect[], margin = 40): Rect | null {
	const want = inflate(popup, margin);
	let best: Rect | null = null;
	let bestArea = 0;
	for (const d of displays) {
		const i = intersect(want, d);
		if (i && i.width * i.height > bestArea) {
			best = i;
			bestArea = i.width * i.height;
		}
	}
	return best ? toIntRect(best) : null;
}

// ---- Windows ---------------------------------------------------------------

export const WDA_NONE = 0x0;
export const WDA_MONITOR = 0x1;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;

export function affinityName(v: number): string {
	if (v === WDA_NONE) return "WDA_NONE";
	if (v === WDA_MONITOR) return "WDA_MONITOR";
	if (v === WDA_EXCLUDEFROMCAPTURE) return "WDA_EXCLUDEFROMCAPTURE";
	return `0x${v.toString(16)}`;
}

/** Windows 10 2004 = build 19041. Older builds treat 0x11 as WDA_MONITOR (black box). */
export const WIN_EXCLUDE_MIN_BUILD = 19041;

export function windowsSupportsExclude(build: number): boolean {
	return build >= WIN_EXCLUDE_MIN_BUILD;
}

/** What the popup should look like in a capture for a given affinity. */
export function expectedForAffinity(affinity: number, build: number): Presence {
	if (affinity === WDA_EXCLUDEFROMCAPTURE && windowsSupportsExclude(build)) return "absent";
	// WDA_MONITOR (or EXCLUDE on old builds) shows a black rectangle: magenta absent.
	if (affinity === WDA_MONITOR || affinity === WDA_EXCLUDEFROMCAPTURE) return "absent";
	return "present";
}

export const WIN32_ERRORS: Record<number, string> = {
	0: "ERROR_SUCCESS",
	5: "ERROR_ACCESS_DENIED (window not owned by this process?)",
	6: "ERROR_INVALID_HANDLE",
	8: "ERROR_NOT_ENOUGH_MEMORY",
	87: "ERROR_INVALID_PARAMETER (not a top-level window, or DWM composition off?)",
	1400: "ERROR_INVALID_WINDOW_HANDLE",
};

export function describeWin32Error(code: number): string {
	return `${code} ${WIN32_ERRORS[code] ?? ""}`.trim();
}

// ---- macOS -----------------------------------------------------------------

/** NSWindowSharingType */
export const SHARING_NONE = 0;
export const SHARING_READ_ONLY = 1;
export const SHARING_READ_WRITE = 2;

export function sharingName(v: number): string {
	return v === SHARING_NONE ? "none" : v === SHARING_READ_ONLY ? "readOnly" : v === SHARING_READ_WRITE ? "readWrite" : `?${v}`;
}

export interface MacVersion {
	major: number;
	minor: number;
	patch: number;
}

export function parseMacVersion(s: string): MacVersion | null {
	const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s.trim());
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** SCK capture modes implemented by native/macos/glimcapture.m */
export const SCK_MODE_NONE = 0;
export const SCK_MODE_EXCLUDE_APP = 1;
export const SCK_MODE_EXCLUDE_WINDOW = 2;

// ---- capture methods and their expectations -------------------------------

export type MethodId =
	| "win-gdi-bitblt"
	| "win-electrobun-region"
	| "mac-sck-exclude-window"
	| "mac-sck-exclude-app"
	| "mac-sck-no-filter"
	| "mac-cg-legacy-region";

export interface MethodInfo {
	id: MethodId;
	platform: Platform;
	label: string;
	describe: string;
}

export const METHODS: MethodInfo[] = [
	{
		id: "win-gdi-bitblt",
		platform: "win32",
		label: "GDI BitBlt, all monitors",
		describe: "BitBlt(SRCCOPY|CAPTUREBLT) of the whole virtual screen via bun:ffi (what Glimpse's GDI fallback would do)",
	},
	{
		id: "win-electrobun-region",
		platform: "win32",
		label: "Electrobun Screen.captureRegion, popup area",
		describe: "Electrobun's built-in capture (GDI GetPixel per pixel) of the popup rect + 40 px",
	},
	{
		id: "mac-sck-exclude-window",
		platform: "darwin",
		label: "SCK, exclude popup window",
		describe: "SCScreenshotManager + SCContentFilter(display, excludingWindows: [popup SCWindow]) per display (Glimpse's intended path)",
	},
	{
		id: "mac-sck-exclude-app",
		platform: "darwin",
		label: "SCK, exclude own app",
		describe: "SCContentFilter(display, excludingApplications: [this process]) per display; hides the control window too",
	},
	{
		id: "mac-sck-no-filter",
		platform: "darwin",
		label: "SCK, no exclusion",
		describe: "SCContentFilter(display, excludingWindows: []) per display: does sharingType alone hide the popup from SCK?",
	},
	{
		id: "mac-cg-legacy-region",
		platform: "darwin",
		label: "Electrobun Screen.captureRegion (CGWindowListCreateImage), popup area",
		describe: "Electrobun's built-in capture, which is the legacy CoreGraphics API: does it honour sharingType?",
	},
];

export interface ExclusionState {
	platform: Platform;
	/** Windows: current display affinity of the popup */
	affinity?: number;
	/** Windows build number */
	winBuild?: number;
	/** macOS: current sharingType of the popup */
	sharingType?: number;
}

export function expectationFor(method: MethodId, s: ExclusionState): Expect {
	switch (method) {
		case "win-gdi-bitblt":
		case "win-electrobun-region":
			return {
				popup: expectedForAffinity(s.affinity ?? WDA_NONE, s.winBuild ?? 0),
				control: method === "win-gdi-bitblt" ? "present" : "any",
			};
		case "mac-sck-exclude-window":
			return { popup: "absent", control: "present" };
		case "mac-sck-exclude-app":
			return { popup: "absent", control: "absent" };
		case "mac-sck-no-filter":
			// Without sharingType=none the popup must show (sanity check). With it,
			// this is the open macOS 15+ question, so just report.
			return { popup: s.sharingType === SHARING_NONE ? "observe" : "present", control: "present" };
		case "mac-cg-legacy-region":
			return { popup: s.sharingType === SHARING_NONE ? "observe" : "present", control: "any" };
	}
}

export function captureFileName(method: MethodId, when: Date, suffix = ""): string {
	const stamp = when.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
	return `${stamp}_${method}${suffix ? "_" + suffix : ""}.png`;
}
