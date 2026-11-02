// Fake main process for the dev-only Settings preview (GLIM-69): realistic data, in memory,
// so the real SettingsApp renders and responds in a plain browser and in headless screenshots.
// Dev-only, never shipped (build-views.ts DEV_ONLY_VIEWS), which is why it may use
// @glimpse/core at runtime for real language names and script groups; real views can't.
import {
	applySettingsPatch,
	canonicalHotkey,
	DEFAULT_HOTKEYS,
	defaultSettings,
	groupSourceLanguages,
	type HotkeyBindings,
	type LanguageCode,
	type Settings,
	type SettingsEnv,
	type SettingsPatch,
	sourceLanguageChoices,
} from "@glimpse/core";
import type {
	CloudActionResult,
	CloudSnapshot,
	HotkeyStatus,
	ModelRow,
	ModelsSnapshot,
	SetHotkeyResult,
	SettingsSnapshot,
} from "../../shared/settings-rpc.ts";
import type { SettingsClient, SettingsPushHandlers, SettingsRequests } from "../settings/client.ts";

export interface PreviewOptions {
	os: "macos" | "windows";
	/**
	 * `conflict`: Live's shortcut is taken by another app. `any`: no source subset. `idle`: pack list not loaded.
	 * `cloud`: a Google key saved, cloud translation picked, last test found Vision not enabled.
	 * `no-keychain`: the OS keychain can't be used.
	 */
	scenario: string;
}

const MB = 1024 * 1024;

const code = (c: string) => c as LanguageCode;

export function fakeSettingsClient(opts: PreviewOptions): SettingsClient {
	const hotkeyDefaults = opts.os === "macos" ? DEFAULT_HOTKEYS.macos : DEFAULT_HOTKEYS.windows;
	const env: SettingsEnv = {
		hotkeys: hotkeyDefaults,
		providers: {
			parse: (input) => ({ ok: true, value: input as Settings["providers"] }),
		},
		targetLanguage: code("en"),
	};
	let settings: Settings = applySettingsPatch(
		defaultSettings(env),
		{
			providers: { ocr: "paddleocr", translation: ["bergamot"], options: {} },
			language: {
				sources: opts.scenario === "any" ? [] : [code("ja"), code("ko"), code("zh-Hans")],
			},
		},
		env,
	).settings;
	let handlers: SettingsPushHandlers | null = null;

	const statusFor = (b: HotkeyBindings): HotkeyStatus => {
		const one = (action: keyof HotkeyBindings) => {
			if (b[action] === null) return { state: "unbound" as const };
			if (opts.scenario === "conflict" && action === "live") {
				return {
					state: "failed" as const,
					reason: "in-use" as const,
					message: "Another app already uses this shortcut. Choose a different one.",
				};
			}
			return { state: "ready" as const };
		};
		return {
			snip: one("snip"),
			live: one("live"),
			pauseLive: one("pauseLive"),
			resnip: one("resnip"),
			toggleLivePopup: one("toggleLivePopup"),
			focusLivePopup: one("focusLivePopup"),
		};
	};
	let hotkeys = statusFor(settings.hotkeys);

	const directory =
		opts.os === "macos"
			? "/Users/sam/Library/Application Support/dev.glimpse.app/stable/models"
			: "C:\\Users\\Sam\\AppData\\Local\\dev.glimpse.app\\stable\\models";
	const rows: ModelRow[] = [
		{ id: "ocr-det", kind: "ocr", name: "Text finder", bytes: 4.8 * MB, state: { status: "installed", bundled: true } },
		{
			id: "ocr-rec-ch",
			kind: "ocr",
			name: "Chinese and Japanese",
			bytes: 16.7 * MB,
			state: { status: "installed", bundled: true },
		},
		{
			id: "ocr-rec-latin",
			kind: "ocr",
			name: "Latin-script languages",
			bytes: 7.8 * MB,
			state: { status: "installed", bundled: true },
		},
		{
			id: "ocr-rec-korean",
			kind: "ocr",
			name: "Korean",
			bytes: 13.4 * MB,
			state: { status: "installed", bundled: false },
		},
		{
			id: "ocr-rec-arabic",
			kind: "ocr",
			name: "Arabic-script languages",
			bytes: 7.6 * MB,
			state: { status: "downloading", done: 3.1 * MB, total: 7.6 * MB },
		},
		{
			id: "ocr-rec-cyrillic",
			kind: "ocr",
			name: "Other Cyrillic-script languages",
			bytes: 7.7 * MB,
			state: { status: "missing" },
		},
		{ id: "ocr-rec-th", kind: "ocr", name: "Thai", bytes: 7.5 * MB, state: { status: "missing" } },
		{
			id: "bergamot-runtime",
			kind: "runtime",
			name: "Translation engine",
			bytes: 5.1 * MB,
			state: { status: "installed", bundled: true },
		},
		{
			id: "bergamot-ja-en",
			kind: "pack",
			name: "Japanese → English",
			bytes: 38.2 * MB,
			state: { status: "installed", bundled: false },
		},
		{
			id: "bergamot-ko-en",
			kind: "pack",
			name: "Korean → English",
			bytes: 36.9 * MB,
			state: { status: "installed", bundled: false },
		},
		{
			id: "bergamot-zh-en",
			kind: "pack",
			name: "Chinese (Simplified) → English",
			bytes: 41.0 * MB,
			state: { status: "failed", error: "network", message: "Couldn't connect. Check your connection and try again." },
		},
	];
	const choices = sourceLanguageChoices("en");
	let models: ModelsSnapshot = {
		directory,
		isDefaultDirectory: true,
		usedBytes: 88.5 * MB,
		freeBytes: 182.4 * 1024 * MB,
		rows,
		addable: choices
			.filter((c) => c.localTranslation && c.code !== "en")
			.map((c) => ({ code: c.code, name: c.name, nativeName: c.nativeName })),
		catalogue: opts.scenario === "idle" ? "idle" : "ready",
		moving: false,
	};

	// Settings › Providers (GLIM-75). The fake never holds a key either: only "saved" and a hint.
	const cloudScenario = opts.scenario === "cloud";
	if (cloudScenario) {
		settings = applySettingsPatch(
			settings,
			{ providers: { translation: ["cloud:google-translate-v2", "bergamot"] }, cloud: { liveConsent: [] } },
			env,
		).settings;
	}
	let keySaved = cloudScenario;
	let lastTest: CloudSnapshot["keys"][number]["lastTest"] = cloudScenario
		? {
				at: Date.now(),
				ok: false,
				checks: [
					{ api: "translate", name: "Cloud Translation API", ok: true },
					{
						api: "vision",
						name: "Cloud Vision API",
						ok: false,
						problem: "api-disabled",
						message:
							"The Cloud Vision API isn't enabled for this key's project. Enable it in the Google Cloud console, wait a minute, then try again.",
					},
				],
			}
		: null;
	const cloud = (): CloudSnapshot => ({
		keychain:
			opts.scenario === "no-keychain"
				? { available: false, message: "No system password store is available, so API keys can't be saved." }
				: { available: true },
		keys: [
			{
				secretId: "google-cloud",
				vendor: "Google",
				label: "Google Cloud API key",
				saved: keySaved,
				hint: keySaved ? "…3f2a" : null,
				lastTest: keySaved ? lastTest : null,
				usedBy: ["Google Cloud Vision", "Google Cloud Translation"],
			},
		],
		providers: [
			{
				id: "cloud:google-vision",
				name: "Google Cloud Vision",
				vendor: "Google",
				task: "ocr",
				sends: "image",
				secretId: "google-cloud",
				selected: settings.providers.ocr === "cloud:google-vision",
			},
			{
				id: "cloud:google-translate-v2",
				name: "Google Cloud Translation",
				vendor: "Google",
				task: "translation",
				sends: "text",
				secretId: "google-cloud",
				selected: settings.providers.translation[0] === "cloud:google-translate-v2",
			},
		],
		local: {
			ocr: { id: "paddleocr", name: "PaddleOCR (PP-OCRv5)", kind: "local" },
			translation: [{ id: "bergamot", name: "Firefox Translations (Bergamot)", kind: "local" }],
		},
		liveConsent: settings.cloud.liveConsent,
	});
	const cloudResult = (message?: string): CloudActionResult => {
		const c = cloud();
		handlers?.cloudChanged(c);
		return message === undefined ? { ok: true, cloud: c } : { ok: false, message, cloud: c };
	};

	const snapshot = (): SettingsSnapshot => ({
		app: { name: "Glimpse", version: "0.1.0", platform: opts.os, electrobun: "2.0.6-beta.2", bun: "1.3.4" },
		settings,
		defaultHotkeys: hotkeyDefaults,
		hotkeys,
		loginItem: { enabled: false, supported: true },
		providers: {
			ocr: { id: "paddleocr", name: "PaddleOCR (PP-OCRv5)", kind: "local" },
			translation: [{ id: "bergamot", name: "Firefox Translations (Bergamot)", kind: "local" }],
		},
		settingsWarnings: [],
		update: settings.updates.check
			? {
					state: "available",
					release: { version: "0.2.0", url: "https://github.com/Abdul-213/glimpse/releases/tag/v0.2.0" },
					lastCheckAt: Date.UTC(2026, 10, 1, 9, 30),
				}
			: { state: "off" },
		section: null,
	});

	const update = (patch: SettingsPatch) => {
		const r = applySettingsPatch(settings, patch, env);
		settings = r.settings;
		handlers?.settingsChanged(settings);
		return r;
	};

	const setBindings = (b: HotkeyBindings): SetHotkeyResult => {
		update({ hotkeys: b });
		hotkeys = statusFor(settings.hotkeys);
		return { ok: true, bindings: settings.hotkeys, status: hotkeys };
	};

	const ok = { ok: true } as const;
	const request: SettingsRequests = {
		getAppInfo: async () => snapshot().app,
		getSnapshot: async () => snapshot(),
		updateSettings: async (edit) => update(edit as SettingsPatch),
		getSourceLanguages: async () => ({
			groups: groupSourceLanguages(choices, "en"),
			packInstalled: [code("ja"), code("ko")],
		}),
		setHotkey: async ({ action, hotkey, swap }) => {
			const combo = hotkey === null ? null : canonicalHotkey(hotkey);
			if (hotkey !== null && !combo) return { ok: false, error: "invalid", message: "This shortcut can't be used." };
			const owner = (Object.keys(settings.hotkeys) as (keyof HotkeyBindings)[]).find(
				(a) => a !== action && combo !== null && settings.hotkeys[a] === combo,
			);
			if (owner && !swap) return { ok: false, error: "conflict", owner, message: "Already used." };
			return setBindings({
				...settings.hotkeys,
				[action]: combo,
				...(owner ? { [owner]: settings.hotkeys[action] } : {}),
			});
		},
		resetHotkeys: async () => setBindings(hotkeyDefaults),
		setLaunchAtLogin: async ({ enabled }) => ({ enabled, supported: true }),
		getModels: async () => models,
		loadPackCatalogue: async () => {
			models = { ...models, catalogue: "ready" };
			return models;
		},
		downloadModel: async ({ id }) => {
			models = {
				...models,
				rows: models.rows.map((r) => (r.id === id ? { ...r, state: { status: "queued" } } : r)),
			};
			handlers?.modelsChanged(models);
			return ok;
		},
		addLanguagePacks: async () => ok,
		cancelModelDownload: async ({ id }) => {
			models = { ...models, rows: models.rows.map((r) => (r.id === id ? { ...r, state: { status: "missing" } } : r)) };
			handlers?.modelsChanged(models);
			return ok;
		},
		removeModel: async ({ id }) => {
			models = { ...models, rows: models.rows.map((r) => (r.id === id ? { ...r, state: { status: "missing" } } : r)) };
			handlers?.modelsChanged(models);
			return ok;
		},
		chooseModelsDirectory: async () => ok,
		resetModelsDirectory: async () => ok,
		revealModelsDirectory: async () => ok,
		clearCache: async () => ok,
		copyDiagnostics: async () => ok,
		openLogs: async () => ok,
		getCloud: async () => cloud(),
		saveApiKey: async ({ key }) => {
			if (!/^[A-Za-z0-9_-]{30,128}$/.test(key.trim())) {
				return cloudResult(
					"That doesn't look like a Google Cloud API key. Keys start with AIza and are 39 characters long.",
				);
			}
			keySaved = true;
			lastTest = null;
			return cloudResult();
		},
		removeApiKey: async () => {
			keySaved = false;
			lastTest = null;
			update({ providers: { ocr: "paddleocr", translation: ["bergamot"] } });
			return cloudResult();
		},
		testApiKey: async () => {
			lastTest = {
				at: Date.now(),
				ok: true,
				checks: [
					{ api: "translate", name: "Cloud Translation API", ok: true },
					{ api: "vision", name: "Cloud Vision API", ok: true },
				],
			};
			return cloudResult();
		},
		setProvider: async ({ task, id }) => {
			if (task === "ocr") update({ providers: { ocr: id ?? "paddleocr" } });
			else update({ providers: { translation: id ? [id, "bergamot"] : ["bergamot"] } });
			return cloudResult();
		},
		resetLiveConsent: async () => {
			update({ cloud: { liveConsent: [] } });
			return cloudResult();
		},
		openCloudLink: async () => ok,
		openOnboarding: async () => ok,
		openUpdatePage: async () => ok,
	};

	return {
		request,
		listen: (h) => {
			handlers = h;
		},
		close: () => {},
	};
}
