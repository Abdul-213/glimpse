// GLIM-15 spike, Electrobun main process. A small window to type a region,
// pick a backend, capture / benchmark / loop, and (macOS) inspect and request
// Screen Recording permission *as this app bundle*, which is what TCC sees.
import Electrobun, { BrowserWindow, Screen, Utils } from "electrobun/main";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fixedRateLoop, latencyBench } from "../core/bench";
import { formatRect, nativeToLogical, parseRect, type NativeDisplay, type Rect } from "../core/geometry";
import { allocRgba, sampleHash } from "../core/pixels";
import { formatSummary } from "../core/stats";
import {
	describeDisplays,
	forgetRequested,
	nativeBackendsFor,
	nativeCapturer,
	outDir,
	permissionReport,
	requestPermission,
	runSuite,
	snapshot,
	standardRegions,
	type Capturer,
} from "../app/runner";
import { NativeLib, OPT, type NativeBackendName } from "../native/lib";
import { BUILD_TAG } from "./build-tag";
import { WINDOW_HTML } from "./window-html";

const platform = process.platform;
const LOG = join(outDir(), "app-log.txt");
let win: BrowserWindow | null = null;
const pending: string[] = [];

function log(line: string) {
	const full = `${new Date().toISOString()} ${line}`;
	console.log(`[capture-spike] ${full}`);
	try {
		appendFileSync(LOG, full + "\n");
	} catch {
		// never let logging break the spike
	}
	pending.push(line);
	flush();
}

function push(extra: Record<string, unknown> = {}) {
	if (!win) return;
	win.webview.executeJavascript(`window.__glim && window.__glim(${JSON.stringify(extra)})`);
}

function flush() {
	if (!win || pending.length === 0) return;
	const lines = pending.splice(0);
	push({ lines });
}

// ---- native library + capturers ---------------------------------------------

let lib: NativeLib | null = null;
let libError: string | null = null;
try {
	lib = NativeLib.load();
} catch (e) {
	libError = String((e as Error).message);
}

function nativeDisplays(): NativeDisplay[] {
	return lib ? lib.displays().displays : [];
}

/** Electrobun's own Screen.captureRegion (macOS: CGWindowListCreateImage at nominal 1x; Windows: GetPixel per pixel). */
function electrobunCapturer(): Capturer {
	let img = allocRgba(1, 1);
	return {
		name: "electrobun",
		skipLarge:
			platform === "win32"
				? "Electrobun's Windows captureRegion calls GetPixel once per pixel; 1080p would take minutes"
				: undefined,
		grab(region: Rect) {
			const logical = lib ? nativeToLogical(region, Screen.getAllDisplays(), nativeDisplays(), platform) : region;
			const w = Math.round(logical.width);
			const h = Math.round(logical.height);
			const px = Screen.captureRegion({ x: logical.x, y: logical.y, width: w, height: h });
			if (!px) throw new Error("Screen.captureRegion returned null (no permission, API unavailable, or bad rect)");
			if (img.width !== w || img.height !== h) img = allocRgba(w, h);
			img.data.set(px); // the built-in allocates a new buffer per call; copy into ours
			return img;
		},
	};
}

function backends(): string[] {
	return [...(lib ? nativeBackendsFor(platform) : []), "electrobun"];
}

const capturers = new Map<string, Capturer>();
function capturer(name: string): Capturer {
	let c = capturers.get(name);
	if (!c) {
		if (name === "electrobun") c = electrobunCapturer();
		else {
			if (!lib) throw new Error(libError ?? "native library not loaded");
			c = nativeCapturer(lib, name as NativeBackendName);
		}
		capturers.set(name, c);
	}
	return c;
}

function presets() {
	try {
		return standardRegions(nativeDisplays().length ? nativeDisplays() : electrobunDisplaysAsNative());
	} catch {
		return {};
	}
}

function electrobunDisplaysAsNative(): NativeDisplay[] {
	return Screen.getAllDisplays().map((d) => ({
		id: d.id,
		bounds: d.bounds,
		pixelScale: platform === "darwin" ? d.scaleFactor : 1,
		uiScale: d.scaleFactor,
		primary: d.isPrimary,
	}));
}

function permState() {
	if (platform !== "darwin" || !lib) return undefined;
	return permissionReport(lib, false).verdict;
}

function sendState() {
	push({
		state: {
			platform,
			where: `${platform} build ${BUILD_TAG} pid ${process.pid}`,
			logPath: LOG,
			units:
				platform === "darwin"
					? "global points (top-left of main display = 0,0); output is points x display scale"
					: platform === "win32"
						? "physical pixels (per-monitor-DPI-aware virtual desktop)"
						: "",
			backends: backends(),
			presets: presets(),
			perm: permState(),
		},
	});
}

// ---- commands -------------------------------------------------------------

interface Msg {
	cmd: string;
	backend: string;
	rect: string;
	cursor: boolean;
	border: boolean;
	n: number;
	fps: number;
	seconds: number;
}

let busy = false;

async function handle(m: Msg) {
	if (lib) {
		lib.setOption(OPT.cursor, m.cursor);
		if (platform === "win32") lib.setOption(OPT.wgcBorder, m.border);
	}
	const region = () => {
		const r = parseRect(m.rect);
		return platform === "win32"
			? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
			: r;
	};
	switch (m.cmd) {
		case "hello":
			startupReport();
			return;
		case "displays":
			for (const l of describeDisplays(nativeDisplays())) log(`native  ${l}`);
			for (const d of Screen.getAllDisplays())
				log(`electrobun display ${d.id}${d.isPrimary ? " (primary)" : ""}: ${formatRect(d.bounds)} scaleFactor=${d.scaleFactor}`);
			return;
		case "perm":
		case "perm-probe": {
			if (!lib) return log(`native library missing: ${libError}`);
			const r = permissionReport(lib, m.cmd === "perm-probe");
			log(`permission: ${JSON.stringify({ ...r, signature: { ...r.signature, raw: undefined } })}`);
			log(`Electrobun Utils.screenCapture.hasAccess() = ${Utils.screenCapture.hasAccess()}`);
			sendState();
			return;
		}
		case "perm-request": {
			if (!lib) return log(`native library missing: ${libError}`);
			log("calling CGRequestScreenCaptureAccess() (a system prompt appears only if not yet determined)...");
			log(`-> ${requestPermission(lib)}`);
			sendState();
			return;
		}
		case "perm-forget":
			forgetRequested();
			log("cleared the 'asked before' flag (pair with: tccutil reset ScreenCapture dev.glimpse.spike.capture)");
			sendState();
			return;
		case "open-settings":
			Utils.screenCapture.openSettings();
			return;
		case "relaunch": {
			const bundle = /^(.*?\.app)\/Contents\//.exec(process.execPath)?.[1];
			if (platform === "darwin" && bundle) {
				log(`relaunching ${bundle}`);
				Bun.spawn(["/bin/sh", "-c", `sleep 1; open -n "${bundle}"`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
			} else log("relaunch: not in a .app bundle; restart manually");
			Utils.quit();
			return;
		}
		case "open-out":
			Utils.openPath(outDir());
			return;
		case "reset":
			for (const c of capturers.values()) c.reset?.();
			log("persistent capture sessions released");
			return;
		case "wgc-borderless":
			if (!lib) return log(`native library missing: ${libError}`);
			log("GraphicsCaptureAccess.RequestAccessAsync(Borderless)...");
			log(`-> ${JSON.stringify(lib.wgcRequestBorderless())}`);
			return;
		case "capture": {
			const c = capturer(m.backend);
			const s = snapshot(c, region(), "once");
			log(
				s.error
					? `capture ${m.backend}: ERROR ${s.error}`
					: `capture ${m.backend} ${formatRect(s.region)} -> ${s.width}x${s.height} px in ${s.ms.toFixed(1)} ms; saved ${s.file}; luma=${s.stats.meanLuma.toFixed(1)} flat=${s.stats.flatFraction.toFixed(3)}${s.warnings.length ? " WARN " + s.warnings.join("; ") : ""}`,
			);
			return;
		}
		case "bench": {
			const c = capturer(m.backend);
			const r = region();
			const res = await latencyBench(c.name, () => void c.grab(r), m.n || 50);
			log(`bench ${c.name} ${formatRect(r)}: warmup ${res.warmupMs.map((v) => v.toFixed(1)).join(", ")} ms; ${formatSummary(res.summary)}${res.failures ? ` failures=${res.failures} (${res.firstError})` : ""}`);
			if (lib) log(`native stats ${JSON.stringify(lib.stats())}`);
			return;
		}
		case "loop": {
			const c = capturer(m.backend);
			const r = region();
			log(`loop ${c.name} ${formatRect(r)} at ${m.fps} fps for ${m.seconds}s...`);
			const res = await fixedRateLoop(c.name, () => sampleHash(c.grab(r)), m.fps || 4, (m.seconds || 30) * 1000);
			log(`loop ${c.name}: captured=${res.framesCaptured}/${res.ticksScheduled} dropped=${res.dropped} failures=${res.failures} unchanged=${res.unchanged} cpu=${res.cpuPercent.toFixed(1)}% latency ${formatSummary(res.latency)}${res.firstError ? ` firstError=${res.firstError}` : ""}`);
			if (lib) log(`native stats ${JSON.stringify(lib.stats())}`);
			return;
		}
		case "suite": {
			const caps = backends().map(capturer);
			await runSuite(caps, nativeDisplays().length ? nativeDisplays() : electrobunDisplaysAsNative(), log, {
				n: m.n || 50,
				loopSeconds: m.seconds || 30,
				fps: m.fps || 4,
			}, lib ?? undefined);
			return;
		}
		default:
			log(`unknown command ${m.cmd}`);
	}
}

function startupReport() {
	log(`---- capture spike start: ${platform} build=${BUILD_TAG} pid=${process.pid} execPath=${process.execPath}`);
	log(lib ? `native library: ${lib.path}` : `native library NOT loaded: ${libError}`);
	if (lib) {
		const info = lib.displays();
		if (info.os) log(`macOS ${info.os}`);
		if (info.dpiMode) log(`dpi: ${info.dpiMode}`);
	}
	handle({ cmd: "displays" } as Msg);
	if (platform === "darwin" && lib) {
		const r = permissionReport(lib, false);
		log(`permission at launch: preflight=${r.preflight} everRequested=${r.everRequested} -> ${r.verdict.state}`);
		log(`signature: ${r.signature.bundlePath ?? "(no bundle)"} id=${r.signature.identifier} sig=${r.signature.signature} cdhash=${r.signature.cdhash} team=${r.signature.teamIdentifier}`);
		log(`designated requirement: ${r.signature.designatedRequirement}`);
		if (r.signature.warning) log(`WARNING: ${r.signature.warning}`);
	}
	sendState();
}

function openWindow() {
	win = new BrowserWindow({
		title: "Glimpse capture spike",
		html: WINDOW_HTML,
		frame: { width: 900, height: 720, x: 80, y: 80 },
	});
	// "host-message" is emitted by window.__electrobunSendToHost in the preload.
	(win.webview.on as (name: string, h: (e: unknown) => void) => void)("host-message", (e: unknown) => {
		const detail = (e as { data?: { detail?: unknown } }).data?.detail as Msg | undefined;
		if (!detail?.cmd) return;
		if (busy && detail.cmd !== "hello") return log(`busy; ignoring ${detail.cmd}`);
		busy = true;
		handle(detail)
			.catch((err) => log(`ERROR ${detail.cmd}: ${String((err as Error)?.message ?? err)}`))
			.finally(() => {
				busy = false;
				flush();
			});
	});
	win.webview.on("dom-ready", () => flush());
}

Electrobun.events.on("before-quit", () => {
	try {
		lib?.reset();
	} catch {
		// ignore
	}
});

openWindow();
