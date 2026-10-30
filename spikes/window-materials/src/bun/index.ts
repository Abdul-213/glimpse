// GLIM-19 spike main process.
//
// Two windows:
//   * popup:   400 x 240, frameless, transparent, pre-created hidden. A native
//              material sits behind the transparent webview, which paints the
//              DESIGN.md veil (surface-popup at 90%) and content.
//   * control: a normal window with toggles, timings and a log.
//
// Everything is logged as JSON lines to ~/glimpse-materials-spike.log
// (%USERPROFILE%\glimpse-materials-spike.log on Windows).

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pointer } from "bun:ffi";
import { BrowserView, BrowserWindow, Screen } from "electrobun/main";
import {
	decideSurface,
	defaultMaterial,
	effectiveDark,
	MAC_MATERIAL_CODE,
	MAC_MATERIALS,
	materialSupported,
	popupRadius,
	stats,
	WIN_MATERIALS,
	windowsCaps,
	type MacMaterial,
	type OsKind,
	type ReduceTransparencyMode,
	type SurfaceDecision,
	type ThemeMode,
	type WinMaterial,
} from "../shared/model";
import type { ControlRPC, ControlStatus, PopupLook, PopupRPC } from "../shared/rpc";
import { MAC_SHOW_MODES, MacMaterial as MacNative } from "./mac";
import * as win from "./win";

const os: OsKind = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "other";
const env = (k: string, d: string) => process.env[k] ?? d;

const config = {
	winChrome: env("GLIM_WIN_CHROME", "hiddenInset") as "hiddenInset" | "hidden",
	winNoActivate: env("GLIM_WIN_NOACTIVATE", "1") === "1",
	winExtendFrame: env("GLIM_WIN_EXTEND", "1") === "1",
	macPanel: env("GLIM_MAC_PANEL", "1") === "1",
	// NSPopUpMenuWindowLevel (101): above normal and floating windows.
	macLevel: Number(env("GLIM_MAC_LEVEL", "101")),
	autoShow: env("GLIM_AUTOSHOW", "1") === "1",
};

// ---------------------------------------------------------------------------
// Logging

const logPath = join(homedir(), "glimpse-materials-spike.log");
const recent: string[] = [];

function record(type: string, data: Record<string, unknown> = {}): void {
	const line = { t: new Date().toISOString(), type, ...data };
	const json = JSON.stringify(line);
	try {
		appendFileSync(logPath, `${json}\n`);
	} catch {
		// ignore
	}
	console.log(`===== GLIMPSE_MATERIALS ${type} =====\n${JSON.stringify(data, null, 1)}`);
	recent.push(`${line.t.slice(11, 23)} ${type} ${json.length > 400 ? `${json.slice(0, 400)}…` : json}`);
	if (recent.length > 60) recent.shift();
}

// ---------------------------------------------------------------------------
// Platform natives

let mac: MacNative | null = null;
let winBuild = 0;
let macGlass = false;

if (os === "macos") {
	try {
		mac = new MacNative();
	} catch (err) {
		record("mac-dylib-missing", { error: String(err) });
	}
}
if (os === "windows") {
	try {
		winBuild = win.windowsBuild().build;
		const ok = win.setWebView2TransparentDefault();
		record("win-startup", { build: winBuild, caps: windowsCaps(winBuild), webview2DefaultBackgroundEnv: ok });
	} catch (err) {
		record("win-ffi-error", { error: String(err) });
	}
}

const WIN_SHOW_MODES = ["electrobun-showInactive", "ShowWindow-ffi", "cloak", "electrobun-show"] as const;
const showModes: readonly string[] = os === "macos" ? MAC_SHOW_MODES : WIN_SHOW_MODES;
const cornerOptions = os === "macos" ? ["mask", "layer"] : ["round", "roundsmall", "donotround", "default"];

const settings = {
	material: defaultMaterial(os) as string,
	showMode: showModes[0]!,
	corner: cornerOptions[0]!,
	theme: "system" as ThemeMode,
	rt: "auto" as ReduceTransparencyMode,
	veilAlpha: "0.9",
	winBorder: "none" as "none" | "default",
};

let osReduceTransparency = false;
let systemDark = false;
let webPrefersDark: boolean | null = null;
let webPrefersRT: boolean | null = null;
let contentSeq = 0;

function readOsSettings(): void {
	if (os === "macos" && mac) {
		const s = mac.status(null);
		osReduceTransparency = s.reduceTransparency === true;
		systemDark = s.systemDark === true;
		macGlass = s.glassAvailable === true;
	} else if (os === "windows") {
		try {
			osReduceTransparency = !win.transparencyEffectsEnabled();
			systemDark = win.systemAppsDark();
		} catch (err) {
			record("win-settings-error", { error: String(err) });
		}
	} else if (webPrefersDark !== null) {
		systemDark = webPrefersDark;
	}
}

// ---------------------------------------------------------------------------
// Popup window

const POPUP_W = 400;
const POPUP_H = 240;
let popupSize = { width: POPUP_W, height: POPUP_H };
let popupInstalled = false;
let popupVisible = false;
let cloakPrimed = false;
let displayIndex = 0;

let showSeq = 0;
interface PendingShow {
	seq: number;
	reason: string;
	t0: number;
	callMs: number;
	flushMs: number | null;
	fgBefore: Foreground | null;
	resolve?: (ms: number) => void;
}
let pending: PendingShow | null = null;
let lastShow: Record<string, unknown> | null = null;
let latency: Record<string, unknown> | null = null;
let focus: Record<string, unknown> | null = null;

const popupRpc = BrowserView.defineRPC<PopupRPC>({
	maxRequestTime: 10_000,
	handlers: {
		requests: {
			hello: (h) => {
				webPrefersDark = h.prefersDark;
				webPrefersRT = h.prefersReducedTransparency;
				record("popup-hello", { ...h });
				installPopup();
				return look();
			},
		},
		messages: {
			frame: (f) => onFrame(f.seq, f.visibility),
			media: (m) => {
				webPrefersDark = m.prefersDark;
				webPrefersRT = m.prefersReducedTransparency;
				record("popup-media", { ...m });
				pollSettings(true);
			},
			clicked: (c) => {
				const fg = foregroundInfo();
				record("popup-clicked", { what: c.what, foregroundAfterClick: fg, popupStoleFocus: fg ? fg.isUs : null });
				pushStatus();
			},
		},
	},
});

function placeOnPrimary(): { x: number; y: number } {
	const d = Screen.getPrimaryDisplay();
	const wa = d.workArea;
	return { x: Math.round(wa.x + wa.width - POPUP_W - 80), y: Math.round(wa.y + 120) };
}

const startPos = placeOnPrimary();
const popup = new BrowserWindow({
	title: "Glimpse popup (spike)",
	url: "views://popup/index.html",
	frame: { x: startPos.x, y: startPos.y, width: POPUP_W, height: POPUP_H },
	transparent: true,
	// macOS: borderless. Windows: "hiddenInset" = WS_CAPTION|WS_THICKFRAME with the
	// caption removed in WM_NCCALCSIZE, which keeps the DWM frame (shadow, rounded
	// corners, system backdrop). "hidden" = bare WS_POPUP, kept for A/B.
	titleBarStyle: os === "macos" ? "hidden" : config.winChrome,
	styleMask: {
		Borderless: os === "macos",
		Titled: false,
		Closable: false,
		Miniaturizable: false,
		Resizable: false,
	},
	hidden: true,
	activate: false,
	rpc: popupRpc,
});
record("popup-created", { id: popup.id, os, config, frame: { ...startPos, width: POPUP_W, height: POPUP_H } });

function popupPtr(): Pointer | null {
	return (popup.ptr as Pointer | null) ?? null;
}

function radius(): number {
	return popupRadius(os, winBuild);
}

function installPopup(): void {
	if (popupInstalled) return;
	const p = popupPtr();
	if (!p) {
		record("popup-install", { error: "no native pointer" });
		return;
	}
	popupInstalled = true;
	try {
		if (os === "macos" && mac) {
			const res = mac.install(p, {
				material: -1,
				radius: radius(),
				cornerMethod: 0,
				panel: config.macPanel,
				level: config.macLevel,
			});
			record("popup-install", { os, result: res });
		} else if (os === "windows") {
			popup.setAlwaysOnTop(true);
			const res = win.installPopup(p, { noActivate: config.winNoActivate, extendFrame: config.winExtendFrame });
			record("popup-install", { os, result: res });
		}
	} catch (err) {
		record("popup-install", { error: String(err) });
	}
	applyAll("install");
}

function currentSurface(): SurfaceDecision {
	return decideSurface({
		os,
		material: settings.material,
		supported: materialSupported(os, settings.material, { winBuild, macGlass }),
		osReduceTransparency,
		rtMode: settings.rt,
	});
}

function look(): PopupLook {
	const s = currentSurface();
	const dark = effectiveDark(settings.theme, systemDark);
	return {
		os: os === "windows" && !windowsCaps(winBuild).isWin11 ? "windows" : os,
		dark,
		veil: s.veil,
		veilAlpha: Number(settings.veilAlpha),
		radius: radius(),
		caption: `${s.nativeMaterial ? settings.material : "solid"} · ${s.veil === "tint" ? `veil ${Math.round(Number(settings.veilAlpha) * 100)}%` : "solid surface"} · ${dark ? "dark" : "light"}`,
		contentSeq,
	};
}

/** Applies material, corners and appearance natively, then repaints the webview. */
function applyAll(reason: string): void {
	const p = popupPtr();
	const s = currentSurface();
	const dark = effectiveDark(settings.theme, systemDark);
	const native: Record<string, unknown> = {};
	try {
		if (p && os === "macos" && mac) {
			const code = s.nativeMaterial ? MAC_MATERIAL_CODE[settings.material as MacMaterial] : -1;
			native.setMaterial = mac.setMaterial(p, code, radius(), settings.corner === "layer" ? 1 : 0);
			native.setAppearance = mac.setAppearance(p, settings.theme === "light" ? 1 : settings.theme === "dark" ? 2 : 0);
		} else if (p && os === "windows") {
			native.dark = win.setDark(p, dark);
			const caps = windowsCaps(winBuild);
			if (caps.cornerPreference) {
				native.corner = win.setCorner(p, settings.corner as win.WinCorner);
				native.border = win.setBorder(p, settings.winBorder === "none");
			}
			native.material = win.setMaterial(p, s.nativeMaterial ? (settings.material as WinMaterial) : "off", winBuild, dark);
		}
	} catch (err) {
		native.error = String(err);
	}
	const l = look();
	popupRpc.send.look(l);
	record("apply", { reason, settings: { ...settings }, surface: s, osReduceTransparency, systemDark, look: l, native });
}

// ---------------------------------------------------------------------------
// Focus checks

interface Foreground {
	pid: number;
	name: string;
	isUs: boolean;
}

function foregroundInfo(): Foreground | null {
	try {
		if (os === "macos" && mac) {
			const s = mac.status(null);
			const pid = Number(s.frontmostPid);
			return { pid, name: String(s.frontmostName ?? ""), isUs: pid === Number(s.pid) };
		}
		if (os === "windows") {
			const f = win.foreground();
			return { pid: f.pid, name: f.title, isUs: f.pid === process.pid };
		}
	} catch (err) {
		record("foreground-error", { error: String(err) });
	}
	return null;
}

// ---------------------------------------------------------------------------
// Show / hide

function nativeShow(p: Pointer): void {
	const mode = settings.showMode;
	if (mode === "electrobun-showInactive") return void popup.showInactive();
	if (mode === "electrobun-show") return void popup.show();
	if (os === "macos" && mac) {
		mac.show(p, mode === "activate" ? 1 : mode === "alpha" ? 2 : 0);
		return;
	}
	if (os === "windows") {
		if (mode === "cloak") {
			if (!cloakPrimed) {
				win.cloak(p, true);
				win.showNoActivate(p);
				cloakPrimed = true;
			}
			win.cloak(p, false);
			return;
		}
		win.showNoActivate(p);
	}
}

function nativeHide(p: Pointer): void {
	const mode = settings.showMode;
	if (mode.startsWith("electrobun-")) return void popup.hide();
	if (os === "macos" && mac) {
		mac.hide(p, mode === "alpha" ? 2 : 0);
		return;
	}
	if (os === "windows") {
		if (mode === "cloak") {
			win.cloak(p, true);
			return;
		}
		win.hide(p);
	}
}

function showPopup(reason: string, checkFocus = true): Promise<number> {
	const p = popupPtr();
	if (!p) return Promise.resolve(Number.NaN);
	const seq = ++showSeq;
	const fgBefore = checkFocus ? foregroundInfo() : null;
	const t0 = performance.now();
	nativeShow(p);
	const callMs = performance.now() - t0;
	let flushMs: number | null = null;
	if (os === "windows") {
		// Next DWM composition after the show: the earliest frame it can be on screen.
		win.dwmFlush();
		flushMs = performance.now() - t0;
	}
	popupVisible = true;
	return new Promise((resolve) => {
		pending = { seq, reason, t0, callMs, flushMs, fgBefore, resolve };
		popupRpc.send.shown({ seq });
		setTimeout(() => {
			if (pending?.seq === seq) {
				record("show-timeout", { seq, reason, note: "no frame from the webview within 2 s" });
				pending = null;
				resolve(Number.NaN);
			}
		}, 2000);
	});
}

function onFrame(seq: number, visibility: string): void {
	const pnd = pending;
	if (!pnd || pnd.seq !== seq) return;
	pending = null;
	const frameMs = performance.now() - pnd.t0;
	const nativeTiming = os === "macos" && mac ? mac.lastShowTiming() : null;
	lastShow = {
		seq,
		reason: pnd.reason,
		mode: settings.showMode,
		callMs: round(pnd.callMs),
		dwmFlushMs: pnd.flushMs === null ? null : round(pnd.flushMs),
		webFrameMs: round(frameMs),
		macNative: nativeTiming,
		visibility,
	};
	record("show", lastShow);
	pnd.resolve?.(frameMs);
	if (pnd.fgBefore) {
		const before = pnd.fgBefore;
		setTimeout(() => {
			const after = foregroundInfo();
			focus = {
				before,
				after,
				verdict: before.isUs
					? "n/a: Glimpse was frontmost before the show (use 'Show in 3 s' and click another app)"
					: after && after.pid === before.pid
						? "PASS: focus stayed with the other app"
						: "FAIL: the popup took focus",
			};
			record("focus-check", focus);
			pushStatus();
		}, 300);
	}
	pushStatus();
}

function round(x: number): number {
	return Math.round(x * 10) / 10;
}

function hidePopup(reason: string): void {
	const p = popupPtr();
	if (!p) return;
	nativeHide(p);
	popupVisible = false;
	record("hide", { reason, mode: settings.showMode });
}

async function latencyTest(n: number): Promise<void> {
	const samples: number[] = [];
	const calls: number[] = [];
	for (let i = 0; i < n; i++) {
		hidePopup("latency-test");
		await Bun.sleep(250);
		const ms = await showPopup("latency-test", false);
		samples.push(ms);
		if (lastShow && typeof lastShow.callMs === "number") calls.push(lastShow.callMs);
		await Bun.sleep(150);
	}
	latency = { mode: settings.showMode, material: settings.material, webFrame: stats(samples), call: stats(calls) };
	record("latency-test", latency);
	pushStatus();
}

// ---------------------------------------------------------------------------
// Displays

function moveToNextDisplay(): void {
	const p = popupPtr();
	displayIndex++;
	if (os === "macos" && mac && p) {
		const count = mac.moveToScreen(p, displayIndex);
		record("move-display", { index: displayIndex % Math.max(1, count), count, status: mac.status(p) });
		return;
	}
	const displays = Screen.getAllDisplays();
	const d = displays[displayIndex % displays.length]!;
	const x = Math.round(d.workArea.x + (d.workArea.width - popupSize.width) / 2);
	const y = Math.round(d.workArea.y + (d.workArea.height - popupSize.height) / 2);
	popup.setPosition(x, y);
	setTimeout(() => {
		record("move-display", {
			display: d,
			window: os === "windows" && p ? win.describeWindow(p) : popup.getFrame(),
		});
		pushStatus();
	}, 300);
}

function toggleSize(): void {
	popupSize = popupSize.width === POPUP_W ? { width: 480, height: 360 } : { width: POPUP_W, height: POPUP_H };
	const f = popup.getFrame();
	popup.setFrame(f.x, f.y, popupSize.width, popupSize.height);
	record("resize", { requested: popupSize, before: f });
}

// ---------------------------------------------------------------------------
// Settings polling (no WM_SETTINGCHANGE / NSWorkspace notifications from a worker)

function pollSettings(force = false): void {
	const before = { osReduceTransparency, systemDark };
	readOsSettings();
	if (force || before.osReduceTransparency !== osReduceTransparency || before.systemDark !== systemDark) {
		record("os-settings-changed", { before, after: { osReduceTransparency, systemDark }, webPrefersDark, webPrefersRT });
		applyAll("os-settings-changed");
		pushStatus();
	}
}

// ---------------------------------------------------------------------------
// Control window

function status(): ControlStatus {
	const p = popupPtr();
	let osDetail = os as string;
	if (os === "macos" && mac) {
		const s = mac.status(p);
		osDetail = `macOS ${s.osVersion} · glass ${s.glassAvailable ? "available" : "unavailable"} · dylib ${mac.path}`;
	} else if (os === "macos") {
		osDetail = "macOS · dylib NOT loaded (run `hutch run native:mac`)";
	} else if (os === "windows") {
		const c = windowsCaps(winBuild);
		osDetail = `Windows build ${winBuild} · ${c.isWin11 ? "Windows 11" : "Windows 10"} · backdrop ${c.systemBackdrop ? "yes" : c.legacyMica ? "legacy mica only" : "no"} · chrome ${config.winChrome}`;
	}
	return {
		os,
		osDetail,
		materials: os === "macos" ? MAC_MATERIALS : WIN_MATERIALS,
		showModes: [...showModes],
		cornerOptions,
		settings: { ...settings },
		popupVisible,
		surface: currentSurface(),
		osReduceTransparency,
		systemDark,
		lastShow,
		latency,
		focus,
		log: [...recent].reverse().slice(0, 25),
		logPath,
	};
}

function pushStatus(): void {
	try {
		controlRpc.send.status(status());
	} catch {
		// control window not ready yet
	}
}

const controlRpc = BrowserView.defineRPC<ControlRPC>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			action: async ({ name, value }) => {
				record("action", { name, value });
				switch (name) {
					case "show":
						await showPopup("button");
						break;
					case "hide":
						hidePopup("button");
						break;
					case "toggle":
						if (popupVisible) hidePopup("toggle");
						else await showPopup("toggle");
						break;
					case "show-delayed":
						hidePopup("show-delayed");
						setTimeout(() => void showPopup("delayed 3 s"), 3000);
						break;
					case "show-new-content":
						hidePopup("show-new-content");
						contentSeq++;
						popupRpc.send.look(look());
						await showPopup("new content");
						break;
					case "latency":
						await latencyTest(Number(value ?? "20"));
						break;
					case "material":
					case "showMode":
					case "corner":
					case "theme":
					case "rt":
					case "veilAlpha":
					case "winBorder":
						if (value !== undefined) {
							if (name === "showMode" && popupVisible) hidePopup("show mode change");
							if (name === "showMode" && cloakPrimed && popupPtr()) {
								win.cloak(popupPtr()!, false);
								win.hide(popupPtr()!);
								cloakPrimed = false;
							}
							(settings as Record<string, string>)[name] = value;
							applyAll(`set ${name}`);
						}
						break;
					case "next-display":
						moveToNextDisplay();
						break;
					case "resize":
						toggleSize();
						break;
					case "diagnostics": {
						const p = popupPtr();
						record("diagnostics", {
							native: os === "macos" && mac ? mac.status(p) : os === "windows" && p ? win.describeWindow(p) : null,
							displays: Screen.getAllDisplays(),
							frame: popup.getFrame(),
							webPrefersDark,
							webPrefersRT,
						});
						break;
					}
					default:
						break;
				}
				return status();
			},
		},
		messages: {},
	},
});

const control = new BrowserWindow({
	title: "Glimpse materials spike: control",
	url: "views://control/index.html",
	frame: { x: 80, y: 80, width: 520, height: 820 },
	rpc: controlRpc,
});
record("control-created", { id: control.id });

readOsSettings();
record("startup", { os, config, osReduceTransparency, systemDark, logPath, pid: process.pid });
setInterval(() => pollSettings(), 1000);

if (config.autoShow) {
	setTimeout(() => {
		if (popupInstalled) void showPopup("autoshow");
		else record("autoshow-skipped", { reason: "popup webview has not said hello yet" });
	}, 1500);
}
