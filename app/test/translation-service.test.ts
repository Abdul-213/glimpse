// GLIM-101/102: the app's translation service (providers from settings, pipeline, caches,
// Private) and the composition-root pieces around it, with fake providers.
import { describe, expect, test } from "bun:test";
import {
	applySettingsPatch,
	type CaptureFrame,
	createLogger,
	defaultSettings,
	languageCode,
	type PipelineEvent,
	ProviderRegistry,
	rect,
	type Settings,
} from "@glimpse/core";
import { fakeOcrFactory, fakeTranslationFactory, MemoryLogSink, ocrBlock } from "@glimpse/core/testing";
import { bergamotFactory } from "@glimpse/providers/translation/bergamot";
import { CommandBus } from "../src/bun/commands.ts";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { loadPackCatalogue } from "../src/bun/services/translation/pack-catalogue.ts";
import { TranslationService, warmPairsFor } from "../src/bun/services/translation/translation-service.ts";

const L = languageCode;
const frame: CaptureFrame = {
	width: 100,
	height: 40,
	data: new Uint8Array(100 * 40 * 4).fill(200),
	rect: rect(0, 0, 100, 40),
	scale: 1,
	displayIds: [1],
	partial: false,
	sequence: 1,
	capturedAt: 0,
};
const capture = { capture: async () => frame };

function setup(patch: Record<string, unknown> = {}) {
	const registry = new ProviderRegistry<unknown>();
	registry.register(fakeOcrFactory({ id: "fake-ocr", blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))] }));
	registry.register(fakeTranslationFactory({ id: "fake-translation" }));
	const env = settingsEnvFor("windows", "en-US", registry);
	let settings: Settings = applySettingsPatch(
		defaultSettings(env),
		{ providers: { ocr: "fake-ocr", translation: ["fake-translation"] }, ...patch },
		env,
	).settings;
	const sink = new MemoryLogSink();
	const privateChanges: boolean[] = [];
	const service = new TranslationService({
		registry,
		ctx: {},
		settings: () => settings,
		log: createLogger({ sinks: [sink], level: "debug" }),
		onPrivateChange: (on) => privateChanges.push(on),
	});
	return { service, sink, privateChanges, setSettings: (s: Settings) => (settings = s) };
}

describe("TranslationService", () => {
	test("start() builds the configured providers and loads them; Snip translates and caches", async () => {
		const { service, sink } = setup();
		await service.start();
		expect(service.ocr?.status.state).toBe("ready");
		expect(service.chain.map((p) => p.info.id)).toEqual(["fake-translation"]);
		expect(sink.records.some((r) => r.message === "provider init")).toBe(true);

		const events: PipelineEvent[] = [];
		const result = await service.snip(capture, rect(0, 0, 100, 40), (e) => events.push(e));
		expect(result.translations["b1"]?.text).toBe("こんにちは [ja>en]");
		expect(events[0]?.type).toBe("started");
		expect(service.caches.app.stats().entries).toBe(1);
		// The cache.clear command.
		service.clearCache("user");
		expect(service.caches.app.stats().entries).toBe(0);
		await service.dispose();
	});

	test("Private: Snips cache nothing; the toggle notifies the tray and moves Live sessions", async () => {
		const { service, privateChanges } = setup();
		await service.start();
		service.setPrivate(true);
		expect(privateChanges).toEqual([true]);
		const r = await service.snip(capture, rect(0, 0, 100, 40), () => {});
		expect(r.private).toBe(true);
		expect(service.caches.app.stats().entries).toBe(0);

		const session = service.openLive(() => {});
		expect(session.private).toBe(true);
		service.setPrivate(false);
		expect(session.private).toBe(false);
		session.close();
		await service.dispose();
	});

	test("privateByDefault starts in Private", () => {
		const { service } = setup({ privacy: { privateByDefault: true } });
		expect(service.private).toBe(true);
	});

	test("cache.clear and private.toggle through the command bus", async () => {
		const { service } = setup();
		await service.start();
		const bus = new CommandBus(createLogger({ sinks: [] }));
		bus.handle("cache.clear", () => service.clearCache("user"));
		bus.handle("private.toggle", () => service.setPrivate(!service.private));
		await service.snip(capture, rect(0, 0, 100, 40), () => {});
		expect(service.caches.app.stats().entries).toBe(1);
		expect(await bus.dispatch("cache.clear", "tray")).toBe(true);
		expect(service.caches.app.stats().entries).toBe(0);
		await bus.dispatch("private.toggle", "tray");
		expect(service.private).toBe(true);
		await service.dispose();
	});
});

test("warmPairsFor: the user's sources to the target, target itself dropped", () => {
	const reg = new ProviderRegistry<unknown>();
	const env = settingsEnvFor("windows", "de-DE", reg);
	const s = applySettingsPatch(
		defaultSettings(env),
		{ language: { target: L("de"), sources: [L("ja"), L("de"), L("en")] } },
		env,
	).settings;
	expect(warmPairsFor(s)).toEqual([
		{ from: L("ja"), to: L("de") },
		{ from: L("en"), to: L("de") },
	]);
});

test("Bergamot is registered with the default chain id", () => {
	expect(bergamotFactory().info.id).toBe("bergamot");
});

describe("loadPackCatalogue", () => {
	test("no cache and no network: none, never throws", async () => {
		const set: unknown[] = [];
		const source = await loadPackCatalogue({ setCatalogue: (p) => set.push(p) }, "/nonexistent/glimpse/cat.json", {
			refresh: true,
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(source).toBe("none");
		expect(set).toEqual([]);
	});
});
