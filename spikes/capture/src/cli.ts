// Plain-Bun CLI for the capture spike (no Electrobun needed).
//
//   bun src/cli.ts displays
//   bun src/cli.ts capture --backend wgc --rect 100,100,400,120 [--out file.png]
//   bun src/cli.ts bench   --backend dxgi --rect 0,0,1920,1080 [--n 50]
//   bun src/cli.ts loop    --backend sck-stream --rect ... [--fps 4] [--seconds 30]
//   bun src/cli.ts suite   [--backends gdi,dxgi,wgc] [--n 50] [--seconds 30] [--loop-large]
//   bun src/cli.ts perm [--probe] | perm-request | perm-forget        (macOS)
//   bun src/cli.ts wgc-borderless                                     (Windows)
//
// Options: --cursor (include cursor), --border 0|1 (WGC border request),
//          --no-captureblt (GDI), --stream-fps N (SCStream minimumFrameInterval)
//
// macOS: run the *permission* tests from the .app, not from here. From a
// terminal, TCC attributes Screen Recording to Terminal/iTerm, not to us.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedRateLoop, latencyBench } from "./core/bench";
import { formatRect, parseRect, planCapture } from "./core/geometry";
import { imageStats, sampleHash } from "./core/pixels";
import { encodePng } from "./core/png";
import { formatSummary } from "./core/stats";
import {
	describeDisplays,
	forgetRequested,
	nativeBackendsFor,
	nativeCapturer,
	outDir,
	permissionReport,
	requestPermission,
	runSuite,
} from "./app/runner";
import { BACKEND_IDS, NativeLib, OPT, type NativeBackendName } from "./native/lib";

function args() {
	const [cmd = "help", ...rest] = process.argv.slice(2);
	const o: Record<string, string | boolean> = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (!a.startsWith("--")) continue;
		const k = a.slice(2);
		const v = rest[i + 1];
		if (v !== undefined && !v.startsWith("--")) {
			o[k] = v;
			i++;
		} else o[k] = true;
	}
	return { cmd, o };
}

const { cmd, o } = args();
const log = (s: string) => console.log(s);

function backendArg(): NativeBackendName {
	const b = String(o.backend ?? nativeBackendsFor()[0] ?? "");
	if (!(b in BACKEND_IDS)) throw new Error(`--backend must be one of ${nativeBackendsFor().join(", ")}`);
	return b as NativeBackendName;
}

function rectArg(): ReturnType<typeof parseRect> {
	if (typeof o.rect !== "string") throw new Error('--rect "x,y,width,height" is required');
	const r = parseRect(o.rect);
	// Windows backends work in whole physical pixels.
	return process.platform === "win32"
		? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
		: r;
}

function applyOptions(lib: NativeLib) {
	if (o.cursor) lib.setOption(OPT.cursor, 1);
	if (o.border !== undefined && process.platform === "win32") lib.setOption(OPT.wgcBorder, o.border !== "0");
	if (o["no-captureblt"] && process.platform === "win32") lib.setOption(OPT.captureBlt, 0);
	if (o["stream-fps"] && process.platform === "darwin") lib.setOption(OPT.streamFps, Number(o["stream-fps"]));
}

async function main() {
	if (cmd === "help" || o.help) {
		console.log(
			readHelp() ??
				"commands: displays | capture | bench | loop | suite | perm | perm-request | perm-forget | wgc-borderless",
		);
		return;
	}
	const lib = NativeLib.load();
	applyOptions(lib);
	log(`native library: ${lib.path}`);
	const info = lib.displays();
	if (info.dpiMode) log(`dpi: ${info.dpiMode}`);
	if (info.os) log(`macOS ${info.os}`);

	switch (cmd) {
		case "displays": {
			for (const l of describeDisplays(info.displays)) log(l);
			if (typeof o.rect === "string") {
				const plan = planCapture(rectArg(), info.displays);
				log(JSON.stringify(plan, null, 2));
			}
			break;
		}
		case "capture": {
			const c = nativeCapturer(lib, backendArg());
			const region = rectArg();
			const plan = planCapture(region, info.displays);
			const t0 = performance.now();
			const img = c.grab(region);
			const ms = performance.now() - t0;
			const file = typeof o.out === "string" ? o.out : join(outDir(), `cli-${c.name}-${img.width}x${img.height}.png`);
			writeFileSync(file, encodePng(img));
			log(
				`captured ${formatRect(region)} -> ${img.width}x${img.height} px (scale ${plan.scale}, ${plan.pieces.length} piece(s)${plan.hasUncovered ? ", partly off-screen" : ""}) in ${ms.toFixed(1)} ms (cold)`,
			);
			log(`stats: ${JSON.stringify(imageStats(img))}`);
			log(`saved ${file}`);
			break;
		}
		case "bench": {
			const c = nativeCapturer(lib, backendArg());
			const region = rectArg();
			const r = await latencyBench(c.name, () => void c.grab(region), Number(o.n ?? 50));
			log(`${c.name} ${formatRect(region)}: warmup ${r.warmupMs.map((v) => v.toFixed(1)).join(", ")} ms; ${formatSummary(r.summary)}`);
			if (r.failures) log(`failures=${r.failures}: ${r.firstError}`);
			log(`native stats: ${JSON.stringify(lib.stats())}`);
			break;
		}
		case "loop": {
			const c = nativeCapturer(lib, backendArg());
			const region = rectArg();
			const r = await fixedRateLoop(
				c.name,
				() => sampleHash(c.grab(region)),
				Number(o.fps ?? 4),
				Number(o.seconds ?? 30) * 1000,
			);
			log(JSON.stringify(r, null, 2));
			log(`native stats: ${JSON.stringify(lib.stats())}`);
			break;
		}
		case "suite": {
			const names = typeof o.backends === "string" ? (o.backends.split(",") as NativeBackendName[]) : nativeBackendsFor();
			const caps = names.map((b) => nativeCapturer(lib, b));
			for (const l of describeDisplays(info.displays)) log(l);
			await runSuite(
				caps,
				info.displays,
				log,
				{ n: Number(o.n ?? 50), loopSeconds: Number(o.seconds ?? 30), fps: Number(o.fps ?? 4), loopLarge: !!o["loop-large"] },
				lib,
			);
			break;
		}
		case "perm":
			log(JSON.stringify(permissionReport(lib, !!o.probe), null, 2));
			break;
		case "perm-request":
			log(`CGRequestScreenCaptureAccess() -> ${requestPermission(lib)}`);
			log(JSON.stringify(permissionReport(lib, false), null, 2));
			break;
		case "perm-forget":
			forgetRequested();
			log("everRequested flag cleared. Also run: tccutil reset ScreenCapture <bundle id>");
			break;
		case "wgc-borderless":
			log(JSON.stringify(lib.wgcRequestBorderless()));
			break;
		default:
			throw new Error(`unknown command ${cmd}`);
	}
}

function readHelp(): string | null {
	try {
		const src = require("node:fs").readFileSync(import.meta.path, "utf8") as string;
		const m = /^\/\/ Plain-Bun CLI[\s\S]*?\n(?!\/\/)/m.exec(src);
		return m ? m[0].replace(/^\/\/ ?/gm, "") : null;
	} catch {
		return null;
	}
}

main().catch((e) => {
	console.error(String(e?.message ?? e));
	process.exit(1);
});
