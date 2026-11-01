import { describe, expect, test } from "bun:test";
import {
	DEFAULT_HOTKEYS,
	defaultSettings,
	type HotkeyBindings,
	languageCode,
	ProviderRegistry,
	type SettingsEnv,
} from "@glimpse/core";
import { MemorySettingsStore } from "@glimpse/core/testing";
import { COMMANDS } from "../src/bun/commands.ts";
import { AppSettings } from "../src/bun/services/app-settings.ts";
import { HOTKEY_ACTIONS, type HotkeyRegistrar } from "../src/bun/services/hotkeys-port.ts";
import type { LoginItem } from "../src/bun/services/login-item.ts";
import type { LanguagePlan, ModelsSettings } from "../src/bun/services/models/models-settings.ts";
import { ScreenAccess, type ScreenAccessOS } from "../src/bun/services/screen-access.ts";
import { buildTrayMenu, finishSetupNotice } from "../src/bun/tray-menu.ts";
import { createOnboardingHandlers } from "../src/bun/windows/onboarding-handlers.ts";
import { createSettingsHandlers, type SettingsDeps } from "../src/bun/windows/settings-handlers.ts";
import type { OnboardingMode } from "../src/shared/onboarding-rpc.ts";
import type { HotkeyStatus, ModelsSnapshot } from "../src/shared/settings-rpc.ts";

const MB = 1024 * 1024;

const env = (os: "macos" | "windows"): SettingsEnv => ({
	hotkeys: os === "macos" ? DEFAULT_HOTKEYS.macos : DEFAULT_HOTKEYS.windows,
	providers: new ProviderRegistry<unknown>().configSchema(),
	targetLanguage: languageCode("en"),
});

/** Models: ja and ko have packs (ko downloads when asked); ar has none. */
function fakeModels() {
	const state: Record<string, "missing" | "downloading" | "installed"> = { ja: "missing", ko: "missing" };
	const added: string[] = [];
	const cancelled: string[] = [];
	const plan = (language: string): LanguagePlan => {
		if (language === "en") return { status: "same", items: [] };
		const s = state[language];
		if (!s) return { status: "unavailable", items: [] };
		if (s === "installed") return { status: "ready", items: [] };
		return {
			status: "needs-download",
			items: [
				{
					id: `bergamot-${language}en`,
					bytes: 30 * MB,
					state: s === "downloading" ? { status: "downloading", done: 10 * MB, total: 30 * MB } : { status: "missing" },
				},
			],
		};
	};
	const models = {
		languagePlan: plan,
		addLanguage: (l: string) => {
			added.push(l);
			if (state[l] === "missing") state[l] = "downloading";
			return { ok: true };
		},
		cancel: (id: string) => {
			cancelled.push(id);
			return { ok: true };
		},
		snapshot: async () => ({ catalogue: "ready", freeBytes: 5e9 }) as unknown as ModelsSnapshot,
		loadCatalogue: async () => ({ catalogue: "ready" }) as unknown as ModelsSnapshot,
		subscribe: () => () => {},
	};
	return { models: models as unknown as ModelsSettings, state, added, cancelled };
}

function fakeHotkeys(b: HotkeyBindings): HotkeyRegistrar {
	let status = {} as HotkeyStatus;
	const set = (x: HotkeyBindings) => {
		status = Object.fromEntries(
			HOTKEY_ACTIONS.map((a) => [a, x[a] === null ? { state: "unbound" } : { state: "ready" }]),
		) as unknown as HotkeyStatus;
		return status;
	};
	set(b);
	return { status: () => status, apply: async (x) => set(x), subscribe: () => () => {} };
}

function make(os: "macos" | "windows", mode: OnboardingMode = "setup") {
	const e = env(os);
	const settings = new AppSettings(defaultSettings(e), new MemorySettingsStore(), e);
	const m = fakeModels();
	const login: string[] = [];
	const loginItem = {
		status: async () => ({ enabled: false, supported: true }),
		set: async (enabled: boolean) => {
			login.push(String(enabled));
			return { enabled, supported: true };
		},
	} as unknown as LoginItem;
	const settingsDeps: SettingsDeps = {
		appInfo: { name: "Glimpse", version: "1", platform: os, electrobun: "x", bun: "y" },
		settings,
		hotkeys: fakeHotkeys(settings.current.hotkeys),
		loginItem,
		models: m.models,
		cloud: {} as never,
		installedPairs: () => [],
		providers: () => ({ ocr: null, translation: [] }),
		dispatch: async () => true,
		chooseFolder: async () => null,
		reveal: () => true,
		settingsWarnings: [],
		uiLocale: "en",
	};
	let granted = false;
	const opened: string[] = [];
	const accessOS: ScreenAccessOS = {
		required: os === "macos",
		canRestart: true,
		preflight: () => granted,
		request: () => {},
		openSettings: () => true,
		scheduleRelaunch: () => true,
	};
	const screenAccess = new ScreenAccess({
		os: accessOS,
		memory: () => settings.current.permissions.screenAccess,
		saveMemory: async (screenAccess) => {
			await settings.update({ permissions: { screenAccess } });
		},
		quit: () => {},
	});
	const h = createOnboardingHandlers(
		{
			appInfo: settingsDeps.appInfo,
			screenAccess,
			settingsDeps,
			openUrl: (u) => {
				opened.push(u);
				return true;
			},
			installGuideUrl: "https://example.invalid/install",
			locale: os === "macos" ? "de-DE" : "en-US",
		},
		() => mode,
	);
	return { h, settings, m, login, opened, grant: () => (granted = true) };
}

describe("GLIM-76 onboarding handlers", () => {
	test("macOS setup starts at welcome with the screen-access step; Windows has none", async () => {
		const mac = await make("macos").h.getSnapshot();
		expect(mac.mode).toBe("setup");
		expect(mac.setup?.steps).toEqual(["welcome", "screen-access", "language", "downloads", "shortcuts", "done"]);
		expect(mac.setup?.step).toBe("welcome");
		expect(mac.setup?.resumed).toBe(false);
		expect(mac.setup?.suggestedTargets).toEqual([languageCode("en"), languageCode("de")]);
		const win = await make("windows").h.getSnapshot();
		expect(win.setup?.steps).not.toContain("screen-access");
		expect(win.screenAccess.state).toBe("not-needed");
	});

	test("screen-access mode carries no setup", async () => {
		const s = await make("macos", "screen-access").h.getSnapshot();
		expect(s.setup).toBeNull();
		expect(s.screenAccess.state).toBe("not-determined");
	});

	test("steps are saved, so setup resumes there", async () => {
		const t = make("macos");
		const r = await t.h.goToStep({ step: "downloads" });
		expect(r.step).toBe("downloads");
		expect(t.settings.current.onboarding.step).toBe("downloads");
		const again = await t.h.getSnapshot();
		expect(again.setup?.step).toBe("downloads");
		expect(again.setup?.resumed).toBe(true);
	});

	test("a step this OS doesn't have, or junk, is ignored", async () => {
		const t = make("windows");
		expect((await t.h.goToStep({ step: "screen-access" })).step).toBe("welcome");
		expect((await t.h.goToStep({ step: 42 })).step).toBe("welcome");
		expect((await t.h.goToStep(null)).step).toBe("welcome");
	});

	test("the target must be a language Glimpse can translate into", async () => {
		const t = make("macos");
		expect((await t.h.setTarget({ language: "ja" })).target).toBe(languageCode("ja"));
		expect((await t.h.setTarget({ language: "tlh" })).target).toBe(languageCode("ja"));
		expect((await t.h.setTarget({ language: 3 })).target).toBe(languageCode("ja"));
	});

	test("picked languages are remembered, sized and downloaded; progress adds up", async () => {
		const t = make("macos");
		let d = await t.h.pickLanguages({ languages: ["ja", "ko", "ko", "en", 7, "xx-invalid!"] });
		expect(t.settings.current.onboarding.languages).toEqual([
			languageCode("ja"),
			languageCode("ko"),
			languageCode("en"),
		]);
		// The target isn't offered as a language to read.
		expect(d.picked).toEqual([languageCode("ja"), languageCode("ko")]);
		expect(d.languages.slice(0, 2).map((l): unknown[] => [l.code, l.state, l.bytes])).toEqual([
			["ja", "available", 30 * MB],
			["ko", "available", 30 * MB],
		]);
		expect(d.languages.length).toBe(5);
		expect(d.active).toBeNull();
		d = await t.h.downloadLanguages();
		expect(t.m.added).toEqual(["ja", "ko"]);
		expect(d.active).toEqual({ done: 20 * MB, total: 60 * MB });
		// Asking again doesn't restart what is already downloading.
		await t.h.downloadLanguages();
		expect(t.m.added).toEqual(["ja", "ko"]);
		t.m.state["ja"] = "installed";
		d = await t.h.downloads();
		expect(d.languages[0]?.state).toBe("ready");
		expect(d.active).toEqual({ done: 10 * MB, total: 30 * MB });
		await t.h.cancelDownloads();
		expect(t.m.cancelled).toEqual(["bergamot-koen"]);
	});

	test("shortcuts go through the Settings rules", async () => {
		const t = make("windows");
		const r = await t.h.setHotkey({ action: "snip", hotkey: "Alt+Shift+T" });
		expect(r.ok).toBe(true);
		expect(t.settings.current.hotkeys.snip).toBe("Alt+Shift+T");
		expect((await t.h.setHotkey({ action: "nope", hotkey: "x" })).ok).toBe(false);
	});

	test("skip keeps setup unfinished but stops it opening at launch", async () => {
		const t = make("macos");
		expect(await t.h.skipSetup()).toEqual({ ok: true });
		expect(t.settings.current.onboarding).toMatchObject({ completed: false, dismissed: true });
	});

	test("finish sets launch at login and marks setup complete", async () => {
		const t = make("macos");
		await t.h.skipSetup();
		expect(await t.h.finishSetup({ launchAtLogin: true })).toEqual({ ok: true });
		expect(t.login).toEqual(["true"]);
		expect(t.settings.current.onboarding).toMatchObject({ completed: true, dismissed: false, step: "done" });
		expect(t.settings.current.system.launchAtLogin).toBe(true);
	});

	test("the install guide opens in the browser; restart goes through screen access", async () => {
		const t = make("macos");
		expect(t.h.openInstallGuide()).toEqual({ ok: true });
		expect(t.opened).toEqual(["https://example.invalid/install"]);
		expect(t.h.requestScreenAccess().state).toBe("denied");
		expect(t.h.openScreenAccessSettings().settingsOpened).toBe(true);
		t.grant();
		expect(t.h.refreshScreenAccess().state).toBe("granted");
		expect(t.h.restartApp()).toEqual({ ok: true });
	});

	test("Settings can reopen setup", async () => {
		const dispatched: string[] = [];
		const e = env("windows");
		const settings = new AppSettings(defaultSettings(e), new MemorySettingsStore(), e);
		const h = createSettingsHandlers({
			appInfo: { name: "Glimpse", version: "1", platform: "windows", electrobun: "x", bun: "y" },
			settings,
			hotkeys: fakeHotkeys(settings.current.hotkeys),
			loginItem: {} as never,
			models: {} as never,
			cloud: {} as never,
			installedPairs: () => [],
			providers: () => ({ ocr: null, translation: [] }),
			dispatch: async (c) => {
				dispatched.push(c);
				return true;
			},
			chooseFolder: async () => null,
			reveal: () => true,
			settingsWarnings: [],
			uiLocale: "en",
		});
		expect(await h.openOnboarding()).toEqual({ ok: true });
		expect(dispatched).toEqual(["onboarding.open"]);
		expect(COMMANDS).toContain("onboarding.open");
	});
});

describe("GLIM-76 tray", () => {
	test("'Finish setting up…' until setup is complete", () => {
		const notice = finishSetupNotice({ completed: false });
		expect(notice?.action).toBe("onboarding.open");
		expect(finishSetupNotice({ completed: true })).toBeNull();
		const menu = buildTrayMenu({
			platform: "windows",
			live: "off",
			private: false,
			translation: null,
			hotkeys: { snip: null, live: null },
			taskbarTheme: "dark",
			notices: notice ? [notice] : [],
		});
		expect(menu[0]).toEqual({ type: "normal", label: "Finish setting up…", action: "onboarding.open" });
	});
});
