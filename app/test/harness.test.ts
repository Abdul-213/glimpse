// The headless harness (GLIM-86): runner functions and the CLI as CI runs it.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { languageCode, rect } from "@glimpse/core";
import {
	FakeOcrProvider,
	FakeTranslationProvider,
	ocrBlock,
	ReplayCaptureSource,
	solidImage,
} from "@glimpse/core/testing";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { type PipelineBlock, pipelineStage, runLive, runSnip } from "../src/harness/run.ts";

describe("harness runner", () => {
	test("snip runs stages on the captured frame", async () => {
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const seen: number[] = [];
		const r = await runSnip(src, rect(20, 15, 160, 90), {
			stages: [
				{
					name: "size",
					run: (f) => {
						seen.push(f.width);
						return { w: f.width, h: f.height };
					},
				},
			],
		});
		expect(r.backend).toBe("file");
		expect(r.frame).toMatchObject({ width: 320, height: 180, scale: 2, sequenceChanged: true, partial: false });
		expect(r.frame.stages).toEqual({ size: { w: 320, h: 180 } });
		expect(seen).toEqual([320]);
	});

	test("live reports new vs unchanged frames and closes the session", async () => {
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const r = await runLive(src, rect(0, 0, 360, 120), { fps: 4, count: 5 });
		expect(r.frames.map((f) => f.sequenceChanged)).toEqual([true, true, false, true, false]);
		expect(r.frames.map((f) => f.pixelsChanged)).toEqual([true, true, false, true, false]);
		expect(r.summary).toEqual({ captured: 5, changed: 3, unchanged: 2 });
	});

	test("realtime mode sleeps 1/fps between frames and passes `previous` to stages", async () => {
		const src = new ReplayCaptureSource([solidImage(4, 4, [1, 2, 3])]);
		const sleeps: number[] = [];
		const previous: (number | null)[] = [];
		await runLive(src, rect(0, 0, 4, 4), {
			fps: 4,
			count: 3,
			realtime: true,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			stages: [{ name: "prev", run: (_f, ctx) => previous.push(ctx.previous?.sequence ?? null) }],
		});
		expect(sleeps).toEqual([250, 250]);
		expect(previous).toEqual([null, 1, 1]);
	});
});

describe("harness pipeline: frames -> OCR -> language -> translation -> result", () => {
	test("Live over the recording translates each frame's blocks, headless", async () => {
		// Scripted OCR: the caption changes between frames 1 and 2 (like the sample recording).
		const captions = ["こんにちは", "ありがとう", "ありがとう", "ありがとう"];
		let call = 0;
		const ocr = new FakeOcrProvider({
			blocks: (req) => {
				const text = captions[call++] ?? "";
				return [
					ocrBlock("title", "Settings", rect(0, 0, req.image.width, 20)),
					ocrBlock("caption", text, rect(0, 30, req.image.width, 20)),
					ocrBlock("count", "42", rect(0, 60, 40, 20)),
				];
			},
		});
		const translation = new FakeTranslationProvider();
		await ocr.init();
		await translation.init();
		const detect = (text: string) =>
			/^\d+$/.test(text) ? null : /[぀-ヿ]/.test(text) ? languageCode("ja") : languageCode("en");

		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const r = await runLive(src, rect(0, 0, 360, 120), {
			fps: 4,
			count: 2,
			stages: [pipelineStage({ ocr, detect, translation, to: languageCode("en") })],
		});
		const blocks = r.frames.map((f) => (f.stages["pipeline"] as { blocks: PipelineBlock[] }).blocks);
		expect(blocks[0]?.map((b) => [b.id, b.from, b.translation])).toEqual([
			["title", "en", "Settings"],
			["caption", "ja", "こんにちは [ja>en]"],
			["count", null, null],
		]);
		expect(blocks[1]?.find((b) => b.id === "caption")?.translation).toBe("ありがとう [ja>en]");
		// OCR saw the real captured pixels: 720x240 RGBA at 2x.
		expect(ocr.calls[0]?.image).toMatchObject({ width: 720, height: 240, format: "rgba8" });
		expect(translation.calls.map((c) => c.segments.map((s) => s.id))).toEqual([["caption#0"], ["caption#0"]]);
	});
});

describe("harness CLI", () => {
	const cli = resolve(import.meta.dir, "../scripts/harness.ts");
	const run = (...args: string[]) =>
		Bun.spawnSync([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });

	test("live --json over the sample recording", () => {
		const p = run("live", "--rect", "0,0,360,120", "--json");
		expect(p.exitCode).toBe(0);
		const report = JSON.parse(p.stdout.toString());
		expect(report.mode).toBe("live");
		expect(report.summary).toEqual({ captured: 4, changed: 3, unchanged: 1 });
	});

	test("live --loop --json runs the core Live loop on virtual time (GLIM-48)", () => {
		const p = run("live", "--loop", "--fps", "3", "--rect", "0,0,360,120", "--json");
		expect(p.exitCode).toBe(0);
		const report = JSON.parse(p.stdout.toString());
		expect(report.mode).toBe("live-loop");
		expect(report.fps).toBe(3);
		// The sample holds 500/500/500/1000 ms (2.5 s) + 2 s: 3 fps until 2 s after the last change, then 1/s.
		const at = report.frames.map((f: { at: number }) => Math.round(f.at));
		expect(at.slice(0, 4)).toEqual([0, 333, 667, 1000]);
		expect(report.loop.newFrames).toBe(3);
		expect(report.loop.periodMs).toBe(1000);
	});

	test("a capture error exits 1 with the error code", () => {
		const p = run("snip", "--rect", "5000,5000,10,10");
		expect(p.exitCode).toBe(1);
		expect(p.stderr.toString()).toContain("no-display");
	});
});
