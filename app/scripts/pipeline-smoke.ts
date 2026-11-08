// End-to-end translation smoke over a build (GLIM-146): one Snip of a fixture image through the
// app's own translation service, with the inference Workers, onnxruntime and bundled models the
// build staged into dist/, laid out as in the app in a folder outside the repo (like
// bundle-smoke.ts) so no Worker can fall back on node_modules.
//
//   bun scripts/pipeline-smoke.ts [--packs <dir>] [--image <png>]
//
// The run is the composition root's (src/bun/index.ts) wiring, minus Electrobun: the provider
// registry and context (services/providers.ts) over a model manager whose bundled folder is the
// staged models/, the GLIM-56 grouper and GLIM-21 detection (pipeline-stages.ts), and
// TranslationService.snip() over a file capture of the image. The Japanese and German packs
// download from Mozilla's Remote Settings through the same path as the popup's Download button
// (TranslationPacks.download), into --packs (default ~/.cache/glimpse/pipeline-smoke, which CI
// caches; already-installed packs are reused). The main-process code itself runs from source.
//
// The fixture (test/fixtures/capture/mixed-ja-de) holds a Japanese paragraph, a German sentence,
// an English label and a number. Fails unless both are read, detected as ja and de, and come
// back as English containing the expected words.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	applySettingsPatch,
	createLogger,
	defaultSettings,
	formatLogRecord,
	languageCode,
	type PipelineResult,
	ProviderRegistry,
	rect,
} from "@glimpse/core";
import { MemorySecretStore } from "@glimpse/core/testing";
import { FASTTEXT_MODEL_ID } from "@glimpse/providers/language-detect";
import { platform } from "../src/bun/platform.ts";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { catalogueCacheFile } from "../src/bun/services/models/paths.ts";
import { OCR_WORKER_FILE } from "../src/bun/services/ocr/paddle-worker.ts";
import { type AppProviderContext, providerContext, registerProviders } from "../src/bun/services/providers.ts";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { ModelManagerPackSource } from "../src/bun/services/translation/bergamot-packs.ts";
import { BERGAMOT_WORKER_FILE } from "../src/bun/services/translation/bergamot-worker.ts";
import { loadPackCatalogue } from "../src/bun/services/translation/pack-catalogue.ts";
import { pipelineStages } from "../src/bun/services/translation/pipeline-stages.ts";
import { TranslationPacks } from "../src/bun/services/translation/translation-packs.ts";
import { TranslationService, warmPairsFor } from "../src/bun/services/translation/translation-service.ts";

/** What the fixture says, and words its English translation must contain (any one per group). */
const EXPECTED = [
	{ lang: "ja", read: /会議/, words: [/meeting/i, /folder/i] },
	{ lang: "de", read: /Datei konnte nicht gespeichert/, words: [/file/i, /sav/i] },
] as const;
const PACKS = ["bergamot-ja-en", "bergamot-de-en"];

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { packs: { type: "string" }, image: { type: "string" } },
});
const dist = resolve(import.meta.dir, "..", "dist");
const image = resolve(
	values.image ?? join(import.meta.dir, "..", "test", "fixtures", "capture", "mixed-ja-de", "mixed-ja-de.png"),
);
const packRoot = resolve(values.packs ?? join(homedir(), ".cache", "glimpse", "pipeline-smoke"));
const appDir = mkdtempSync(join(tmpdir(), "glimpse-pipeline-smoke-"));
const mainDir = join(appDir, "bun");

const fail = (msg: string): never => {
	throw new Error(msg);
};
const lines: string[] = [];
const log = createLogger({ level: "info", sinks: [{ write: (r) => lines.push(formatLogRecord(r)) }] });
let service: TranslationService<AppProviderContext> | null = null;
let packSource: ModelManagerPackSource | null = null;

try {
	// The build's layout (electrobun.config.ts `copy`).
	for (const file of [OCR_WORKER_FILE, BERGAMOT_WORKER_FILE]) {
		if (!existsSync(join(dist, "workers", file))) fail(`no dist/workers/${file}: build the app first`);
		cpSync(join(dist, "workers", file), join(mainDir, file));
	}
	if (existsSync(join(dist, "fasttext"))) cpSync(join(dist, "fasttext"), mainDir, { recursive: true });
	cpSync(join(dist, "onnxruntime"), join(appDir, "native", "onnxruntime"), { recursive: true });
	cpSync(join(dist, "models"), join(appDir, "models"), { recursive: true });

	const registry = new ProviderRegistry<AppProviderContext>();
	registerProviders(registry);
	const env = settingsEnvFor(platform, "en-US", registry);
	const settings = applySettingsPatch(defaultSettings(env), { language: { target: languageCode("en") } }, env).settings;

	const models = new ModelManager({ root: packRoot, bundledDir: join(appDir, "models") });
	await models.scan();
	packSource = new ModelManagerPackSource(models);
	const packs = packSource;
	const ctx = providerContext({
		packs,
		models,
		mainDir,
		warmPairs: () => warmPairsFor(settings),
		log: log.child("translation"),
		secrets: new MemorySecretStore(),
		// No GLIMPSE_* overrides: only the staged Workers.
		env: {},
	});
	if (ctx.ocrWorker !== join(mainDir, OCR_WORKER_FILE)) fail(`OCR Worker not taken from the bundle: ${ctx.ocrWorker}`);
	if (ctx.bergamotWorker !== join(mainDir, BERGAMOT_WORKER_FILE)) {
		fail(`Bergamot Worker not taken from the bundle: ${ctx.bergamotWorker}`);
	}
	const stages = pipelineStages(log.child("translation"), {
		fastTextDir: () => models.modelDir(FASTTEXT_MODEL_ID),
		mainDir,
	});
	const translation: TranslationService<AppProviderContext> = new TranslationService({
		registry,
		ctx: ctx.ctx,
		settings: () => settings,
		log: log.child("translation"),
		readinessOf: (from, to) => packsApi.readiness(from, to),
		...stages,
	});
	service = translation;
	const packsApi = new TranslationPacks({ manager: models, packs, chain: () => translation.chain });

	// Packs: the catalogue from Remote Settings, then the popup's download path.
	const t0 = performance.now();
	const source = await loadPackCatalogue(packs, catalogueCacheFile(packRoot), { refresh: true, log });
	if (source === "none") fail("could not load the pack catalogue from Remote Settings (network?)");
	const states = await packsApi.download(PACKS);
	states.forEach((s, i) => {
		if (s.status !== "installed") fail(`${PACKS[i]} did not install: ${JSON.stringify(s)}`);
	});
	const packMs = Math.round(performance.now() - t0);

	const t1 = performance.now();
	await Promise.all([stages.detector.load(), translation.start()]);
	const startMs = Math.round(performance.now() - t1);
	const ocr = translation.ocr;
	if (ocr?.status.state !== "ready") fail(`OCR provider not ready: ${ocr?.info.id} ${ocr?.status.state}`);
	const bergamot = translation.chain.find((p) => p.info.id === "bergamot");
	if (bergamot?.status.state !== "ready") fail(`Bergamot not ready: ${bergamot?.status.state ?? "absent"}`);

	const capture = createFileCaptureSource(image);
	const display = (await capture.displays())[0] ?? fail("the file capture has no display");
	const whole = rect(0, 0, display.bounds.width, display.bounds.height);
	const result: PipelineResult = await translation.snip(capture, whole, () => {});
	if (result.error) fail(`the pipeline failed: ${JSON.stringify(result.error)}`);

	const rows = result.blocks.map((b) => ({
		lang: b.lang,
		cls: b.cls,
		text: b.text,
		translation: result.translations[b.id]?.text ?? null,
		failure: result.translations[b.id]?.failure?.error.code ?? null,
	}));
	console.log(JSON.stringify({ packs: source, packMs, startMs, timings: result.timings, blocks: rows }, null, 2));

	for (const want of EXPECTED) {
		const block =
			rows.find((r) => want.read.test(r.text.replace(/\s+/g, " "))) ??
			fail(`the ${want.lang} text was not read (OCR read: ${JSON.stringify(rows.map((r) => r.text))})`);
		if (block.lang !== want.lang) fail(`"${block.text}" was detected as ${block.lang}, expected ${want.lang}`);
		const english =
			block.translation?.trim() ||
			fail(`no translation for the ${want.lang} block (${block.cls}${block.failure ? `, ${block.failure}` : ""})`);
		for (const word of want.words) {
			if (!word.test(english)) fail(`${want.lang}→en "${english}" does not match ${word}`);
		}
	}
	console.log("pipeline-smoke: ok");
} catch (error) {
	console.error(`pipeline-smoke: ${error instanceof Error ? error.message : String(error)}`);
	if (lines.length > 0) console.error(`--- log\n${lines.join("\n")}`);
	process.exitCode = 1;
} finally {
	await service?.dispose();
	packSource?.dispose();
	rmSync(appDir, { recursive: true, force: true });
}
