// GLIM-18 spike: Electrobun app that exercises the OS secret store from the
// Bun main process (which Electrobun runs in a Worker, not the main thread).
//
// On launch it logs its identity, reads the persisted marker (so "rebuild,
// relaunch, look at the window" is the whole rebuild test), then runs the
// round trip. Every other probe is in the tray / menu-bar menu.
// Results go to the window, the terminal and ~/glimpse-keychain-spike.log.
// Secret values are never logged: only fingerprints of random test markers.
import Electrobun, { BrowserWindow, Tray, Utils, type MenuItemConfig } from "electrobun/main";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteMarker, formatSteps, migrationProbe, readMarker, runRoundTrip, sizeProbe, writeMarker, type Step } from "../shared/roundtrip";
import { ApiKeyStore, SERVICE, bunSecretsBackend } from "../shared/secret-store";
import { WINDOW_HTML } from "./window-html";

const LOG_PATH = process.env.GLIM_SPIKE_LOG ?? join(homedir(), "glimpse-keychain-spike.log");
const store = new ApiKeyStore();
const history: string[] = [];
let busy = false;

function stamp() {
	return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function log(text: string) {
	const block = text
		.split("\n")
		.map((l) => `${stamp()} pid=${process.pid} ${l}`)
		.join("\n");
	console.log(block);
	history.unshift(text);
	history.length = Math.min(history.length, 30);
	try {
		appendFileSync(LOG_PATH, block + "\n");
	} catch {
		// logging must never break the spike
	}
	refreshUi();
}

const identity = [
	`platform=${process.platform} arch=${process.arch} bun=${Bun.version} (${Bun.revision.slice(0, 9)})`,
	`execPath=${process.execPath}`,
	`  ^ this is the executable the OS sees calling Keychain / Credential Manager.`,
	process.platform === "darwin" ? `  check it with: codesign -dv --verbose=2 "${process.execPath}"; codesign -d -r- "${process.execPath}"` : "",
	`service=${SERVICE} log=${LOG_PATH}`,
]
	.filter(Boolean)
	.join("\n");

async function run(title: string, fn: () => Promise<Step[]>) {
	if (busy) return;
	busy = true;
	try {
		const steps = await fn();
		const pass = steps.every((s) => s.ok);
		log(`== ${title}: ${pass ? "PASS" : "FAIL"}\n${formatSteps(steps)}`);
	} catch (err) {
		log(`== ${title}: CRASH ${(err as Error)?.message ?? String(err)}`);
	} finally {
		busy = false;
	}
}

// ---- UI ------------------------------------------------------------------------

let win: BrowserWindow | null = null;

function refreshUi() {
	if (win) win.webview.executeJavascript(`window.__glim && window.__glim(${JSON.stringify({ identity, history })})`);
}

function openWindow() {
	if (win) {
		win.focus();
		return;
	}
	win = new BrowserWindow({
		title: "Glimpse keychain spike",
		html: WINDOW_HTML,
		frame: { width: 760, height: 620, x: 120, y: 120 },
	});
	win.webview.on("dom-ready", () => refreshUi());
	win.on("close", () => {
		win = null;
	});
}

const tray = new Tray({ title: "Keychain" });
const menu: MenuItemConfig[] = [
	{ type: "normal", label: "Show window", action: "show" },
	{ type: "divider" },
	{ type: "normal", label: "Run round trip", action: "roundtrip" },
	{ type: "normal", label: "Write marker", action: "write-marker" },
	{ type: "normal", label: "Read marker", action: "read-marker" },
	{ type: "normal", label: "Delete marker", action: "delete-marker" },
	{ type: "normal", label: "Size probe", action: "size-probe" },
	{ type: "normal", label: "Service-rename migration probe", action: "migrate" },
	{ type: "divider" },
	{ type: "normal", label: "Quit", action: "quit" },
];
tray.setMenu(menu);

tray.on("tray-clicked", (event: unknown) => {
	const action = (event as { data?: { action?: string } }).data?.action ?? "";
	switch (action) {
		case "show":
			openWindow();
			break;
		case "roundtrip":
			void run("round trip", () => runRoundTrip(store));
			break;
		case "write-marker":
			void run("write marker", () => writeMarker(store));
			break;
		case "read-marker":
			void run("read marker", () => readMarker(store));
			break;
		case "delete-marker":
			void run("delete marker", () => deleteMarker(store));
			break;
		case "size-probe":
			void run("size probe (FAIL above the platform limit is expected)", () => sizeProbe(bunSecretsBackend, SERVICE));
			break;
		case "migrate":
			void run("migration", () => migrationProbe(store));
			break;
		case "quit":
			Utils.quit();
			break;
	}
});

Electrobun.events.on("before-quit", () => {
	try {
		tray.remove();
	} catch {
		// ignore
	}
});

// ---- start -----------------------------------------------------------------------

openWindow();
log(`---- spike start\n${identity}`);
await run("read marker (launch)", () => readMarker(store));
if (process.env.GLIM_SKIP_ROUNDTRIP !== "1") await run("round trip (launch)", () => runRoundTrip(store));
