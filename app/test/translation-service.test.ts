// GLIM-101/102/108: the app's translation service (providers from settings, pipeline, caches,
// Private, settings changes at runtime) and the composition-root pieces around it, with fake
// providers.
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
	type SettingsPatch,
	toOcrImage,
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
	registry.register(fakeTranslationFactory({ id: "fake-two", name: "Second", defaultRank: null }));
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
	/** Change settings like AppSettings.update does, and tell the service. */
	const change = async (p: SettingsPatch) => {
		const previous = settings;
		settings = applySettingsPatch(previous, p, env).settings;
		await service.applySettings(settings, previous);
	};
	return { service, sink, privateChanges, change, setSettings: (s: Settings) => (settings = s) };
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

describe("TranslationService: settings changes at runtime (GLIM-108)", () => {
	const snipProvider = async (service: TranslationService<unknown>) =>
		(await service.snip(capture, rect(0, 0, 100, 40), () => {})).translations["b1"]?.provider?.id;

	test("a new chain takes effect on the next Snip; unchanged providers are kept, dropped ones disposed", async () => {
		const { service, change } = setup();
		await service.start();
		const ocr = service.ocr;
		const first = service.chain[0];
		expect(await snipProvider(service)).toBe("fake-translation");

		await change({ providers: { translation: ["fake-two", "fake-translation"] } });
		expect(service.chain.map((p) => p.info.id)).toEqual(["fake-two", "fake-translation"]);
		expect(service.chain[1]).toBe(first); // same instance, models stay loaded
		expect(service.chain[0]?.status.state).toBe("ready");
		expect(service.ocr).toBe(ocr);
		service.clearCache("user");
		expect(await snipProvider(service)).toBe("fake-two");

		const two = service.chain[0];
		await change({ providers: { translation: ["fake-translation"] } });
		expect(two?.status.state).toBe("disposed");
		expect(service.chain).toEqual(first ? [first] : []);
		await service.dispose();
	});

	test("changed provider options rebuild that provider", async () => {
		const { service, change } = setup();
		await service.start();
		const before = service.chain[0];
		await change({ providers: { options: { "fake-translation": { quality: "best" } } } });
		expect(service.chain[0]).not.toBe(before);
		expect(service.chain[0]?.status.state).toBe("ready");
		expect(before?.status.state).toBe("disposed");
		await service.dispose();
	});

	test("target and sources update running Live sessions and re-warm the chain; Snip follows", async () => {
		const { service, change } = setup();
		await service.start();
		const translator = service.chain[0] as unknown as { warmupCalls: number };
		const warmed = translator.warmupCalls;
		const session = service.openLive(() => {});
		const image = toOcrImage(frame);
		const text = async () => {
			const r = await session.process(image);
			const block = r?.blocks[0];
			return block ? (r?.translations[block.id]?.text ?? block.cls) : null;
		};
		expect(await text()).toBe("こんにちは [ja>en]");

		await change({ language: { target: L("de") } });
		expect(await text()).toBe("こんにちは [ja>de]");
		expect(translator.warmupCalls).toBe(warmed + 1);
		expect((await service.snip(capture, rect(0, 0, 100, 40), () => {})).translations["b1"]?.text).toBe(
			"こんにちは [ja>de]",
		);

		await change({ language: { sources: [L("ko")] } });
		expect(await text()).toBe("skip");
		session.close();
		await service.dispose();
	});

	test("idle-wipe minutes go to the caches; before start() provider changes wait for start", async () => {
		const { service, change } = setup();
		const minutes: number[] = [];
		service.caches.setIdleMinutes = (m: number) => minutes.push(m);
		await change({ privacy: { clearCacheAfterIdleMinutes: 5 }, providers: { translation: ["fake-two"] } });
		expect(minutes).toEqual([5]);
		expect(service.chain).toEqual([]);
		await service.start();
		expect(service.chain.map((p) => p.info.id)).toEqual(["fake-two"]);
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
