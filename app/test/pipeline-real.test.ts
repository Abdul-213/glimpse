// End to end on Linux (GLIM-102): file-based capture of the sample recording -> scripted OCR
// -> core pipeline (detection, sentence split, cache, English pivot) -> the real Bergamot
// provider in its real Worker. Skipped unless GLIMPSE_REAL_PACKS=1 (CI never downloads packs):
//   GLIMPSE_REAL_PACKS=1 bun test app/test/pipeline-real.test.ts
// Packs install once into ~/.cache/glimpse/test-installs through the real model manager
// (the same folder app/test/bergamot-real.test.ts uses), then are reused offline.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { languageCode, rect, TranslationCache } from "@glimpse/core";
import { loadManifest } from "../scripts/model-cache.ts";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { loadBergamotCatalogue, manifestInstallable, packInstallable } from "../src/bun/services/models/catalogue.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { RUNTIME_MODEL_ID } from "../src/bun/services/translation/bergamot-packs.ts";
import { bergamotTranslator, defaultPackRoot, type HarnessTranslator, scriptedOcr } from "../src/harness/providers.ts";
import { type PipelineStageReport, pipelineStage, runLive, runSnip } from "../src/harness/run.ts";

const enabled = process.env["GLIMPSE_REAL_PACKS"] === "1";
const L = languageCode;
const PACKS = ["bergamot-ja-en", "bergamot-en-de", "bergamot-de-en"];

let translator: HarnessTranslator;

beforeAll(async () => {
	if (!enabled) return;
	const root = defaultPackRoot();
	const manager = new ModelManager({ root });
	await manager.scan();
	const missing = PACKS.filter((id) => manager.state(id).status !== "installed");
	if (manager.state(RUNTIME_MODEL_ID).status !== "installed") {
		const runtime = loadManifest().models.find((m) => m.id === RUNTIME_MODEL_ID);
		if (!runtime) throw new Error("manifest has no bergamot-runtime");
		await manager.install(manifestInstallable(runtime));
	}
	if (missing.length > 0) {
		const catalogue = await loadBergamotCatalogue({ cacheFile: join(root, ".catalogue.json") });
		for (const id of missing) {
			const pack = catalogue.packs.find((p) => p.id === id);
			if (!pack) throw new Error(`catalogue has no ${id}`);
			await manager.install(packInstallable(pack));
		}
	}
	translator = await bergamotTranslator(root, [{ from: L("ja"), to: L("en") }]);
}, 600_000);

afterAll(() => translator?.dispose());

describe.skipIf(!enabled)("pipeline on real Bergamot packs (harness, Linux)", () => {
	const text = [
		"明日の会議は午後三時に始まります。請求書を保存しました。",
		"42",
		"Die Datei konnte nicht gespeichert werden.",
	];

	test("Snip: ja→de through the English pivot, German source to English, neutral as-is, no network", async () => {
		const realFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.reject(new Error("offline"));
		}) as unknown as typeof fetch;
		try {
			const ocr = scriptedOcr(text);
			await ocr.init();
			const cache = new TranslationCache();
			const stage = (to: string, sources: string[]) =>
				pipelineStage({ ocr, translation: translator.provider, to: L(to), sources: sources.map(L), cache });
			const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
			const de = await runSnip(src, rect(0, 0, 200, 120), { stages: [stage("de", ["ja", "de"])] });
			const p = de.frame.stages["pipeline"] as PipelineStageReport;
			console.log(`pipeline real snip ja→de: ${p.timings.totalMs} ms, ${p.events.join(" → ")}`);
			expect(p.error).toBeNull();
			expect(p.blocks.map((b) => b.cls)).toEqual(["translate", "neutral", "target"]);
			expect(p.blocks[0]?.translation).toMatch(/Treffen|Sitzung|Besprechung/);
			expect(p.blocks[0]?.translation).toMatch(/Rechnung/);
			expect(p.blocks[2]?.translation).toBe(text[2] ?? "");

			const en = await runSnip(src, rect(0, 0, 200, 120), { stages: [stage("en", ["ja", "de"])] });
			const q = en.frame.stages["pipeline"] as PipelineStageReport;
			expect(q.blocks.map((b) => b.cls)).toEqual(["translate", "neutral", "translate"]);
			expect(q.blocks[0]?.translation).toMatch(/meeting/i);
			// ja→en sentences were cached as the first hop of ja→de.
			expect(q.blocks[0]?.remembered).toBe(true);
			expect(q.blocks[2]?.translation).toMatch(/file/i);
			expect(fetchCalls).toBe(0);
			src.dispose();
		} finally {
			globalThis.fetch = realFetch;
		}
	}, 120_000);

	test("Live: repeat frames are served from the cache", async () => {
		const ocr = scriptedOcr(text);
		await ocr.init();
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const r = await runLive(src, rect(0, 0, 200, 120), {
			fps: 4,
			count: 3,
			stages: [pipelineStage({ ocr, translation: translator.provider, to: L("en"), sources: [L("ja"), L("de")] })],
		});
		const reports = r.frames.map((f) => f.stages["pipeline"] as PipelineStageReport);
		expect(reports[0]?.blocks[0]?.remembered).toBe(false);
		expect(reports[1]?.blocks[0]?.remembered).toBe(true);
		expect(reports[2]?.blocks[0]?.translation).toBe(reports[0]?.blocks[0]?.translation ?? "");
		src.dispose();
	}, 120_000);
});
