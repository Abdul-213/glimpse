// OS-agnostic spike runner shared by the CLI (plain `bun`) and the Electrobun
// app. Everything here works on a "Capturer": something that turns a region in
// the native capture space into an RGBA image.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fixedRateLoop, latencyBench, type LatencyResult, type LoopResult } from "../core/bench";
import {
	formatRect,
	planCapture,
	spanningRegion,
	type CapturePlan,
	type NativeDisplay,
	type Rect,
} from "../core/geometry";
import { derivePermission, type PermissionVerdict } from "../core/permission";
import {
	allocRgba,
	imageStats,
	rgbaToChwFloat32,
	sampleHash,
	type ImageStats,
	type RgbaImage,
} from "../core/pixels";
import { encodePng } from "../core/png";
import { formatSummary, fmtMs } from "../core/stats";
import { NativeLib, type NativeBackendName } from "../native/lib";
import { signatureInfo, type SignatureInfo } from "./mac-signature";

export interface Capturer {
	name: string;
	/** Returns an image; the buffer may be reused by the next call. */
	grab(region: Rect): RgbaImage;
	/** Drop persistent sessions so the next grab is a cold start. */
	reset?(): void;
	/** Regions this backend should not be benchmarked on (too slow etc). */
	skipLarge?: string;
}

export type Logger = (line: string) => void;

export function outDir(): string {
	const d = process.env.GLIM_CAPTURE_OUT ?? join(homedir(), "GlimpseCaptureSpike");
	mkdirSync(d, { recursive: true });
	return d;
}

export function nativeBackendsFor(platform = process.platform): NativeBackendName[] {
	if (platform === "darwin") return ["sck-shot", "sck-stream"];
	if (platform === "win32") return ["gdi", "dxgi", "wgc"];
	return [];
}

export function nativeCapturer(lib: NativeLib, backend: NativeBackendName): Capturer {
	let displays: NativeDisplay[] = lib.displays().displays;
	let key = "";
	let plan: CapturePlan | null = null;
	let img: RgbaImage | null = null;
	return {
		name: backend,
		grab(region) {
			const k = formatRect(region);
			if (k !== key || !plan) {
				displays = lib.displays().displays;
				plan = planCapture(region, displays);
				key = k;
				if (!img || img.width !== plan.outWidth || img.height !== plan.outHeight) {
					img = allocRgba(plan.outWidth, plan.outHeight);
				}
			}
			lib.capture(backend, plan, img!);
			return img!;
		},
		reset() {
			lib.reset();
		},
	};
}

// ---------------------------------------------------------------------------

export interface StandardRegions {
	small: Rect;
	large: Rect;
	/** macOS only: a region whose *output* is 1920x1080 px on the primary display. */
	largePx?: Rect;
	span?: Rect;
}

export function standardRegions(displays: NativeDisplay[]): StandardRegions {
	const primary = displays.find((d) => d.primary) ?? displays[0];
	if (!primary) throw new Error("no displays reported");
	const b = primary.bounds;
	// Small: a subtitle-strip-sized box in the lower middle of the primary display.
	const small: Rect = {
		x: Math.round(b.x + (b.width - 400) / 2),
		y: Math.round(b.y + b.height * 0.7),
		width: 400,
		height: 120,
	};
	const large: Rect = { x: b.x, y: b.y, width: Math.min(1920, b.width), height: Math.min(1080, b.height) };
	const r: StandardRegions = { small, large };
	if (primary.pixelScale > 1) {
		const s = primary.pixelScale;
		r.largePx = {
			x: b.x,
			y: b.y,
			width: Math.min(b.width, Math.round(1920 / s)),
			height: Math.min(b.height, Math.round(1080 / s)),
		};
	}
	const span = spanningRegion(displays);
	if (span) r.span = span;
	return r;
}

export interface SnapshotResult {
	backend: string;
	label: string;
	region: Rect;
	width: number;
	height: number;
	ms: number;
	file: string;
	stats: ImageStats;
	warnings: string[];
	error?: string;
}

export function snapshot(c: Capturer, region: Rect, label: string, dir = outDir()): SnapshotResult {
	const t0 = performance.now();
	try {
		const img = c.grab(region);
		const ms = performance.now() - t0;
		const file = join(dir, `${c.name}-${label}-${img.width}x${img.height}.png`);
		writeFileSync(file, encodePng(img));
		const stats = imageStats(img);
		const warnings: string[] = [];
		if (stats.flatFraction > 0.98) {
			warnings.push(
				"image is ~flat (single colour): blank capture? On macOS without permission you get wallpaper-only/black frames.",
			);
		}
		if (!stats.allOpaque) warnings.push("alpha not 255 everywhere");
		return { backend: c.name, label, region, width: img.width, height: img.height, ms, file, stats, warnings };
	} catch (e) {
		return {
			backend: c.name,
			label,
			region,
			width: 0,
			height: 0,
			ms: performance.now() - t0,
			file: "",
			stats: { meanLuma: 0, flatFraction: 1, allOpaque: false, hash: 0 },
			warnings: [],
			error: String((e as Error).message ?? e),
		};
	}
}

export interface BackendReport {
	backend: string;
	snapshots: SnapshotResult[];
	cold: { label: string; ms: number | null; error?: string }[];
	latency: (LatencyResult & { region: Rect })[];
	loops: (LoopResult & { region: Rect })[];
	nativeStats?: unknown;
}

export interface SuiteOptions {
	n?: number;
	loopSeconds?: number;
	fps?: number;
	loopLarge?: boolean;
	regions?: Partial<StandardRegions>;
}

export async function runSuite(
	capturers: Capturer[],
	displays: NativeDisplay[],
	log: Logger,
	opts: SuiteOptions = {},
	lib?: NativeLib,
): Promise<{ reports: BackendReport[]; regions: StandardRegions; file: string; markdown: string }> {
	const n = opts.n ?? 50;
	const regions = { ...standardRegions(displays), ...opts.regions };
	const dir = outDir();
	const reports: BackendReport[] = [];
	const labelled: [string, Rect][] = [
		["small", regions.small],
		["large", regions.large],
		...(regions.largePx ? ([["large-px", regions.largePx]] as [string, Rect][]) : []),
		...(regions.span ? ([["span", regions.span]] as [string, Rect][]) : []),
	];
	log(`regions: ${labelled.map(([l, r]) => `${l}=${formatRect(r)}`).join("  ")}`);
	if (!regions.span) log("span: only one display (or no shared edge); spanning test skipped");

	for (const c of capturers) {
		const rep: BackendReport = { backend: c.name, snapshots: [], cold: [], latency: [], loops: [] };
		reports.push(rep);
		log(`=== backend ${c.name}`);
		for (const [label, region] of labelled) {
			if (label !== "small" && c.skipLarge) {
				log(`  ${label}: skipped (${c.skipLarge})`);
				continue;
			}
			// Cold start: drop sessions, time the first grab.
			c.reset?.();
			const t0 = performance.now();
			try {
				c.grab(region);
				rep.cold.push({ label, ms: performance.now() - t0 });
			} catch (e) {
				rep.cold.push({ label, ms: null, error: String((e as Error).message) });
			}
			const snap = snapshot(c, region, label, dir);
			rep.snapshots.push(snap);
			log(
				snap.error
					? `  ${label}: ERROR ${snap.error}`
					: `  ${label}: ${snap.width}x${snap.height} px, cold ${fmtMs(rep.cold.at(-1)!.ms ?? NaN)}, saved ${snap.file}` +
							(snap.warnings.length ? `  WARN ${snap.warnings.join("; ")}` : ""),
			);
			if (snap.error) continue;
			const count = label === "span" ? Math.min(n, 20) : n;
			const lat = await latencyBench(`${c.name}/${label}`, () => void c.grab(region), count);
			rep.latency.push({ ...lat, region });
			log(`  ${label}: ${formatSummary(lat.summary)}${lat.failures ? ` failures=${lat.failures} (${lat.firstError})` : ""}`);
		}
		const loopRegions: [string, Rect][] = [["small", regions.small]];
		if (opts.loopLarge && !c.skipLarge) loopRegions.push(["large", regions.large]);
		for (const [label, region] of loopRegions) {
			const secs = opts.loopSeconds ?? 30;
			log(`  loop ${label}: ${opts.fps ?? 4} fps for ${secs}s (put changing content under the region)...`);
			const loop = await fixedRateLoop(
				`${c.name}/${label}`,
				() => sampleHash(c.grab(region)),
				opts.fps ?? 4,
				secs * 1000,
			);
			rep.loops.push({ ...loop, region });
			log(
				`  loop ${label}: captured=${loop.framesCaptured}/${loop.ticksScheduled} dropped=${loop.dropped} failures=${loop.failures} ` +
					`unchanged=${loop.unchanged} cpu=${loop.cpuPercent.toFixed(1)}% latency ${formatSummary(loop.latency)}`,
			);
		}
		if (lib) rep.nativeStats = lib.stats();
	}

	// ONNX hand-off cost on the large image, once.
	let tensorMs: number | null = null;
	const first = capturers[0];
	if (first) {
		try {
			const img = first.grab(regions.large);
			const out = new Float32Array(img.width * img.height * 3);
			const t0 = performance.now();
			rgbaToChwFloat32(img, undefined, undefined, out);
			tensorMs = performance.now() - t0;
			log(`ONNX hand-off: RGBA ${img.width}x${img.height} -> float32 CHW in ${fmtMs(tensorMs)} (JS loop)`);
		} catch {
			// ignore
		}
	}

	const markdown = toMarkdown(reports, labelled, tensorMs);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(dir, `results-${process.platform}-${stamp}.json`);
	writeFileSync(file, JSON.stringify({ platform: process.platform, displays, regions, reports, tensorMs }, null, 2));
	writeFileSync(file.replace(/\.json$/, ".md"), markdown);
	log(`results: ${file} (+ .md)`);
	return { reports, regions, file, markdown };
}

function toMarkdown(reports: BackendReport[], labelled: [string, Rect][], tensorMs: number | null): string {
	const lines = [
		`# Capture spike results (${process.platform}, ${new Date().toISOString()})`,
		"",
		`Regions: ${labelled.map(([l, r]) => `${l} = ${formatRect(r)}`).join("; ")}`,
		"",
		"| backend | region | output px | cold | p50 | p95 | failures | notes |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (const r of reports) {
		for (const s of r.snapshots) {
			const lat = r.latency.find((l) => l.label.endsWith(`/${s.label}`));
			const cold = r.cold.find((c) => c.label === s.label);
			lines.push(
				`| ${r.backend} | ${s.label} | ${s.width}x${s.height} | ${fmtMs(cold?.ms ?? NaN)} | ${fmtMs(lat?.summary.p50 ?? NaN)} | ${fmtMs(lat?.summary.p95 ?? NaN)} | ${lat?.failures ?? "-"} | ${s.error ?? s.warnings.join("; ")} |`,
			);
		}
	}
	lines.push("", "| backend | loop | fps | captured/scheduled | dropped | unchanged | CPU (bun process) | p95 |", "|---|---|---|---|---|---|---|---|");
	for (const r of reports) {
		for (const l of r.loops) {
			lines.push(
				`| ${r.backend} | ${l.label} | ${l.fps} | ${l.framesCaptured}/${l.ticksScheduled} | ${l.dropped} | ${l.unchanged} | ${l.cpuPercent.toFixed(1)}% | ${fmtMs(l.latency.p95)} |`,
			);
		}
	}
	if (tensorMs !== null) lines.push("", `RGBA -> float32 CHW tensor (large): ${fmtMs(tensorMs)}`);
	return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// macOS permission

interface SpikeState {
	everRequested: boolean;
	history: { at: string; event: string; detail: string }[];
}

function statePath() {
	return join(outDir(), "permission-state.json");
}

export function loadState(): SpikeState {
	try {
		if (existsSync(statePath())) return JSON.parse(readFileSync(statePath(), "utf8"));
	} catch {
		// fall through
	}
	return { everRequested: false, history: [] };
}

function saveState(s: SpikeState) {
	s.history = s.history.slice(-200);
	writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

export interface PermissionReport {
	preflight: boolean;
	everRequested: boolean;
	sckProbe?: { ok: true } | { ok: false; code: number; message: string };
	verdict: PermissionVerdict;
	signature: SignatureInfo;
	pid: number;
	execPath: string;
}

export function permissionReport(lib: NativeLib, probe: boolean): PermissionReport {
	const state = loadState();
	const preflight = lib.macPreflight();
	// Only probe SCK when it cannot trigger the first-time prompt by itself.
	const sckProbe = probe && (preflight || state.everRequested) ? lib.macSckProbe() : undefined;
	const verdict = derivePermission({ preflight, everRequested: state.everRequested, sckProbe });
	const signature = signatureInfo();
	state.history.push({
		at: new Date().toISOString(),
		event: "check",
		detail: `preflight=${preflight} probe=${sckProbe ? JSON.stringify(sckProbe) : "-"} verdict=${verdict.state} cdhash=${signature.cdhash ?? "-"} sig=${signature.signature ?? "-"}`,
	});
	saveState(state);
	return { preflight, everRequested: state.everRequested, sckProbe, verdict, signature, pid: process.pid, execPath: process.execPath };
}

export function requestPermission(lib: NativeLib): boolean {
	const state = loadState();
	const t0 = performance.now();
	const r = lib.macRequest();
	state.everRequested = true;
	state.history.push({
		at: new Date().toISOString(),
		event: "request",
		detail: `CGRequestScreenCaptureAccess()=${r} after ${(performance.now() - t0).toFixed(0)} ms`,
	});
	saveState(state);
	return r;
}

export function forgetRequested(): void {
	const s = loadState();
	s.everRequested = false;
	s.history.push({ at: new Date().toISOString(), event: "forget", detail: "everRequested reset (pair with tccutil reset)" });
	saveState(s);
}

export function describeDisplays(displays: NativeDisplay[]): string[] {
	return displays.map(
		(d) =>
			`display ${d.id}${d.primary ? " (primary)" : ""}${d.name ? ` ${d.name}` : ""}: ${formatRect(d.bounds)} pixelScale=${d.pixelScale} uiScale=${d.uiScale}`,
	);
}

