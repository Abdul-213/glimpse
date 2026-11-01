// Headless harness CLI (GLIM-86). From the repo root:
//
//   bun run harness displays
//   bun run harness snip --rect 20,15,160,90 --out /tmp/glim
//   bun run harness live --rect 190,0,150,60 --fps 4 --count 6
//   bun run harness live --frames path/to/recording --realtime
//   bun run harness snip --native --rect 0,0,400,200 --out out    (real capture on Windows/macOS)
//   bun run harness snip --pipeline                                 (OCR -> detect -> cache -> translate, fakes)
//   bun run harness snip --pipeline --translator bergamot --to de --ocr-text "明日の会議は午後三時に始まります。"
//   bun run harness pick --drag 20,15,160,90 --out /tmp/glim       (region picker, GLIM-44)
//   bun run harness pick --keys ArrowRight,Enter --mode live
//   bun run harness windows --native                               (picker window list, GLIM-91)
//   bun run harness loupe --native --at 400,300 --count 60         (loupe sampling rate, GLIM-91)
//   bun run harness snip --pipeline --ocr paddle --translator bergamot --to en --sources ja,de \
//     --frames app/test/fixtures/capture/mixed-ja-de/mixed-ja-de.png      (real OCR, ELD, Bergamot)
//
// Without --native it uses the file-based capture backend over --frames (default: the
// sample recording in app/test/fixtures/capture/sample). --json prints the full report.
// Exits 1 on any capture error, so CI can run it as a smoke test.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type CaptureSource,
	isCaptureError,
	type LanguageCode,
	parseLanguageCode,
	parseRect,
	type Rect,
	TranslationCache,
} from "@glimpse/core";
import { loadMacNative } from "../src/bun/native/macos.ts";
import { loadWindowsCapture } from "../src/bun/native/windows.ts";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { MacCaptureSource } from "../src/bun/services/capture/macos.ts";
import { displaysFromMac, displaysFromWindows } from "../src/bun/services/capture/native-displays.ts";
import { encodePng } from "../src/bun/services/capture/png.ts";
import { WindowsCaptureSource } from "../src/bun/services/capture/windows.ts";
import { createPickerNatives } from "../src/bun/services/picker/index.ts";
import { pipelineStages } from "../src/bun/services/translation/pipeline-stages.ts";
import { dragSteps, type PickStep, runPick } from "../src/harness/pick.ts";
import {
	bergamotTranslator,
	defaultPackRoot,
	fakeTranslator,
	type HarnessTranslator,
	paddleOcr,
	scriptedOcr,
} from "../src/harness/providers.ts";
import {
	type FrameReport,
	type HarnessStage,
	type PipelineStageReport,
	pipelineStage,
	runLive,
	runSnip,
} from "../src/harness/run.ts";

const USAGE = `usage: bun run harness <displays|snip|live|pick|windows|loupe> [options]
  --frames <path>   frame folder or PNG for the file backend (default: sample recording)
  --native          use the real capture backend (Windows/macOS only)
  --rect x,y,w,h    global logical rect (default: the primary display)
  --scale <n>       output px per logical unit (default: highest display scale)
  --fps <n>         Live frame rate (default 4)
  --count <n>       Live frames to pull (default: frame count of the recording, else 8)
  --realtime        Live: sleep 1/fps between frames; file backend switches to timed advance
  --out <dir>       save each frame as PNG
  --json            print the full JSON report
  --pipeline        run the translation pipeline (GLIM-102) on every frame, with the real
                    grouping (GLIM-56) and language detection (GLIM-21 rules over ELD, GLIM-49)
  --ocr <o>         pipeline: scripted (default) or paddle (real PaddleOCR over the dev model
                    cache from \`bun run models\`, no network)
  --ocr-text <t>    pipeline: what the scripted OCR "reads", lines separated by |
                    (default: a Japanese sentence pair, a number and an English label)
  --translator <t>  pipeline: fake (default) or bergamot (real WASM + installed packs, no network)
  --packs <dir>     bergamot: model folder with installed packs (default ${defaultPackRoot()})
  --to <lang>       pipeline target language (default en)
  --sources <a,b>   pipeline source-language subset (default: every language)
  --private         pipeline: Private mode (nothing cached)
  --drag x1,y1,x2,y2  pick: press, drag and release (global logical)
  --click x,y       pick: click (selects the window or display under it)
  --keys a,b,...    pick: key presses (DOM key names: ArrowRight, Enter, Escape, Tab)
  --mode snip|live  pick: picker mode (default snip)
  --at x,y          loupe: global logical point to sample (default: primary display centre)`;

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
		pipeline: { type: "boolean", default: false },
		ocr: { type: "string", default: "scripted" },
		"ocr-text": { type: "string" },
		translator: { type: "string", default: "fake" },
		packs: { type: "string" },
		to: { type: "string", default: "en" },
		sources: { type: "string" },
		private: { type: "boolean", default: false },
		at: { type: "string" },
		drag: { type: "string" },
		click: { type: "string" },
		keys: { type: "string" },
		mode: { type: "string", default: "snip" },
		help: { type: "boolean", short: "h", default: false },
	},
});

const command = positionals[0] ?? "snip";
if (values.help || !["displays", "snip", "live", "pick", "windows", "loupe"].includes(command)) {
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

const lang = (v: string, name: string): LanguageCode => {
	const code = parseLanguageCode(v);
	if (!code) throw new Error(`--${name}: not a language code: ${v}`);
	return code;
};
const DEFAULT_OCR_TEXT = "設定を保存しました。次へ進みます。|100|Settings";

let translator: HarnessTranslator | null = null;
let ocrProvider: { dispose(): Promise<void> } | null = null;
const stages: HarnessStage[] = [];
if (values.pipeline) {
	const to = lang(values.to ?? "en", "to");
	const sources = (values.sources ?? "")
		.split(",")
		.filter(Boolean)
		.map((s) => lang(s, "sources"));
	if (values.translator !== "fake" && values.translator !== "bergamot") {
		throw new Error(`--translator must be fake or bergamot, not ${values.translator}`);
	}
	if (values.ocr !== "scripted" && values.ocr !== "paddle") {
		throw new Error(`--ocr must be scripted or paddle, not ${values.ocr}`);
	}
	const ocr =
		values.ocr === "paddle" ? await paddleOcr() : scriptedOcr((values["ocr-text"] ?? DEFAULT_OCR_TEXT).split("|"));
	if (values.ocr === "scripted") await ocr.init();
	ocrProvider = ocr;
	const real = pipelineStages({ warn: (message, fields) => console.warn(`[harness] ${message}`, fields ?? "") });
	await real.detector.load();
	translator =
		values.translator === "bergamot"
			? await bergamotTranslator(
					values.packs ? resolve(values.packs) : defaultPackRoot(),
					// Warm the user's pairs like the app does after startup.
					sources.filter((from) => from !== to).map((from) => ({ from, to })),
				)
			: await fakeTranslator();
	stages.push(
		pipelineStage({
			ocr,
			grouper: real.grouper,
			detect: real.detector,
			translation: translator.provider,
			to,
			sources,
			private: values.private,
			cache: new TranslationCache({ store: !values.private, name: "harness" }),
		}),
	);
}

const pipelineLines = (r: FrameReport): string[] => {
	const p = r.stages["pipeline"] as PipelineStageReport | undefined;
	if (!p) return [];
	const out = [
		`    pipeline: ${p.done}/${p.total} translated${p.error ? `, error ${p.error}` : ""} in ${p.timings.totalMs} ms ` +
			`(OCR ${p.timings.ocrMs} ms, translate ${p.timings.translateMs} ms; ${p.events.join(" → ")})`,
	];
	for (const b of p.blocks) {
		const what = b.translation ?? (b.error ? `[${b.error}]` : `[${b.cls}]`);
		out.push(
			`      ${b.id} ${b.cls} ${b.from ?? "-"}: ${JSON.stringify(b.text)} → ${JSON.stringify(what)}${b.remembered ? " (remembered)" : ""}`,
		);
	}
	return out;
};

const line = (r: FrameReport) =>
	`#${r.index} ${r.width}x${r.height} @${r.scale}x seq ${r.sequence}${r.sequenceChanged ? " (new)" : " (same)"} ` +
	`hash ${r.hash}${r.partial ? " partial" : ""} ${r.ms} ms`;

try {
	if (command === "displays") {
		console.log(
			values.json ? JSON.stringify({ backend: source.backend, displays }, null, 2) : `backend ${source.backend}`,
		);
		if (!values.json) for (const d of displays) console.log(JSON.stringify(d));
	} else if (command === "pick") {
		const nums = (v: string) => v.split(",").map(Number);
		const steps: PickStep[] = [];
		if (values.drag) {
			const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = nums(values.drag);
			steps.push(...dragSteps({ x: x1, y: y1 }, { x: x2, y: y2 }));
		}
		if (values.click) {
			const [x = 0, y = 0] = nums(values.click);
			steps.push({ move: { x, y } }, { down: { x, y } }, { up: { x, y } });
		}
		for (const key of values.keys ? values.keys.split(",") : []) steps.push({ key });
		const mode = values.mode === "live" ? "live" : "snip";
		const r = await runPick(source, steps, { mode });
		if (r.frame && onFrame) {
			onFrame(r.frame, { index: 0 } as FrameReport);
		}
		if (values.json)
			console.log(
				JSON.stringify(
					{ ...r, frame: r.frame ? { width: r.frame.width, height: r.frame.height, scale: r.frame.scale } : null },
					null,
					2,
				),
			);
		else {
			console.log(
				`pick ${mode}: ${r.outcome ? (r.outcome.kind === "confirmed" ? "confirmed" : `cancelled (${r.outcome.reason})`) : "still open"}`,
			);
			if (r.region) {
				console.log(
					`  rect ${JSON.stringify(r.region.rect)} source ${r.region.source}, ${r.region.pieces.length} piece(s)`,
				);
				for (const p of r.region.pieces)
					console.log(
						`    display ${p.displayId} @${p.scale}x local ${JSON.stringify(p.local)} px ${JSON.stringify(p.physical)}`,
					);
			}
			if (r.frame) console.log(`  captured ${r.frame.width}x${r.frame.height} @${r.frame.scale}x`);
			console.log(
				`  states ${JSON.stringify(r.statesPerDisplay)}, loupe patches ${r.loupes}, overlays hidden: ${r.overlaysHidden}`,
			);
		}
		if (!r.outcome) process.exitCode = 1;
	} else if (command === "windows" || command === "loupe") {
		const natives = createPickerNatives({ capture: source, shellDisplays: () => source.displays() });
		console.log(natives.status);
		if (command === "windows") {
			const windows = await natives.windows.list();
			if (values.json) console.log(JSON.stringify(windows, null, 2));
			else for (const w of windows) console.log(`z${w.z} ${w.appName} (pid ${w.pid}) ${JSON.stringify(w.rect)}`);
		} else {
			const [ax, ay] = (values.at ?? "").split(",").map(Number);
			const at =
				ax !== undefined && ay !== undefined && Number.isFinite(ax) && Number.isFinite(ay)
					? { x: ax, y: ay }
					: primary
						? { x: primary.bounds.x + primary.bounds.width / 2, y: primary.bounds.y + primary.bounds.height / 2 }
						: { x: 0, y: 0 };
			const count = num(values.count, "count") ?? 30;
			const times: number[] = [];
			let last = null;
			for (let i = 0; i < count; i++) {
				const t0 = performance.now();
				last = await natives.sampler.sample(at, 15);
				times.push(performance.now() - t0);
				if (values.realtime) await Bun.sleep(33);
			}
			natives.sampler.stop();
			const sorted = [...times].sort((a, b) => a - b);
			const p = (q: number) => (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(1);
			const c = last ? [...last.rgba.subarray((7 * 15 + 7) * 4, (7 * 15 + 7) * 4 + 3)] : null;
			console.log(
				`loupe at ${at.x},${at.y}: ${last ? `display ${last.displayId}, centre rgb(${c?.join(", ")})` : "no pixels"}; ` +
					`${count} samples, p50 ${p(0.5)} ms, p95 ${p(0.95)} ms`,
			);
		}
	} else if (!rect) {
		throw new Error("no displays and no --rect");
	} else if (command === "snip") {
		const r = await runSnip(source, rect, { stages, ...(scale ? { scale } : {}), ...(onFrame ? { onFrame } : {}) });
		console.log(
			values.json ? JSON.stringify(r, null, 2) : `snip ${source.backend} ${values.rect ?? "primary"}: ${line(r.frame)}`,
		);
		if (!values.json) for (const l of pipelineLines(r.frame)) console.log(l);
	} else {
		const fps = num(values.fps, "fps") ?? 4;
		const count = num(values.count, "count") ?? source.frameCount ?? 8;
		const r = await runLive(source, rect, {
			fps,
			count,
			realtime: values.realtime,
			stages,
			...(scale ? { scale } : {}),
			...(onFrame ? { onFrame } : {}),
		});
		if (values.json) {
			console.log(JSON.stringify(r, null, 2));
		} else {
			console.log(`live ${source.backend} ${values.rect ?? "primary"} at ${fps} fps:`);
			for (const f of r.frames) {
				console.log(`  ${line(f)}`);
				for (const l of pipelineLines(f)) console.log(l);
			}
			console.log(`  ${r.summary.captured} frames, ${r.summary.changed} new, ${r.summary.unchanged} unchanged`);
		}
	}
	if (saved > 0) console.log(`saved ${saved} PNG(s) to ${resolve(values.out as string)}`);
} catch (e) {
	console.error(`[harness] ${isCaptureError(e) ? `${e.code}: ` : ""}${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 1;
} finally {
	await translator?.dispose();
	await ocrProvider?.dispose();
	source.dispose();
}
