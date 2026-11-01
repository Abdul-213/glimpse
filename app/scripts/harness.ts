// Headless harness CLI (GLIM-86). From the repo root:
//
//   bun run harness displays
//   bun run harness snip --rect 20,15,160,90 --out /tmp/glim
//   bun run harness live --rect 190,0,150,60 --fps 4 --count 6
//   bun run harness live --frames path/to/recording --realtime
//   bun run harness snip --native --rect 0,0,400,200 --out out    (real capture on Windows/macOS)
//
// Without --native it uses the file-based capture backend over --frames (default: the
// sample recording in app/test/fixtures/capture/sample). --json prints the full report.
// Exits 1 on any capture error, so CI can run it as a smoke test.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CaptureSource, isCaptureError, parseRect, type Rect } from "@glimpse/core";
import { loadMacNative } from "../src/bun/native/macos.ts";
import { loadWindowsCapture } from "../src/bun/native/windows.ts";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { MacCaptureSource } from "../src/bun/services/capture/macos.ts";
import { displaysFromMac, displaysFromWindows } from "../src/bun/services/capture/native-displays.ts";
import { encodePng } from "../src/bun/services/capture/png.ts";
import { WindowsCaptureSource } from "../src/bun/services/capture/windows.ts";
import { type FrameReport, runLive, runSnip } from "../src/harness/run.ts";

const USAGE = `usage: bun run harness <displays|snip|live> [options]
  --frames <path>   frame folder or PNG for the file backend (default: sample recording)
  --native          use the real capture backend (Windows/macOS only)
  --rect x,y,w,h    global logical rect (default: the primary display)
  --scale <n>       output px per logical unit (default: highest display scale)
  --fps <n>         Live frame rate (default 4)
  --count <n>       Live frames to pull (default: frame count of the recording, else 8)
  --realtime        Live: sleep 1/fps between frames; file backend switches to timed advance
  --out <dir>       save each frame as PNG
  --json            print the full JSON report`;

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		frames: { type: "string" },
		native: { type: "boolean", default: false },
		rect: { type: "string" },
		scale: { type: "string" },
		fps: { type: "string", default: "4" },
		count: { type: "string" },
		realtime: { type: "boolean", default: false },
		out: { type: "string" },
		json: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

const command = positionals[0] ?? "snip";
if (values.help || !["displays", "snip", "live"].includes(command)) {
	console.log(USAGE);
	process.exit(values.help ? 0 : 2);
}

function nativeSource(): CaptureSource {
	if (process.platform === "win32") {
		const { binding, status } = loadWindowsCapture();
		if (!binding) throw new Error(`glimpse.dll unavailable: ${status.available ? "?" : status.reason}`);
		return new WindowsCaptureSource({ binding, shellDisplays: () => displaysFromWindows(binding.physicalDisplays()) });
	}
	if (process.platform === "darwin") {
		const { binding, status } = loadMacNative();
		if (!binding) throw new Error(`libglimpse.dylib unavailable: ${status.available ? "?" : status.reason}`);
		if (!binding.preflight()) {
			console.warn("[harness] Screen Recording is not granted to this terminal; captures may fail (-3801).");
		}
		return new MacCaptureSource({ binding, shellDisplays: () => displaysFromMac(binding.displays()) });
	}
	throw new Error(`--native needs Windows or macOS (this is ${process.platform})`);
}

const source: CaptureSource & { frameCount?: number } = values.native
	? nativeSource()
	: createFileCaptureSource(resolve(values.frames ?? SAMPLE_FRAMES_DIR), values.realtime ? { advance: "timed" } : {});

const displays = source.displays();
const primary = displays.find((d) => d.isPrimary) ?? displays[0];
const rect: Rect | undefined = values.rect ? parseRect(values.rect) : primary?.bounds;
const num = (v: string | undefined, name: string): number | undefined => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!(n > 0)) throw new Error(`--${name} must be a positive number`);
	return n;
};
const scale = num(values.scale, "scale");

let saved = 0;
const onFrame = values.out
	? (frame: Parameters<typeof encodePng>[0], r: FrameReport) => {
			const dir = resolve(values.out as string);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${command}-${String(r.index).padStart(3, "0")}.png`), encodePng(frame));
			saved++;
		}
	: undefined;

const line = (r: FrameReport) =>
	`#${r.index} ${r.width}x${r.height} @${r.scale}x seq ${r.sequence}${r.sequenceChanged ? " (new)" : " (same)"} ` +
	`hash ${r.hash}${r.partial ? " partial" : ""} ${r.ms} ms`;

try {
	if (command === "displays") {
		console.log(
			values.json ? JSON.stringify({ backend: source.backend, displays }, null, 2) : `backend ${source.backend}`,
		);
		if (!values.json) for (const d of displays) console.log(JSON.stringify(d));
	} else if (!rect) {
		throw new Error("no displays and no --rect");
	} else if (command === "snip") {
		const r = await runSnip(source, rect, { ...(scale ? { scale } : {}), ...(onFrame ? { onFrame } : {}) });
		console.log(
			values.json ? JSON.stringify(r, null, 2) : `snip ${source.backend} ${values.rect ?? "primary"}: ${line(r.frame)}`,
		);
	} else {
		const fps = num(values.fps, "fps") ?? 4;
		const count = num(values.count, "count") ?? source.frameCount ?? 8;
		const r = await runLive(source, rect, {
			fps,
			count,
			realtime: values.realtime,
			...(scale ? { scale } : {}),
			...(onFrame ? { onFrame } : {}),
		});
		if (values.json) {
			console.log(JSON.stringify(r, null, 2));
		} else {
			console.log(`live ${source.backend} ${values.rect ?? "primary"} at ${fps} fps:`);
			for (const f of r.frames) console.log(`  ${line(f)}`);
			console.log(`  ${r.summary.captured} frames, ${r.summary.changed} new, ${r.summary.unchanged} unchanged`);
		}
	}
	if (saved > 0) console.log(`saved ${saved} PNG(s) to ${resolve(values.out as string)}`);
} catch (e) {
	console.error(`[harness] ${isCaptureError(e) ? `${e.code}: ` : ""}${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 1;
} finally {
	source.dispose();
}
