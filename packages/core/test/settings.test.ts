import { describe, expect, test } from "bun:test";
import {
	applySettingsPatch,
	canonicalHotkey,
	DEFAULT_HOTKEYS,
	defaultSettings,
	defaultTargetLanguage,
	hotkeyProblem,
	type JsonObject,
	type JsonValue,
	languageCode,
	loadSettings,
	type Migration,
	MigrationError,
	ProviderRegistry,
	parseSettings,
	runMigrations,
	SETTINGS_MIGRATIONS,
	SETTINGS_VERSION,
	type SettingsEnv,
	saveSettings,
	serializeSettings,
} from "../src/index.ts";
import { fakeOcrFactory, fakeTranslationFactory, MemorySettingsStore } from "../src/testing/index.ts";

const registry = new ProviderRegistry()
	.register(fakeOcrFactory({ id: "paddleocr", defaultRank: 0 }))
	.register(fakeTranslationFactory({ id: "bergamot", defaultRank: 10 }))
	.register(fakeTranslationFactory({ id: "small100", defaultRank: 20 }))
	.register(fakeTranslationFactory({ id: "cloud:google-translate-v2", kind: "cloud" }));

const env: SettingsEnv = {
	hotkeys: DEFAULT_HOTKEYS.windows,
	providers: registry.configSchema(),
	targetLanguage: languageCode("de"),
};

describe("settings defaults", () => {
	test("first-run settings", () => {
		expect(defaultSettings(env)).toEqual({
			language: { target: languageCode("de"), sources: [] },
			hotkeys: {
				snip: "Alt+Shift+S",
				live: "Alt+Shift+L",
				pauseLive: null,
				resnip: null,
				toggleLivePopup: null,
				focusLivePopup: null,
				refreshLive: null,
			},
			providers: { ocr: "paddleocr", translation: ["bergamot", "small100"], options: {} },
			appearance: { theme: "system", motion: "system" },
			snip: { copyAfterSnip: true, showOriginalUnder: false, alwaysShowLanguages: false, showOnScreen: false },
			picker: { showLoupe: true, confirmOnRelease: true },
			live: {
				fps: 3,
				diffThreshold: 0.02,
				stabilityMs: 300,
				announceChanges: "auto",
				update: "text",
				popupOffsets: [],
			},
			privacy: {
				privateByDefault: false,
				clearCacheAfterIdleMinutes: 15,
				clearCacheOnLock: true,
				hideFromCapture: true,
			},
			system: { launchAtLogin: false },
			cloud: { liveConsent: [], spendCap: "freeTier" },
			models: { directory: null },
			onboarding: { completed: false, step: "welcome", dismissed: false, languages: [], overlayHintSeen: false },
			permissions: { screenAccess: "unknown" },
			diagnostics: { logLevel: "info" },
			updates: { check: true },
		});
	});

	test("macOS gets ⌃⇧S / ⌃⇧L (GLIM-23)", () => {
		const mac = defaultSettings({ ...env, hotkeys: DEFAULT_HOTKEYS.macos });
		expect(mac.hotkeys.snip).toBe("Ctrl+Shift+S");
		expect(mac.hotkeys.live).toBe("Ctrl+Shift+L");
	});

	test("serialise then parse is lossless and versioned", () => {
		const s = applySettingsPatch(
			defaultSettings(env),
			{
				language: { sources: [languageCode("ja"), languageCode("ko")] },
				live: { fps: 2 },
				providers: { translation: ["cloud:google-translate-v2", "bergamot"] },
				onboarding: { completed: true },
			},
			env,
		).settings;
		const text = serializeSettings(s);
		const json = JSON.parse(text);
		expect(json.version).toBe(SETTINGS_VERSION);
		expect(text.endsWith("\n")).toBe(true);
		const back = parseSettings(json, env);
		expect(back.issues).toEqual([]);
		expect(back.settings).toEqual(s);
	});

	test("default target language from the OS locale", () => {
		expect(defaultTargetLanguage("de-AT")).toBe(languageCode("de"));
		expect(defaultTargetLanguage("zh-TW")).toBe(languageCode("zh-Hant"));
		expect(defaultTargetLanguage("zh-CN")).toBe(languageCode("zh-Hans"));
		expect(defaultTargetLanguage("zh")).toBe(languageCode("zh-Hans"));
		expect(defaultTargetLanguage("pt_BR")).toBe(languageCode("pt"));
		expect(defaultTargetLanguage(undefined)).toBe(languageCode("en"));
		expect(defaultTargetLanguage("garbage tag")).toBe(languageCode("en"));
	});
});

describe("hotkeys", () => {
	test("canonicalises modifier order, case and aliases", () => {
		expect(canonicalHotkey("shift+alt+s")).toBe("Alt+Shift+S");
		expect(canonicalHotkey("Cmd+Shift+1")).toBe("Shift+Meta+1");
		expect(canonicalHotkey("Control+Option+pageup")).toBe("Ctrl+Alt+PageUp");
		expect(canonicalHotkey("F9")).toBe("F9");
	});

	test("rejects keys that can't be global", () => {
		expect(hotkeyProblem("Esc")).toMatch(/can't be a global/);
		expect(hotkeyProblem("Alt+Enter")).toMatch(/can't be a global/);
		expect(hotkeyProblem("Ctrl+ArrowLeft")).toMatch(/can't be a global/);
		expect(hotkeyProblem("Shift+S")).toMatch(/Shift alone/);
		expect(hotkeyProblem("S")).toMatch(/needs/);
		expect(hotkeyProblem("Hyper+S")).toMatch(/unknown modifier/);
		expect(hotkeyProblem("Alt+Alt+S")).toMatch(/twice/);
		expect(hotkeyProblem("Alt+Shift+Ü")).toMatch(/unknown key/);
	});

	test("invalid combos reset to the default, null stays unbound, duplicates are unbound", () => {
		const { settings, issues } = parseSettings(
			{ hotkeys: { snip: "Esc", live: null, pauseLive: "alt+shift+s", resnip: "Ctrl+Alt+R" } },
			env,
		);
		expect(settings.hotkeys).toEqual({
			snip: "Alt+Shift+S",
			live: null,
			pauseLive: null,
			resnip: "Ctrl+Alt+R",
			toggleLivePopup: null,
			focusLivePopup: null,
			refreshLive: null,
		});
		expect(issues.map((i) => i.path)).toEqual(["hotkeys.snip", "hotkeys.pauseLive"]);
	});
});

describe("parseSettings repairs field by field", () => {
	test("bad values take defaults; good neighbours survive", () => {
		const { settings, issues } = parseSettings(
			{
				language: { target: "JA", sources: ["ko", "xx-not-a-tag!", "ko"] },
				live: { fps: 0, diffThreshold: 0.1, stabilityMs: 250.5 },
				appearance: { theme: "purple", motion: "reduced" },
				privacy: "everything",
				onboarding: { completed: true },
				unknownSection: { a: 1 },
			},
			env,
		);
		expect(settings.language).toEqual({ target: languageCode("ja"), sources: [languageCode("ko")] });
		expect(settings.live).toEqual({
			fps: 3,
			diffThreshold: 0.1,
			stabilityMs: 300,
			announceChanges: "auto",
			update: "text",
			popupOffsets: [],
		});
		expect(settings.appearance).toEqual({ theme: "system", motion: "reduced" });
		expect(settings.privacy.clearCacheAfterIdleMinutes).toBe(15);
		expect(settings.onboarding.completed).toBe(true);
		expect(issues.map((i) => i.path)).toEqual([
			"language.sources[1]",
			"language.sources[2]",
			"appearance.theme",
			"live.fps",
			"live.stabilityMs",
			"privacy",
		]);
	});
});

describe("live.popupOffsets (GLIM-151)", () => {
	test("valid entries kept, bad and duplicate ones dropped", () => {
		const { settings, issues } = parseSettings(
			{
				live: {
					popupOffsets: [
						{ display: "0,0,1440x900@2", dx: 40, dy: -120 },
						{ display: "0,0,1440x900@2", dx: 1, dy: 1 },
						{ display: "x", dx: 1.5, dy: 0 },
						"nope",
					],
				},
			},
			env,
		);
		expect(settings.live.popupOffsets).toEqual([{ display: "0,0,1440x900@2", dx: 40, dy: -120 }]);
		expect(issues.length).toBeGreaterThanOrEqual(3);
		expect(issues.every((i) => i.path.startsWith("live.popupOffsets"))).toBe(true);
	});
});

describe("applySettingsPatch", () => {
	test("applies valid changes and rejects invalid ones without touching the current value", () => {
		const current = defaultSettings(env);
		const ok = applySettingsPatch(current, { live: { fps: 4 }, appearance: { theme: "dark" } }, env);
		expect(ok.issues).toEqual([]);
		expect(ok.settings.live.fps).toBe(4);
		expect(ok.settings.appearance.theme).toBe("dark");
		expect(ok.settings.live.stabilityMs).toBe(300);

		const withFps = ok.settings;
		const bad = applySettingsPatch(
			withFps,
			{
				live: { fps: 1000 },
				hotkeys: { live: "Alt+Shift+S" },
				language: { sources: [languageCode("ja")] },
			},
			env,
		);
		expect(bad.settings.live.fps).toBe(4);
		expect(bad.settings.hotkeys.live).toBe("Alt+Shift+L");
		expect(bad.settings.language.sources).toEqual([languageCode("ja")]);
		expect(bad.issues.map((i) => i.path)).toEqual(["hotkeys.live", "live.fps"]);
	});
});

describe("migrations", () => {
	// A made-up history used to exercise the real runner and loader: v1 was flat, v2 nested
	// it, v3 (the "current" version in these tests) replaced a boolean with an enum.
	const testMigrations: Migration[] = [
		{
			from: 1,
			description: "nest flat keys",
			migrate: (old) => ({
				language: { target: old["targetLanguage"] ?? null, sources: old["sourceLanguages"] ?? [] },
				live: { fps: old["liveFps"] ?? null },
				appearance: { reduceMotion: old["reduceMotion"] ?? false },
			}),
		},
		{
			from: 2,
			description: "reduceMotion boolean -> motion enum",
			migrate: (old) => {
				const appearance = (old["appearance"] ?? {}) as JsonObject;
				const { reduceMotion, ...rest } = appearance;
				return { ...old, appearance: { ...rest, motion: reduceMotion === true ? "reduced" : "system" } };
			},
		},
	];

	test("runMigrations walks every step and stamps the version", () => {
		const out = runMigrations({ version: 1, targetLanguage: "fr", reduceMotion: true }, testMigrations, 3);
		expect(out.from).toBe(1);
		expect(out.applied).toEqual([1, 2]);
		expect(out.data).toEqual({
			version: 3,
			language: { target: "fr", sources: [] },
			live: { fps: null },
			appearance: { motion: "reduced" },
		});
		expect(runMigrations({ version: 3 }, testMigrations, 3).applied).toEqual([]);
	});

	test("missing steps and throwing migrations are MigrationErrors", () => {
		expect(() => runMigrations({ version: 1 }, testMigrations.slice(1), 3)).toThrow(MigrationError);
		const throwing: Migration[] = [
			{
				from: 1,
				description: "boom",
				migrate: () => {
					throw new Error("boom");
				},
			},
		];
		expect(() => runMigrations({}, throwing, 2)).toThrow(/1→2 failed: boom/);
	});

	test("loadSettings migrates an old file, backs it up and rewrites it", async () => {
		const v1 = { version: 1, targetLanguage: "fr", sourceLanguages: ["ja", "ko"], liveFps: 2, reduceMotion: true };
		const store = new MemorySettingsStore(JSON.stringify(v1));
		const loaded = await loadSettings(store, env, { version: 3, migrations: testMigrations });
		expect(loaded.source).toBe("migrated");
		expect(loaded.fileVersion).toBe(1);
		expect(loaded.settings.language).toEqual({
			target: languageCode("fr"),
			sources: [languageCode("ja"), languageCode("ko")],
		});
		expect(loaded.settings.live.fps).toBe(2);
		expect(loaded.settings.appearance.motion).toBe("reduced");
		expect(loaded.settings.hotkeys.snip).toBe("Alt+Shift+S"); // new section, default
		expect(store.backups.map((b) => b.reason)).toEqual(["pre-migration"]);
		expect(JSON.parse(store.backups[0]?.contents ?? "null")).toEqual(v1);
		expect((store.json() as { version: number }).version).toBe(3);
		// Loading again is a plain load.
		const again = await loadSettings(store, env, { version: 3, migrations: testMigrations });
		expect(again.source).toBe("file");
		expect(again.settings).toEqual(loaded.settings);
	});

	test("a failing migration recovers to defaults and keeps the file", async () => {
		const store = new MemorySettingsStore(JSON.stringify({ version: 1, liveFps: 2 }));
		const loaded = await loadSettings(store, env, { version: 3, migrations: testMigrations.slice(0, 1) });
		expect(loaded.source).toBe("recovered");
		expect(loaded.settings).toEqual(defaultSettings(env));
		expect(store.backups.map((b) => b.reason)).toEqual(["corrupt"]);
		expect(loaded.warnings[0]).toMatch(/no settings migration from version 2/);
	});
});

describe("shipped migrations", () => {
	const v1 = (translation: JsonValue): JsonObject => ({
		version: 1,
		providers: { ocr: "paddleocr", translation, options: {} },
	});
	const chainAfter = (input: JsonObject) => {
		const out = runMigrations(input, SETTINGS_MIGRATIONS, SETTINGS_VERSION).data;
		return (out["providers"] as JsonObject)["translation"];
	};

	test("every version below the current one has exactly one step", () => {
		for (let v = 1; v < SETTINGS_VERSION; v++) {
			expect(SETTINGS_MIGRATIONS.filter((m) => m.from === v)).toHaveLength(1);
		}
	});

	test("GLIM-139: an old file with [bergamot] loads as [bergamot, small100]", async () => {
		const text = await Bun.file(new URL("./fixtures/settings/v1-bergamot-only.json", import.meta.url)).text();
		const store = new MemorySettingsStore(text);
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("migrated");
		expect(loaded.fileVersion).toBe(1);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.settings.providers.translation).toEqual(["bergamot", "small100"]);
		// The rest of the file is untouched.
		expect(Object.keys(loaded.settings.providers.options)).toEqual(["bergamot"]);
		expect(loaded.settings.language.sources).toEqual([languageCode("ja")]);
		expect(loaded.settings.live.fps).toBe(2);
		expect(store.backups.map((b) => b.reason)).toEqual(["pre-migration"]);
		expect(store.json()).toMatchObject({
			version: SETTINGS_VERSION,
			providers: { translation: ["bergamot", "small100"] },
		});
	});

	test("GLIM-139: a cloud provider first stays first; small100 follows the last local one", () => {
		expect(chainAfter(v1(["cloud:google-translate-v2", "bergamot"]))).toEqual([
			"cloud:google-translate-v2",
			"bergamot",
			"small100",
		]);
		expect(chainAfter(v1(["bergamot", "nllb"]))).toEqual(["bergamot", "nllb", "small100"]);
		// A hand-edited local-then-cloud chain: small100 never lands after the cloud entry.
		expect(chainAfter(v1(["bergamot", "cloud:google-translate-v2"]))).toEqual([
			"bergamot",
			"small100",
			"cloud:google-translate-v2",
		]);
	});

	test("GLIM-139: chains without bergamot, with small100, or malformed are left alone", () => {
		expect(chainAfter(v1(["bergamot", "small100"]))).toEqual(["bergamot", "small100"]);
		expect(chainAfter(v1(["small100", "bergamot"]))).toEqual(["small100", "bergamot"]);
		expect(chainAfter(v1(["cloud:google-translate-v2"]))).toEqual(["cloud:google-translate-v2"]);
		expect(chainAfter(v1([]))).toEqual([]);
		expect(chainAfter(v1("bergamot"))).toBe("bergamot");
		const noProviders = runMigrations({ version: 1, live: { fps: 2 } }, SETTINGS_MIGRATIONS, SETTINGS_VERSION);
		expect(noProviders.data).toEqual({ version: SETTINGS_VERSION, live: { fps: 2 } });
	});

	test("GLIM-139: a user who removes small100 after the migration is not changed again", async () => {
		const store = new MemorySettingsStore(JSON.stringify(v1(["bergamot"])));
		const first = await loadSettings(store, env);
		expect(first.settings.providers.translation).toEqual(["bergamot", "small100"]);
		const removed = { ...first.settings, providers: { ...first.settings.providers, translation: ["bergamot"] } };
		await saveSettings(store, removed);
		const again = await loadSettings(store, env);
		expect(again.source).toBe("file");
		expect(again.settings.providers.translation).toEqual(["bergamot"]);
	});
});

describe("loadSettings", () => {
	test("no file: defaults, nothing written", async () => {
		const store = new MemorySettingsStore();
		const loaded = await loadSettings(store, env);
		expect(loaded).toMatchObject({ source: "defaults", warnings: [], fileVersion: null });
		expect(store.writes).toBe(0);
	});

	test("settings survive a restart", async () => {
		const store = new MemorySettingsStore();
		const changed = applySettingsPatch(defaultSettings(env), { language: { target: languageCode("ko") } }, env);
		await saveSettings(store, changed.settings);
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("file");
		expect(loaded.settings).toEqual(changed.settings);
	});

	test("corrupt JSON: backed up, defaults written, warning", async () => {
		const store = new MemorySettingsStore('{"language": {"target": "ja"');
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("recovered");
		expect(loaded.settings).toEqual(defaultSettings(env));
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toMatch(/not valid JSON.*kept at memory:corrupt-1/);
		expect(store.backups[0]?.contents).toBe('{"language": {"target": "ja"');
		expect(store.json()).toEqual(JSON.parse(serializeSettings(defaultSettings(env))));
	});

	test("a JSON array or string is corrupt too", async () => {
		for (const text of ["[]", '"hi"', "null"]) {
			const loaded = await loadSettings(new MemorySettingsStore(text), env);
			expect(loaded.source).toBe("recovered");
		}
	});

	test("bad fields warn but the file is not rewritten", async () => {
		const text = JSON.stringify({ version: SETTINGS_VERSION, live: { fps: "fast" } });
		const store = new MemorySettingsStore(text);
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("file");
		expect(loaded.warnings).toEqual(['settings live.fps: expected a number, got "fast"; using the default']);
		expect(store.contents).toBe(text);
	});

	test("a file from a newer version: backed up, loaded best-effort", async () => {
		const store = new MemorySettingsStore(JSON.stringify({ version: 99, language: { target: "it" }, newThing: 1 }));
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("file");
		expect(loaded.fileVersion).toBe(99);
		expect(loaded.settings.language.target).toBe(languageCode("it"));
		expect(store.backups.map((b) => b.reason)).toEqual(["newer-version"]);
		expect(loaded.warnings[0]).toMatch(/newer Glimpse \(version 99\)/);
	});

	test("read errors fall back to defaults without touching the file", async () => {
		const store = new MemorySettingsStore("{}");
		store.failRead = new Error("EACCES");
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("recovered");
		expect(store.writes).toBe(0);
		expect(store.backups).toEqual([]);
	});

	test("write errors during recovery become warnings", async () => {
		const store = new MemorySettingsStore("{oops");
		store.failWrite = new Error("ENOSPC");
		const loaded = await loadSettings(store, env);
		expect(loaded.source).toBe("recovered");
		expect(loaded.warnings.some((w) => w.includes("could not write the settings file: ENOSPC"))).toBe(true);
	});

	test("a UTF-8 BOM (Notepad) is accepted; unversioned files load as version 1", async () => {
		const loaded = await loadSettings(new MemorySettingsStore('﻿{"live": {"fps": 2}}'), env);
		// No version = 1, so it runs the migrations (a no-op here: the file has no providers).
		expect(loaded.source).toBe("migrated");
		expect(loaded.fileVersion).toBe(1);
		expect(loaded.settings.live.fps).toBe(2);
	});

	test("provider choices for providers that aren't installed are kept", async () => {
		const store = new MemorySettingsStore(
			JSON.stringify({ providers: { ocr: "future-ocr", translation: ["hymt2"], options: { hymt2: { q: 1 } } } }),
		);
		const loaded = await loadSettings(store, env);
		expect(loaded.settings.providers).toEqual({
			ocr: "future-ocr",
			translation: ["hymt2"],
			options: { hymt2: { q: 1 } },
		});
		expect(loaded.warnings).toEqual([]);
	});
});

describe("source-language subset and models folder (GLIM-68, GLIM-96)", () => {
	test("sources are stored as catalogue tags; unsupported codes are dropped", () => {
		const { settings, issues } = parseSettings({ language: { sources: ["zh-TW", "pt-BR", "tlh", "ja"] } }, env);
		expect(settings.language.sources).toEqual([languageCode("zh-Hant"), languageCode("pt"), languageCode("ja")]);
		expect(issues.map((i) => i.path)).toEqual(["language.sources[2]"]);
	});

	test("a patch with an unsupported source keeps the current list", () => {
		const current = applySettingsPatch(defaultSettings(env), { language: { sources: [languageCode("ja")] } }, env);
		const bad = applySettingsPatch(current.settings, { language: { sources: ["ko", "qqq"] as never } }, env);
		expect(bad.settings.language.sources).toEqual([languageCode("ja")]);
		expect(bad.issues).toHaveLength(1);
	});

	test("models.directory accepts absolute paths only", () => {
		for (const good of ["/Users/me/Models", "C:\\Glimpse\\models", "D:/models", "\\\\nas\\share\\models"]) {
			expect(parseSettings({ models: { directory: good } }, env).settings.models.directory).toBe(good);
		}
		for (const bad of ["models", "", "~/models", 3]) {
			const r = parseSettings({ models: { directory: bad } }, env);
			expect(r.settings.models.directory).toBeNull();
			expect(r.issues).toHaveLength(1);
		}
	});

	test("a version-1 file without the new fields loads without warnings", async () => {
		const loaded = await loadSettings(new MemorySettingsStore('{"version":1,"language":{"sources":["ja"]}}'), env);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.settings.models.directory).toBeNull();
		expect(loaded.settings.language.sources).toEqual([languageCode("ja")]);
	});
});
