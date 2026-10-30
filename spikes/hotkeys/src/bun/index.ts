// GLIM-14 spike entry point: register Glimpse's two default global hotkeys,
// log each press with a timestamp, show counters in a small window and the
// tray / menu-bar menu, and unregister on quit.
import Electrobun, { BrowserWindow, Tray, Utils, type MenuItemConfig } from "electrobun/main";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ActionId,
	type BackendName,
	type Platform,
	PressLog,
	defaultHotkeys,
	displayChord,
	formatPressLine,
	formatTime,
	parseAccelerator,
	pickBackend,
} from "../shared/hotkeys";
import { type HotkeyBackend, type RegisterResult, createBackend } from "./backends";
import { WINDOW_HTML } from "./window-html";

const platform = process.platform as Platform;
const LOG_PATH = process.env.GLIM_SPIKE_LOG ?? join(homedir(), "glimpse-hotkey-spike.log");
const hotkeys = defaultHotkeys(platform);
const presses = new PressLog();
const status: Record<ActionId, RegisterResult> = {
	snip: { ok: false, detail: "not registered yet" },
	live: { ok: false, detail: "not registered yet" },
};
let backend: HotkeyBackend | null = null;
let backendName: BackendName = "electrobun";
let backendError: string | null = null;

function log(line: string) {
	const full = `${formatTime(Date.now())} pid=${process.pid} ${line}`;
	console.log(`[spike] ${full}`);
	try {
		appendFileSync(LOG_PATH, full + "\n");
	} catch {
		// logging must never break the spike
	}
}

function labelFor(action: ActionId): string {
	const def = hotkeys.find((h) => h.action === action)!;
	return `${def.label} ${displayChord(parseAccelerator(def.accelerator), platform)}`;
}

function onPress(action: ActionId) {
	const ev = presses.record(action, backendName, Date.now());
	log(formatPressLine(ev));
	refreshUi();
}

function startBackend(name: BackendName) {
	if (backend) {
		backend.dispose();
		log(`backend ${backend.name}: unregistered all and disposed`);
		backend = null;
	}
	backendName = name;
	backendError = null;
	try {
		backend = createBackend(name, platform);
	} catch (err) {
		backendError = String(err instanceof Error ? err.message : err);
		log(`backend ${name}: FAILED TO START: ${backendError}`);
		for (const def of hotkeys) status[def.action] = { ok: false, detail: backendError };
		refreshUi();
		return;
	}
	for (const def of hotkeys) {
		const res = backend.register(def, () => onPress(def.action));
		status[def.action] = res;
		log(`register ${def.action} ${def.accelerator} via ${name}: ${res.ok ? "OK" : "FAILED"} - ${res.detail}`);
		if (!res.ok) {
			// GLIM-23 registration-failure handling: visible, never silent.
			Utils.showNotification({
				title: "Glimpse hotkey spike",
				body: `${labelFor(def.action)} could not be registered (${name}). See the spike window.`,
			});
		}
	}
	for (const d of backend.diagnostics()) log(`diag: ${d}`);
	refreshUi();
}

// ---- UI: window + tray -------------------------------------------------------

let win: BrowserWindow | null = null;

function snapshot() {
	return {
		backend: backendName + (backendError ? " (failed)" : ""),
		counts: presses.counts,
		labels: { snip: labelFor("snip"), live: labelFor("live") },
		status,
		livePinned: presses.livePinned,
		log: presses.events.slice(-30).reverse().map(formatPressLine),
		diag: [
			`platform=${platform} pid=${process.pid} log=${LOG_PATH}`,
			...(backendError ? [`backend error: ${backendError}`] : []),
			...(backend?.diagnostics() ?? []),
			`snip: ${status.snip.detail}`,
			`live: ${status.live.detail}`,
		],
	};
}

function openWindow() {
	if (win) {
		win.focus();
		return;
	}
	win = new BrowserWindow({
		title: "Glimpse hotkey spike",
		html: WINDOW_HTML,
		frame: { width: 560, height: 560, x: 120, y: 120 },
	});
	win.webview.on("dom-ready", () => refreshUi());
	win.on("close", () => {
		win = null;
	});
}

const tray = new Tray({ title: "S0 L0" });

function trayMenu(): MenuItemConfig[] {
	const other: BackendName = backendName === "carbon" ? "electrobun" : "carbon";
	const items: MenuItemConfig[] = [
		{ type: "normal", label: `Backend: ${backendName}${backendError ? " (FAILED)" : ""}`, enabled: false },
		...(["snip", "live"] as const).map(
			(a): MenuItemConfig => ({
				type: "normal",
				label: `${labelFor(a)}: ${presses.counts[a]}  ${status[a].ok ? "" : "[NOT REGISTERED]"}`,
				enabled: false,
			}),
		),
		{ type: "divider" },
		{ type: "normal", label: "Show window", action: "show" },
		{ type: "normal", label: "Re-register hotkeys", action: "reregister" },
		{ type: "normal", label: "Unregister hotkeys (keep running)", action: "unregister" },
		{ type: "normal", label: "Reset counters", action: "reset" },
	];
	if (platform === "darwin") {
		items.push({ type: "normal", label: `Switch to ${other} backend`, action: `backend:${other}` });
	}
	items.push({ type: "divider" }, { type: "normal", label: "Quit", action: "quit" });
	return items;
}

function refreshUi() {
	tray.setTitle(`S${presses.counts.snip} L${presses.counts.live}`);
	tray.setMenu(trayMenu());
	if (win) win.webview.executeJavascript(`window.__glim && window.__glim(${JSON.stringify(snapshot())})`);
}

tray.on("tray-clicked", (event: unknown) => {
	const action = (event as { data?: { action?: string } }).data?.action ?? "";
	if (action === "show") openWindow();
	else if (action === "reregister") startBackend(backendName);
	else if (action === "unregister") {
		backend?.unregisterAll();
		for (const def of hotkeys) status[def.action] = { ok: false, detail: "unregistered from tray menu" };
		log(`backend ${backendName}: unregistered all (tray menu)`);
		refreshUi();
	} else if (action === "reset") {
		presses.reset();
		log("counters reset");
		refreshUi();
	} else if (action.startsWith("backend:")) startBackend(action.slice(8) as BackendName);
	else if (action === "quit") Utils.quit();
});

// Unregister on quit (Electrobun does not do this itself; the OS frees the
// registrations at process exit anyway, which the test plan checks).
Electrobun.events.on("before-quit", () => {
	if (backend) {
		backend.dispose();
		log(`before-quit: ${backendName} hotkeys unregistered`);
	}
	try {
		tray.remove();
	} catch {
		// ignore
	}
});

// ---- start -------------------------------------------------------------------

log(`---- spike start: platform=${platform} electrobun backend default, env GLIM_HOTKEY_BACKEND=${process.env.GLIM_HOTKEY_BACKEND ?? ""}`);
let initial: BackendName = "electrobun";
try {
	initial = pickBackend(platform, process.env.GLIM_HOTKEY_BACKEND);
} catch (err) {
	log(String(err));
}
startBackend(initial);
openWindow();
