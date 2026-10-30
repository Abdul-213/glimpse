// GLIM-13 spike: transparent full-screen region-picker overlay on Electrobun.
//
// One borderless transparent BrowserWindow per display (see FINDINGS.md for why
// not one spanning window). The Bun process owns the picker state machine and
// broadcasts state to every overlay webview; each webview draws its own slice.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserView, BrowserWindow, Screen, Tray, Utils } from "electrobun/main";
import type { Pointer } from "bun:ffi";
import {
	type DisplayInfo,
	describeSelection,
	displayForPoint,
	logicalToGlobalPhysical,
	type Point,
	sizeLabel,
	snapToDevicePixels,
} from "../shared/geometry";
import {
	cancel,
	DEFAULT_PICKER_OPTIONS,
	initialPickerState,
	keyDown,
	type PickerOptions,
	type PickerState,
	pointerDown,
	pointerMove,
	pointerUp,
} from "../shared/picker";
import type { OverlayRPC, OverlayState, ViewInit, ViewPointer, ViewReady } from "../shared/rpc";

const ELECTROBUN_PIN = "2.0.6-beta.2";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

function envFlag(name: string, dflt: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === "") return dflt;
	return !["0", "false", "no", "off"].includes(v.toLowerCase());
}
function envNum(name: string, dflt: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : dflt;
}

const config = {
	autostart: envFlag("OVERLAY_AUTOSTART", true),
	autostartDelayMs: envNum("OVERLAY_DELAY_MS", 1000),
	nativeShims: envFlag("OVERLAY_NATIVE", true),
	macLevel: envNum("OVERLAY_MAC_LEVEL", 1000), // NSScreenSaverWindowLevel
	macAccessory: envFlag("OVERLAY_MAC_ACCESSORY", true),
	macFullScreenAuxiliary: envFlag("OVERLAY_MAC_FSAUX", true),
	winToolWindow: envFlag("OVERLAY_WIN_TOOLWINDOW", true),
	confirmOnRelease: envFlag("OVERLAY_CONFIRM_ON_RELEASE", true),
	dimAlpha: envNum("OVERLAY_DIM", 0.35),
	exitAfterResult: envFlag("OVERLAY_EXIT_AFTER", false),
};

const logPath = join(Utils.paths.home, "glimpse-overlay-spike.log");

function record(type: string, data: unknown): void {
	const entry = { type, at: new Date().toISOString(), platform: process.platform, data };
	const json = JSON.stringify(entry, null, 2);
	console.log(`\n===== GLIMPSE_OVERLAY ${type} =====\n${json}`);
	try {
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		console.warn("[overlay] could not append to", logPath, err);
	}
}

// ---------------------------------------------------------------------------
// Native shims are loaded lazily so a missing DLL / dylib never breaks startup.

type MacShim = typeof import("./native-mac");
type WinShim = typeof import("./native-win");
let macShim: MacShim | null = null;
let winShim: WinShim | null = null;
async function loadShims(): Promise<void> {
	try {
		if (isMac) macShim = await import("./native-mac");
		if (isWin) winShim = await import("./native-win");
	} catch (err) {
		record("native-shim-load-failed", String(err));
	}
}

// ---------------------------------------------------------------------------
// Displays

function readDisplays(): DisplayInfo[] {
	const raw = Screen.getAllDisplays();
	return raw.map((d) => {
		let physicalBounds = null;
		if (isWin && winShim) {
			const info = winShim.monitorInfo(d.id);
			if (info) physicalBounds = info.physicalBounds;
		}
		return { ...d, physicalBounds };
	});
}

function displayDiagnostics(displays: DisplayInfo[]): unknown {
	return displays.map((d) => {
		const extra: Record<string, unknown> = {};
		if (isMac && macShim) extra["coreGraphics"] = macShim.macDisplayNative(d.id);
		if (isWin && winShim) extra["monitorInfo"] = winShim.monitorInfo(d.id);
		return { ...d, ...extra };
	});
}

// ---------------------------------------------------------------------------
// Overlay session

interface OverlayWindow {
	display: DisplayInfo;
	win: BrowserWindow;
	rpc: ReturnType<typeof makeRpc>;
	ready: ViewReady | null;
	readyAt: number | null;
}

interface Session {
	id: number;
	nativeShims: boolean;
	displays: DisplayInfo[];
	windows: Map<number, OverlayWindow>;
	state: PickerState;
	opts: PickerOptions;
	openedAt: number;
	dragStartedAt: number | null;
	dragOriginDisplay: number | null;
	lastViewEventAt: number;
	lastEcho: { displayId: number; t: number } | null;
	stats: { viewMoves: number; foreignViewMoves: number; polledMoves: number; outsideOriginReplaced: number; releaseBy: string | null };
	poll: ReturnType<typeof setInterval> | null;
	broadcastQueued: boolean;
	finished: boolean;
}

let session: Session | null = null;
let sessionCounter = 0;

function makeRpc(displayId: number) {
	return BrowserView.defineRPC<OverlayRPC>({
		maxRequestTime: 10_000,
		handlers: {
			requests: {
				hello: (ready: ViewReady): ViewInit => onHello(displayId, ready),
			},
			messages: {
				pointer: (p: ViewPointer) => onViewPointer(p),
				key: (k) => onViewKey(k),
				focus: (f) => {
					if (session) record("focus", { sessionId: session.id, ...f });
				},
			},
		},
	});
}

function onHello(displayId: number, ready: ViewReady): ViewInit {
	const s = session;
	const ow = s?.windows.get(displayId);
	const d = ow?.display ?? readDisplays().find((x) => x.id === displayId);
	if (s && ow) {
		ow.ready = ready;
		ow.readyAt = performance.now();
		const all = [...s.windows.values()];
		if (all.every((w) => w.readyAt !== null)) {
			const times = all.map((w) => (w.readyAt ?? 0) - s.openedAt);
			record("overlay-ready", {
				sessionId: s.id,
				openToFirstReadyMs: Math.round(Math.min(...times)),
				openToAllReadyMs: Math.round(Math.max(...times)),
				views: all.map((w) => ({
					displayId: w.display.id,
					expected: { ...w.display.bounds, scaleFactor: w.display.scaleFactor },
					view: w.ready,
					coversDisplay:
						w.ready !== null &&
						Math.abs(w.ready.innerWidth - w.display.bounds.width) <= 1 &&
						Math.abs(w.ready.innerHeight - w.display.bounds.height) <= 1,
					dprMatchesScale: w.ready !== null && Math.abs(w.ready.devicePixelRatio - w.display.scaleFactor) < 0.01,
				})),
			});
		}
	}
	return {
		displayId,
		origin: d ? { x: d.bounds.x, y: d.bounds.y } : { x: 0, y: 0 },
		scaleFactor: d?.scaleFactor ?? 1,
		isPrimary: d?.isPrimary ?? false,
		dimAlpha: config.dimAlpha,
		showLoupeHint: false,
	};
}

function windowDiagnostics(ow: OverlayWindow, nativeApplied: unknown): unknown {
	const out: Record<string, unknown> = {
		displayId: ow.display.id,
		requestedFrame: ow.display.bounds,
		electrobunGetFrame: ow.win.getFrame(),
		electrobunIsAlwaysOnTop: ow.win.isAlwaysOnTop(),
		nativeApplied,
	};
	const ptr = ow.win.ptr;
	if (ptr && isMac && macShim) {
		out["nsWindowLevel"] = macShim.getWindowIntProp(ptr, "level");
		out["nsWindowCollectionBehavior"] = macShim.getWindowIntProp(ptr, "collectionBehavior");
	}
	if (ptr && isWin && winShim) {
		const n = winShim.windowNative(ptr);
		out["win32"] = n;
		const pb = ow.display.physicalBounds;
		out["coversMonitorPhysically"] =
			pb !== null &&
			n.windowRect.x === pb.x &&
			n.windowRect.y === pb.y &&
			n.windowRect.width === pb.width &&
			n.windowRect.height === pb.height;
	}
	return out;
}

function openOverlay(opts: { nativeShims: boolean; reason: string }): void {
	if (session && !session.finished) {
		record("open-ignored", { reason: "overlay already open" });
		return;
	}
	const displays = readDisplays();
	if (displays.length === 0) {
		record("error", "Screen.getAllDisplays() returned no displays");
		return;
	}
	const s: Session = {
		id: ++sessionCounter,
		nativeShims: opts.nativeShims,
		displays,
		windows: new Map(),
		state: initialPickerState(),
		opts: { ...DEFAULT_PICKER_OPTIONS, confirmOnRelease: config.confirmOnRelease },
		openedAt: performance.now(),
		dragStartedAt: null,
		dragOriginDisplay: null,
		lastViewEventAt: 0,
		lastEcho: null,
		stats: { viewMoves: 0, foreignViewMoves: 0, polledMoves: 0, outsideOriginReplaced: 0, releaseBy: null },
		poll: null,
		broadcastQueued: false,
		finished: false,
	};
	session = s;
	record("overlay-open", { sessionId: s.id, reason: opts.reason, nativeShims: opts.nativeShims, config, displays: displayDiagnostics(displays) });

	const cursor = Screen.getCursorScreenPoint();
	const activeDisplay = displayForPoint(displays, cursor) ?? displays[0]!;

	for (const d of displays) {
		const rpc = makeRpc(d.id);
		const win = new BrowserWindow({
			title: `Glimpse overlay ${d.id}`,
			url: `views://overlay/index.html?display=${d.id}`,
			frame: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
			transparent: true,
			titleBarStyle: "hidden",
			styleMask: {
				Borderless: true,
				Titled: false,
				Closable: false,
				Miniaturizable: false,
				Resizable: false,
			},
			hidden: true,
			activate: false,
			rpc,
		});
		const ow: OverlayWindow = { display: d, win, rpc, ready: null, readyAt: null };
		s.windows.set(d.id, ow);

		let nativeApplied: unknown = null;
		const ptr = win.ptr as Pointer | null;
		if (opts.nativeShims && ptr) {
			try {
				if (isMac && macShim) {
					nativeApplied = macShim.configureMacOverlayWindow(ptr, {
						level: config.macLevel,
						fullScreenAuxiliary: config.macFullScreenAuxiliary,
					});
				} else if (isWin && winShim) {
					win.setAlwaysOnTop(true);
					nativeApplied = winShim.configureWinOverlayWindow(ptr, { toolWindow: config.winToolWindow });
				}
			} catch (err) {
				nativeApplied = { error: String(err) };
			}
		} else {
			// Pure Electrobun: the best the public API offers.
			win.setAlwaysOnTop(true);
			win.setVisibleOnAllWorkspaces(true);
		}

		if (d.id !== activeDisplay.id) win.showInactive();
		setTimeout(() => record("window", { sessionId: s.id, ...(windowDiagnostics(ow, nativeApplied) as object) }), 400);
	}
	// Activate (key window / foreground) the overlay under the cursor last so it gets keyboard focus.
	s.windows.get(activeDisplay.id)?.win.show();
	if (isWin && winShim) {
		setTimeout(() => {
			const fg = winShim!.foregroundWindow();
			const active = s.windows.get(activeDisplay.id);
			record("foreground", { sessionId: s.id, foregroundHwnd: fg, overlayHwnd: Number(active?.win.ptr ?? 0), overlayIsForeground: fg === Number(active?.win.ptr ?? -1) });
		}, 500);
	}

	s.state = pointerMove(s.state, cursor, displays);
	s.poll = setInterval(() => pollCursor(s), 16);
	broadcast(s);
}

function pollCursor(s: Session): void {
	if (s.finished) return;
	const now = performance.now();
	const quietFor = now - s.lastViewEventAt;
	const dragging = s.state.phase === "dragging";
	if (quietFor < (dragging ? 40 : 100)) return;
	const c = Screen.getCursorScreenPoint();
	const prev = s.state.cursor;
	if (!prev || prev.x !== c.x || prev.y !== c.y) {
		s.state = pointerMove(s.state, c, s.displays);
		if (dragging) s.stats.polledMoves++;
		broadcast(s);
	}
	if (dragging && quietFor > 120) {
		const buttons = Screen.getMouseButtons();
		if ((buttons & 1n) === 0n) {
			s.stats.releaseBy = "poll";
			s.state = pointerUp(s.state, c, s.displays, s.opts);
			afterTransition(s);
		}
	}
}

function toGlobal(s: Session, displayId: number, x: number, y: number): Point | null {
	const ow = s.windows.get(displayId);
	if (!ow) return null;
	return { x: ow.display.bounds.x + x, y: ow.display.bounds.y + y };
}

function onViewPointer(p: ViewPointer): void {
	const s = session;
	if (!s || s.finished) return;
	let g = toGlobal(s, p.displayId, p.x, p.y);
	if (!g) return;
	s.lastViewEventAt = performance.now();
	s.lastEcho = { displayId: p.displayId, t: p.t };

	// Points outside the reporting view's own display are extrapolated in that
	// display's scale. On Windows with mixed DPI that is wrong, so ask the OS.
	const own = s.windows.get(p.displayId)!.display.bounds;
	const outside = g.x < own.x || g.y < own.y || g.x >= own.x + own.width || g.y >= own.y + own.height;
	if (outside && p.phase !== "down") {
		g = Screen.getCursorScreenPoint();
		s.stats.outsideOriginReplaced++;
	}

	switch (p.phase) {
		case "down":
			s.state = pointerDown(s.state, g, s.displays);
			s.dragStartedAt = performance.now();
			s.dragOriginDisplay = p.displayId;
			break;
		case "move":
			if (s.state.phase === "dragging") {
				if (p.displayId === s.dragOriginDisplay) s.stats.viewMoves++;
				else s.stats.foreignViewMoves++;
			}
			s.state = pointerMove(s.state, g, s.displays);
			break;
		case "up":
			s.stats.releaseBy = p.displayId === s.dragOriginDisplay ? "view" : "foreign-view";
			s.state = pointerUp(s.state, g, s.displays, s.opts);
			break;
		case "leave":
			return;
	}
	afterTransition(s);
}

function onViewKey(k: { displayId: number; key: string; shift: boolean; alt: boolean }): void {
	const s = session;
	if (!s || s.finished) return;
	if (k.key === "Escape" || k.key === "Enter") s.stats.releaseBy = `key:${k.key}`;
	s.state = keyDown(s.state, { key: k.key, shift: k.shift, alt: k.alt }, s.displays, s.opts);
	afterTransition(s);
}

function afterTransition(s: Session): void {
	if (s.state.phase === "done") finish(s, "done");
	else if (s.state.phase === "cancelled") finish(s, "cancelled");
	else broadcast(s);
}

function overlayState(s: Session): OverlayState {
	const cursor = s.state.cursor;
	const labelDisplay = cursor ? displayForPoint(s.displays, cursor) : null;
	return {
		phase: s.state.phase,
		selection: s.state.selection,
		cursor,
		labelDisplayId: labelDisplay?.id ?? null,
		label: s.state.selection ? sizeLabel(s.state.selection, s.displays) : "",
		echo: s.lastEcho,
	};
}

function broadcast(s: Session): void {
	if (s.broadcastQueued) return;
	s.broadcastQueued = true;
	queueMicrotask(() => {
		s.broadcastQueued = false;
		if (s.finished) return;
		const st = overlayState(s);
		for (const ow of s.windows.values()) {
			try {
				ow.rpc.send.state(st);
			} catch {
				// view not connected yet
			}
		}
	});
}

function finish(s: Session, outcome: "done" | "cancelled"): void {
	if (s.finished) return;
	s.finished = true;
	if (s.poll) clearInterval(s.poll);
	const now = performance.now();

	if (outcome === "done" && s.state.selection) {
		const sel = s.state.selection;
		const anchorDisplay = displayForPoint(s.displays, { x: sel.x, y: sel.y }) ?? s.displays[0]!;
		const snapped = snapToDevicePixels(sel, anchorDisplay);
		const report = describeSelection(snapped, s.displays);
		const result: Record<string, unknown> = {
			sessionId: s.id,
			nativeShims: s.nativeShims,
			electrobun: ELECTROBUN_PIN,
			bun: process.versions.bun,
			globalLogicalRaw: sel,
			globalLogical: report.globalLogical,
			globalPhysicalBounds: report.globalPhysicalBounds,
			spansMixedScale: report.spansMixedScale,
			displaysTouched: report.pieces.map((p) => ({ id: p.displayId, scaleFactor: p.scaleFactor, isPrimary: p.isPrimary })),
			pieces: report.pieces,
			releaseBy: s.stats.releaseBy,
			stats: s.stats,
			dragDurationMs: s.dragStartedAt ? Math.round(now - s.dragStartedAt) : null,
			displays: s.displays,
		};
		if (isWin && winShim && s.state.cursor) {
			// Cross-check our logical->physical mapping against the OS cursor.
			const phys = winShim.physicalCursor();
			const predicted = logicalToGlobalPhysical(s.displays, s.state.cursor);
			result["cursorCheck"] = {
				lastLogicalCursor: s.state.cursor,
				osPhysicalCursorNow: phys,
				predictedPhysical: predicted,
				delta: phys && predicted ? { dx: phys.x - predicted.x, dy: phys.y - predicted.y } : null,
				note: "delta should be within ~2 px if the mouse did not move after release",
			};
		}
		record("selection", result);
		try {
			const first = report.pieces[0];
			Utils.showNotification({
				title: "Glimpse overlay spike",
				body: `${Math.round(sel.width)}×${Math.round(sel.height)} at ${Math.round(sel.x)},${Math.round(sel.y)} on ${report.pieces.length} display(s)${first ? ` (${first.localPhysical.width}×${first.localPhysical.height} px on first)` : ""}`,
				silent: true,
			});
		} catch {
			// notifications are best-effort
		}
	} else {
		record("cancelled", { sessionId: s.id, by: s.stats.releaseBy ?? "unknown" });
	}

	for (const ow of s.windows.values()) {
		try {
			ow.win.close();
		} catch {
			// already gone
		}
	}
	s.windows.clear();
	if (config.exitAfterResult) setTimeout(() => Utils.quit(), 200);
}

function cancelSession(reason: string): void {
	if (!session || session.finished) return;
	session.stats.releaseBy = reason;
	session.state = cancel(session.state);
	finish(session, "cancelled");
}

// ---------------------------------------------------------------------------
// Entry point

await loadShims();

const loadedWinShim = winShim as WinShim | null;
if (isWin && loadedWinShim) {
	record("win-thread-dpi", loadedWinShim.ensureWorkerThreadPmv2());
	record("win-virtual-screen", loadedWinShim.virtualScreen());
}
if (isMac && config.macAccessory && config.nativeShims) {
	// NSApplicationActivationPolicyAccessory: no Dock icon, and the app may show
	// windows over another app's fullscreen Space.
	Utils.setDockIconVisible(false);
}

record("startup", { config, logPath, electrobun: ELECTROBUN_PIN, bun: process.versions.bun, displays: displayDiagnostics(readDisplays()) });

const tray = new Tray({ title: "Glimpse spike" });
tray.setMenu([
	{ type: "normal", label: "Pick region", action: "pick" },
	{ type: "normal", label: "Pick region in 3 s", action: "pick-delayed" },
	{ type: "normal", label: "Pick region in 3 s (Electrobun only, no native shims)", action: "pick-plain" },
	{ type: "divider" },
	{ type: "normal", label: "Log displays", action: "displays" },
	{ type: "normal", label: "Cancel open overlay", action: "cancel" },
	{ type: "divider" },
	{ type: "normal", label: "Quit", action: "quit" },
]);
tray.on("tray-clicked", (event: unknown) => {
	const action = (event as { data?: { action?: string } }).data?.action;
	switch (action) {
		case "pick":
			openOverlay({ nativeShims: config.nativeShims, reason: "tray" });
			break;
		case "pick-delayed":
			setTimeout(() => openOverlay({ nativeShims: config.nativeShims, reason: "tray-delayed" }), 3000);
			break;
		case "pick-plain":
			setTimeout(() => openOverlay({ nativeShims: false, reason: "tray-plain" }), 3000);
			break;
		case "displays":
			record("displays", displayDiagnostics(readDisplays()));
			break;
		case "cancel":
			cancelSession("tray");
			break;
		case "quit":
			tray.remove();
			Utils.quit();
			break;
	}
});

if (config.autostart) {
	setTimeout(() => openOverlay({ nativeShims: config.nativeShims, reason: "autostart" }), config.autostartDelayMs);
}
