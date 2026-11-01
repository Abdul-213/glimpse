// GLIM-16 spike entry point.
//
// Opens two windows:
//   * a normal "control" window with a big green panel (NOT excluded), and
//   * an always-on-top magenta popup over that panel, excluded from capture at
//     the OS level (Windows: WDA_EXCLUDEFROMCAPTURE; macOS: sharingType=.none
//     for third-party captures, plus SCContentFilter exclusion in our own).
// Each "Capture" button grabs the screen (or the region under the popup) with
// one capture API, saves a PNG, and counts magenta/green pixels to report
// PASS / FAIL / INCONCLUSIVE / OBSERVED automatically.
import { BrowserWindow, Screen, Utils } from "electrobun/main";
import type { Pointer } from "bun:ffi";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExclusionState,
	type MethodId,
	type Platform,
	type Rect,
	type Verdict,
	METHODS,
	SCK_MODE_EXCLUDE_APP,
	SCK_MODE_EXCLUDE_WINDOW,
	SCK_MODE_NONE,
	SHARING_NONE,
	SHARING_READ_ONLY,
	WDA_EXCLUDEFROMCAPTURE,
	WDA_MONITOR,
	WDA_NONE,
	affinityName,
	captureFileName,
	countMarkers,
	expectationFor,
	mergeCounts,
	regionAroundPopup,
	sharingName,
	verdict,
	windowsSupportsExclude,
} from "../shared/analysis";
import { bgraToRgbaOpaque, encodePng } from "../shared/png";
import { CONTROL_HTML, POPUP_HTML } from "./html";
import { MacCapture } from "./macos";
import * as win32mod from "./win32";

const platform = process.platform as Platform;
const OUT_DIR = process.env.GLIM_CAPTURE_DIR ?? join(homedir(), "glimpse-capture-spike");
mkdirSync(OUT_DIR, { recursive: true });
const LOG_PATH = join(OUT_DIR, "spike.log");
const startExcluded = (process.env.GLIM_EXCLUSION ?? "on") !== "off";
const transparentPopup = process.env.GLIM_POPUP_TRANSPARENT === "1";

function log(line: string) {
	const full = `${new Date().toISOString()} pid=${process.pid} ${line}`;
	console.log(`[spike] ${full}`);
	try {
		appendFileSync(LOG_PATH, full + "\n");
	} catch {
		// logging must never break the spike
	}
}

// ---- platform backends ------------------------------------------------------

let win32: typeof win32mod | null = null;
let mac: MacCapture | null = null;
let macError: string | null = null;
let winBuild = 0;
let osVersion = "";

if (platform === "win32") {
	win32 = win32mod;
	const v = win32.windowsVersion();
	winBuild = v.build;
	osVersion = `Windows ${v.major}.${v.minor} build ${v.build}`;
} else if (platform === "darwin") {
	try {
		mac = new MacCapture();
		osVersion = `macOS ${mac.osVersion()}`;
	} catch (err) {
		macError = String(err instanceof Error ? err.message : err);
		osVersion = "macOS (dylib missing)";
	}
} else {
	osVersion = `${platform} (not a Glimpse target; UI only, no exclusion)`;
}

// ---- windows --------------------------------------------------------------------

const CONTROL_FRAME = { x: 120, y: 80, width: 780, height: 860 };
const POPUP_SIZE = { width: 340, height: 160 };

function popupHomeFrame(): Rect {
	// Centre the popup over the control window's green panel (250 px tall,
	// below the title bar).
	const f = control.getFrame();
	return {
		x: Math.round(f.x + (f.width - POPUP_SIZE.width) / 2),
		y: Math.round(f.y + 70),
		...POPUP_SIZE,
	};
}

const control = new BrowserWindow({
	title: "Glimpse capture-exclusion spike (control window, NOT excluded)",
	html: CONTROL_HTML,
	frame: CONTROL_FRAME,
});

// Created hidden; exclusion is applied before the first show so the popup is
// never in a captured frame (product pattern: create hidden -> exclude -> show).
let popup: BrowserWindow = createPopup();

function createPopup(): BrowserWindow {
	const w = new BrowserWindow({
		hidden: true,
		title: "Glimpse popup (excluded)",
		html: POPUP_HTML,
		frame: popupHomeFrame(),
		titleBarStyle: "hidden",
		transparent: transparentPopup,
		activate: false,
	});
	w.setAlwaysOnTop(true);
	return w;
}

function popupPtr(): Pointer | null {
	return popup.ptr;
}

// ---- exclusion state -----------------------------------------------------------

let affinity = WDA_NONE; // Windows
let sharing = -1; // macOS NSWindowSharingType read back
let lastExclusionDetail = "";

function setAffinity(value: number) {
	const p = popupPtr();
	if (!win32 || !p) return;
	const r = win32.setDisplayAffinity(p, value);
	affinity = r.readBack ?? (r.ok ? value : affinity);
	lastExclusionDetail = r.detail;
	log(`affinity -> ${affinityName(value)}: ${r.detail}`);
}

function setSharing(value: number) {
	const p = popupPtr();
	if (!mac || !p) return;
	const back = mac.setSharing(p, value);
	sharing = back;
	lastExclusionDetail = `sharingType := ${sharingName(value)} -> reads back ${sharingName(back)}`;
	log(lastExclusionDetail);
}

function applyInitialExclusion() {
	if (platform === "win32") setAffinity(startExcluded ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
	if (platform === "darwin") setSharing(startExcluded ? SHARING_NONE : SHARING_READ_ONLY);
}

function exclusionState(): ExclusionState {
	return { platform, affinity, winBuild, sharingType: sharing };
}

function stateLine(): string {
	if (platform === "win32") {
		const sup = windowsSupportsExclude(winBuild) ? "" : " [build < 19041: EXCLUDE acts like MONITOR]";
		return `popup affinity ${affinityName(affinity)}${sup}`;
	}
	if (platform === "darwin") {
		return mac
			? `popup sharingType ${sharingName(sharing)}; Screen Recording permission: ${mac.preflight() ? "granted" : "NOT granted"}`
			: `dylib missing: ${macError}`;
	}
	return "no exclusion on this OS";
}

// ---- captures ----------------------------------------------------------------------

interface ResultRow {
	result: Verdict["result"];
	text: string;
}
const results: ResultRow[] = [];
let lastSckInfo = "";

function savePng(name: string, rgba: Uint8Array, w: number, h: number): string {
	const path = join(OUT_DIR, name);
	writeFileSync(path, encodePng(rgba, w, h));
	return path;
}

function record(method: MethodId, v: Verdict, extra: string) {
	const text = `${new Date().toISOString().slice(11, 19)} ${method} [${stateLine()}]: ${v.reason}. ${extra}`;
	results.unshift({ result: v.result, text });
	log(`${v.result} ${text}`);
}

function failRow(method: MethodId, why: string) {
	const text = `${new Date().toISOString().slice(11, 19)} ${method}: ${why}`;
	results.unshift({ result: "INCONCLUSIVE", text });
	log(`ERROR ${text}`);
}

function captureOnce(method: MethodId) {
	const when = new Date();
	const expect = expectationFor(method, exclusionState());
	try {
		if (method === "win-gdi-bitblt") {
			if (!win32) throw new Error("Windows only");
			const cap = win32.captureVirtualScreenBitBlt();
			bgraToRgbaOpaque(cap.rgba);
			const counts = countMarkers(cap.rgba, cap.width, cap.height);
			const file = savePng(captureFileName(method, when), cap.rgba, cap.width, cap.height);
			record(method, verdict(counts, expect), `${cap.width}x${cap.height} at (${cap.origin.x},${cap.origin.y}), ${cap.ms.toFixed(0)} ms -> ${file}`);
			return;
		}
		if (method === "win-electrobun-region" || method === "mac-cg-legacy-region") {
			const displays = Screen.getAllDisplays().map((d) => d.bounds);
			const region = regionAroundPopup(popup.getFrame(), displays);
			if (!region) throw new Error(`popup ${JSON.stringify(popup.getFrame())} is not on any display`);
			const t0 = performance.now();
			const rgba = Screen.captureRegion(region);
			const ms = performance.now() - t0;
			if (!rgba) throw new Error(`Screen.captureRegion(${JSON.stringify(region)}) returned null (permission?)`);
			const counts = countMarkers(rgba, region.width, region.height);
			const file = savePng(captureFileName(method, when), rgba, region.width, region.height);
			record(method, verdict(counts, expect), `region ${JSON.stringify(region)}, ${ms.toFixed(0)} ms -> ${file}`);
			return;
		}
		if (method.startsWith("mac-sck-")) {
			if (!mac) throw new Error(macError ?? "macOS only");
			const p = popupPtr();
			const windowNumber = p ? mac.windowNumber(p) : 0;
			const mode =
				method === "mac-sck-exclude-window"
					? SCK_MODE_EXCLUDE_WINDOW
					: method === "mac-sck-exclude-app"
						? SCK_MODE_EXCLUDE_APP
						: SCK_MODE_NONE;
			const prefix = join(OUT_DIR, captureFileName(method, when).replace(/\.png$/, ""));
			const rep = mac.capture(mode, windowNumber, prefix);
			lastSckInfo =
				`SCK (${method}): ownAppFound=${rep.ownAppFound} bundle=${rep.ownBundleID} popupWindowNumber=${windowNumber} ` +
				`popupInShareableContent=${rep.excludedWindowFound} ownWindows=${JSON.stringify(rep.ownWindows?.map((w) => ({ id: w.windowID, title: w.title, layer: w.layer })))}`;
			log(lastSckInfo);
			if (!rep.ok || !rep.displays?.length) throw new Error(rep.error ?? `no displays captured; errors=${JSON.stringify(rep.errors)} status=${rep.status}`);
			const perDisplay = rep.displays.filter((d) => d.rgba).map((d) => {
				const c = countMarkers(d.rgba!, d.width, d.height);
				const file = savePng(captureFileName(method, when, `display${d.displayID}`), d.rgba!, d.width, d.height);
				return { c, text: `display ${d.displayID} ${d.width}x${d.height}@${d.scale}x ${d.ms.toFixed(0)} ms magenta=${c.popup} green=${c.control} -> ${file}` };
			});
			const counts = mergeCounts(perDisplay.map((x) => x.c));
			const note =
				mode === SCK_MODE_EXCLUDE_WINDOW && !rep.excludedWindowFound
					? "WARNING: popup window not found in SCShareableContent, so nothing was excluded. "
					: "";
			record(method, verdict(counts, expect), `${note}${perDisplay.map((x) => x.text).join("; ")}${rep.errors?.length ? " errors=" + JSON.stringify(rep.errors) : ""}`);
			return;
		}
		throw new Error(`method ${method} not available on ${platform}`);
	} catch (err) {
		failRow(method, String(err instanceof Error ? err.message : err));
	}
}

function methodsHere() {
	return METHODS.filter((m) => m.platform === platform);
}

function captureAll() {
	for (const m of methodsHere()) captureOnce(m.id);
	refreshUi();
}

// ---- UI ------------------------------------------------------------------------------

let displayIndex = 0;

function diagnostics(): string[] {
	const p = popupPtr();
	const out = [
		`${osVersion}; platform=${platform}; pid=${process.pid}; Bun ${Bun.version}`,
		`captures + log: ${OUT_DIR}`,
		`popup BrowserWindow.ptr = ${p} (HWND on Windows, NSWindow* on macOS)`,
		`popup frame (Electrobun logical) = ${JSON.stringify(popup.getFrame())}; alwaysOnTop=${popup.isAlwaysOnTop()}; transparent=${transparentPopup}`,
		`displays: ${JSON.stringify(Screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor, primary: d.isPrimary })))}`,
		`last exclusion call: ${lastExclusionDetail}`,
	];
	if (win32 && p) {
		const info = win32.inspectHwnd(p);
		out.push(
			`HWND top-level=${info.isTopLevel} (GA_ROOT=${info.root}) ownedByThisProcess=${info.ownedByUs} rect(physical)=${JSON.stringify(info.rect)}`,
			`GetWindowDisplayAffinity = ${affinityName(win32.getDisplayAffinity(p) ?? -1)}; thread DPI awareness = ${win32.dpiAwareness()}`,
			`WDA_EXCLUDEFROMCAPTURE supported (build >= 19041): ${windowsSupportsExclude(winBuild)}`,
		);
	}
	if (mac && p) {
		out.push(
			`dylib: ${mac.path}`,
			`NSWindow windowNumber=${mac.windowNumber(p)} level=${mac.windowLevel(p)} sharingType=${sharingName(mac.getSharing(p))}`,
			`CGPreflightScreenCaptureAccess = ${mac.preflight()}`,
		);
		if (lastSckInfo) out.push(lastSckInfo);
	}
	if (macError) out.push(`macOS dylib error: ${macError}`);
	return out;
}

function toggles(): { action: string; label: string; arg?: string }[] {
	if (platform === "win32") {
		return [
			{ action: "affinity", label: "Popup: WDA_EXCLUDEFROMCAPTURE", arg: String(WDA_EXCLUDEFROMCAPTURE) },
			{ action: "affinity", label: "Popup: WDA_MONITOR (black box)", arg: String(WDA_MONITOR) },
			{ action: "affinity", label: "Popup: WDA_NONE (not excluded)", arg: String(WDA_NONE) },
			{ action: "recreate", label: "Recreate popup" },
		];
	}
	if (platform === "darwin") {
		return [
			{ action: "sharing", label: "Popup sharingType = none", arg: String(SHARING_NONE) },
			{ action: "sharing", label: "Popup sharingType = readOnly", arg: String(SHARING_READ_ONLY) },
			{ action: "permission", label: "Request Screen Recording permission" },
			{ action: "settings", label: "Open Screen Recording settings" },
			{ action: "recreate", label: "Recreate popup" },
		];
	}
	return [];
}

function refreshUi() {
	const s = {
		state: stateLine(),
		dir: OUT_DIR,
		toggles: toggles(),
		methods: methodsHere().map((m) => ({ id: m.id, label: m.label })),
		results: results.slice(0, 60),
		diag: diagnostics(),
	};
	control.webview.executeJavascript(`window.__glim && window.__glim(${JSON.stringify(s)})`);
	popup.webview.executeJavascript(`window.__glimPopup && window.__glimPopup(${JSON.stringify(stateLine())})`);
}

function onAction(action: string, arg?: string) {
	log(`ui action ${action}${arg !== undefined ? " " + arg : ""}`);
	switch (action) {
		case "ready":
			break;
		case "affinity":
			setAffinity(Number(arg));
			break;
		case "sharing":
			setSharing(Number(arg));
			break;
		case "permission":
			log(`CGRequestScreenCaptureAccess -> ${mac?.request() ?? Utils.screenCapture.requestAccess()}`);
			break;
		case "settings":
			Utils.screenCapture.openSettings();
			break;
		case "recreate": {
			const keepAffinity = affinity;
			const keepSharing = sharing;
			popup.close();
			popup = createPopup();
			if (platform === "win32") setAffinity(keepAffinity);
			if (platform === "darwin" && keepSharing >= 0) setSharing(keepSharing);
			popup.showInactive();
			break;
		}
		case "capture":
			captureOnce(arg as MethodId);
			break;
		case "capture-all":
			captureAll();
			break;
		case "capture-all-delay":
			log("capturing all in 5 s");
			setTimeout(captureAll, 5000);
			break;
		case "popup-move": {
			const displays = Screen.getAllDisplays();
			if (displays.length) {
				displayIndex = (displayIndex + 1) % displays.length;
				const wa = displays[displayIndex]!.workArea;
				popup.setPosition(
					Math.round(wa.x + (wa.width - POPUP_SIZE.width) / 2),
					Math.round(wa.y + (wa.height - POPUP_SIZE.height) / 2),
				);
				log(`popup moved to display ${displays[displayIndex]!.id}`);
			}
			break;
		}
		case "popup-reset": {
			const f = popupHomeFrame();
			popup.setPosition(f.x, f.y);
			break;
		}
		case "open-folder":
			Utils.openPath(OUT_DIR);
			break;
	}
	refreshUi();
}

control.webview.on("dom-ready", () => refreshUi());
// "host-message" is emitted per webview but missing from BrowserView.on's typed names.
(control.webview.on as (name: string, h: (e: unknown) => void) => void)("host-message", (e: unknown) => {
	const detail = (e as { data?: { detail?: unknown } }).data?.detail as { action?: string; arg?: string } | undefined;
	if (detail?.action) onAction(detail.action, detail.arg);
});

// ---- start --------------------------------------------------------------------------

log(`---- spike start: ${osVersion}; exclusion at start: ${startExcluded ? "on" : "off"}; transparent popup: ${transparentPopup}`);
applyInitialExclusion();
popup.showInactive();
if (platform === "darwin" && mac && !mac.preflight()) {
	log("Screen Recording permission not granted yet; requesting");
	mac.request();
}
for (const d of diagnostics()) log(`diag: ${d}`);
refreshUi();
