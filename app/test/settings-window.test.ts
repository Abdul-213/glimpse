// GLIM-69 / 68 / 77 / 96: the Settings window's main-process side, without Electrobun.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HOTKEYS,
	defaultSettings,
	type HotkeyBindings,
	languageCode,
	type ModelManifest,
	ProviderRegistry,
	SETTINGS_VERSION,
	type SettingsEnv,
} from "@glimpse/core";
import { MemorySettingsStore } from "@glimpse/core/testing";
import { AppSettings } from "../src/bun/services/app-settings.ts";
import { HotkeyService } from "../src/bun/services/hotkeys.ts";
import { HOTKEY_ACTIONS, type HotkeyRegistrar, ServiceHotkeyRegistrar } from "../src/bun/services/hotkeys-port.ts";
import {
	LAUNCH_AGENT_LABEL,
	LoginItem,
	type LoginItemIO,
	launchAgentPlist,
	loginTarget,
	macBundleOf,
	parseRegQuery,
	regAddArgs,
} from "../src/bun/services/login-item.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { folderSize, ModelsSettings } from "../src/bun/services/models/models-settings.ts";
import { ModelManagerPackSource } from "../src/bun/services/translation/bergamot-packs.ts";
import { createSettingsHandlers, providerSummaries, type SettingsDeps } from "../src/bun/windows/settings-handlers.ts";
import { type HotkeyStatus, isSettingsSection, SETTINGS_SECTIONS } from "../src/shared/settings-rpc.ts";

const env: SettingsEnv = {
	hotkeys: DEFAULT_HOTKEYS.windows,
	providers: new ProviderRegistry<unknown>().configSchema(),
	targetLanguage: languageCode("en"),
};

const makeSettings = () => {
	const store = new MemorySettingsStore();
	return { store, settings: new AppSettings(defaultSettings(env), store, env) };
};

describe("AppSettings", () => {
	test("applies, notifies and saves a change", async () => {
		const { store, settings } = makeSettings();
		const seen: number[] = [];
		settings.subscribe((next, prev) => seen.push(next.live.fps, prev.live.fps));
		const r = await settings.update({ live: { fps: 2 } });
		expect(r.issues).toEqual([]);
		expect(settings.current.live.fps).toBe(2);
		expect(seen).toEqual([2, 3]);
		expect(store.json()).toMatchObject({ version: SETTINGS_VERSION, live: { fps: 2 } });
	});

	test("rejected values keep the current one and don't save", async () => {
		const { store, settings } = makeSettings();
		const r = await settings.update({ live: { fps: 99 } });
		expect(r.issues.map((i) => i.path)).toEqual(["live.fps"]);
		expect(settings.current.live.fps).toBe(3);
		expect(store.writes).toBe(0);
	});

	test("a failed save is logged, the change still applies", async () => {
		const { store, settings } = makeSettings();
		store.failWrite = new Error("EROFS");
		await settings.update({ privacy: { privateByDefault: true } });
		expect(settings.current.privacy.privateByDefault).toBe(true);
	});
});

/** A registrar where some combos are "used by another app". */
class FakeRegistrar implements HotkeyRegistrar {
	taken = new Set<string>();
	#status: HotkeyStatus;
	applied: HotkeyBindings[] = [];
	constructor(b: HotkeyBindings) {
		this.#status = this.#for(b);
	}
	status() {
		return this.#status;
	}
	async apply(b: HotkeyBindings) {
		this.applied.push(b);
		this.#status = this.#for(b);
		return this.#status;
	}
	subscribe() {
		return () => {};
	}
	#for(b: HotkeyBindings): HotkeyStatus {
		const out: Record<string, HotkeyStatus[keyof HotkeyStatus]> = {};
		for (const a of HOTKEY_ACTIONS) {
			const combo = b[a];
			out[a] =
				combo === null
					? { state: "unbound" }
					: this.taken.has(combo)
						? { state: "failed", reason: "in-use", message: "Another app already uses this shortcut." }
						: { state: "ready" };
		}
		return out as unknown as HotkeyStatus;
	}
}

function handlers2(hotkeys: HotkeyRegistrar) {
	const r = handlers({ hotkeys });
	return { h: r.h, settings: r.settings };
}

function fakeLoginIO(): LoginItemIO & { files: Map<string, string>; regCalls: string[][]; runValue: string | null } {
	const io = {
		files: new Map<string, string>(),
		regCalls: [] as string[][],
		runValue: null as string | null,
		async readFile(p: string) {
			return io.files.get(p) ?? null;
		},
		async writeFile(p: string, c: string) {
			io.files.set(p, c);
		},
		async removeFile(p: string) {
			io.files.delete(p);
		},
		async reg(args: string[]) {
			io.regCalls.push(args);
			if (args[0] === "add") io.runValue = args[7] ?? null;
			if (args[0] === "delete") {
				const had = io.runValue !== null;
				io.runValue = null;
				return { code: had ? 0 : 1, stdout: "" };
			}
			if (args[0] === "query") {
				return io.runValue
					? { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\...\\Run\r\n    Glimpse    REG_SZ    ${io.runValue}\r\n` }
					: { code: 1, stdout: "" };
			}
			return { code: 0, stdout: "" };
		},
	};
	return io;
}

function handlers(overrides: Partial<SettingsDeps> = {}) {
	const { settings, store } = makeSettings();
	const registrar = new FakeRegistrar(settings.current.hotkeys);
	const io = fakeLoginIO();
	const loginItem = new LoginItem({ os: "windows", launcher: "C:\\Glimpse\\bin\\launcher.exe" }, io);
	const dispatched: string[] = [];
	const deps: SettingsDeps = {
		appInfo: { name: "Glimpse", version: "0.1.0", platform: "windows", electrobun: "x", bun: "y" },
		settings,
		hotkeys: registrar,
		loginItem,
		models: {} as never,
		cloud: {} as never,
		installedPairs: () => [{ source: languageCode("ja"), target: languageCode("en") }],
		providers: () => ({ ocr: null, translation: [] }),
		dispatch: async (c) => {
			dispatched.push(c);
			return true;
		},
		chooseFolder: async () => null,
		reveal: () => true,
		settingsWarnings: [],
		uiLocale: "en",
		...overrides,
	};
	return { h: createSettingsHandlers(deps), settings, store, registrar, io, dispatched };
}

describe("settings handlers", () => {
	test("snapshot carries settings, defaults, hotkey and login status", async () => {
		const { h } = handlers();
		const s = await h.getSnapshot();
		expect(s.settings.language.target).toBe(languageCode("en"));
		expect(s.defaultHotkeys).toEqual(DEFAULT_HOTKEYS.windows);
		expect(s.hotkeys.snip).toEqual({ state: "ready" });
		expect(s.loginItem).toEqual({ enabled: false, supported: true });
	});

	test("update notification (GLIM-70): snapshot status, the switch, and the download page", async () => {
		const release = { version: "0.2.0", url: "https://github.com/Abdul-213/glimpse/releases/tag/v0.2.0" };
		let opened = 0;
		const { h, settings } = handlers({
			updates: {
				status: () => ({ state: "available", release, lastCheckAt: 1 }),
				subscribe: () => () => {},
				openPage: () => ++opened > 0,
			},
		});
		expect((await h.getSnapshot()).update).toEqual({ state: "available", release, lastCheckAt: 1 });
		expect(h.openUpdatePage()).toEqual({ ok: true });
		expect(opened).toBe(1);
		expect(settings.current.updates.check).toBe(true);
		await h.updateSettings({ updates: { check: false } });
		expect(settings.current.updates.check).toBe(false);
		const none = handlers().h;
		expect((await none.getSnapshot()).update).toEqual({ state: "current", lastCheckAt: null });
		expect(none.openUpdatePage().ok).toBe(false);
	});

	test("updateSettings only accepts the editable sections", async () => {
		const { h, settings } = handlers();
		const r = await h.updateSettings({
			live: { fps: 2 },
			hotkeys: { snip: null },
			system: { launchAtLogin: true },
			models: { directory: "/tmp" },
		});
		expect(r.settings.live.fps).toBe(2);
		expect(r.issues.map((i) => i.path).sort()).toEqual(["hotkeys", "models", "system"]);
		expect(settings.current.hotkeys.snip).toBe("Alt+Shift+S");
		expect(settings.current.system.launchAtLogin).toBe(false);
		expect((await h.updateSettings("nope")).issues).toHaveLength(1);
	});

	test("Snip options are editable from Settings (GLIM-117)", async () => {
		const { h, settings } = handlers();
		expect(settings.current.snip).toEqual({
			copyAfterSnip: true,
			showOriginalUnder: false,
			alwaysShowLanguages: false,
			showOnScreen: false,
		});
		const r = await h.updateSettings({
			snip: { copyAfterSnip: false, showOriginalUnder: true, alwaysShowLanguages: true, showOnScreen: true },
		});
		expect(r.issues).toEqual([]);
		expect(settings.current.snip).toEqual({
			copyAfterSnip: false,
			showOriginalUnder: true,
			alwaysShowLanguages: true,
			showOnScreen: true,
		});
		const bad = await h.updateSettings({ snip: { copyAfterSnip: "yes" } } as never);
		expect(bad.issues.map((i) => i.path)).toEqual(["snip.copyAfterSnip"]);
		expect(settings.current.snip.copyAfterSnip).toBe(false);
	});

	test("the snapshot names the pane Settings was opened at (GLIM-117)", async () => {
		expect((await handlers().h.getSnapshot()).section).toBeNull();
		let section: "providers" | "languages" | null = "providers";
		const { h } = handlers({ initialSection: () => section });
		expect((await h.getSnapshot()).section).toBe("providers");
		section = "languages";
		expect((await h.getSnapshot()).section).toBe("languages");
	});

	test("isSettingsSection accepts the sidebar's panes only", () => {
		expect(SETTINGS_SECTIONS).toContain("providers");
		expect(isSettingsSection("languages")).toBe(true);
		expect(isSettingsSection("hotkeys")).toBe(false);
		expect(isSettingsSection(3)).toBe(false);
	});

	test("source languages are validated against the language module (GLIM-68)", async () => {
		const { h, settings } = handlers();
		await h.updateSettings({ language: { sources: ["ja", "zh-TW"] } });
		expect(settings.current.language.sources).toEqual([languageCode("ja"), languageCode("zh-Hant")]);
		const bad = await h.updateSettings({ language: { sources: ["ko", "klingon!"] } });
		expect(bad.issues).toHaveLength(1);
		expect(settings.current.language.sources).toEqual([languageCode("ja"), languageCode("zh-Hant")]);
	});

	test("getSourceLanguages groups by script and knows installed routes", () => {
		const { h } = handlers();
		const s = h.getSourceLanguages();
		expect(s.groups.length).toBeGreaterThan(3);
		expect(s.packInstalled).toContain(languageCode("ja"));
		expect(s.packInstalled).not.toContain(languageCode("en")); // the target itself isn't a "pack"
	});

	test("setHotkey: invalid, Glimpse conflict, swap", async () => {
		const { h, settings } = handlers();
		expect(await h.setHotkey({ action: "nope", hotkey: "Alt+X" })).toMatchObject({ ok: false, error: "invalid" });
		expect(await h.setHotkey({ action: "snip", hotkey: "S" })).toMatchObject({ ok: false, error: "invalid" });
		expect(await h.setHotkey({ action: "snip", hotkey: "Alt+Shift+L" })).toMatchObject({
			ok: false,
			error: "conflict",
			owner: "live",
		});
		const swapped = await h.setHotkey({ action: "snip", hotkey: "alt+shift+l", swap: true });
		expect(swapped.ok).toBe(true);
		expect(settings.current.hotkeys.snip).toBe("Alt+Shift+L");
		expect(settings.current.hotkeys.live).toBe("Alt+Shift+S");
	});

	test("setHotkey: an OS refusal keeps the old binding registered and saved", async () => {
		const { h, settings, registrar, store } = handlers();
		registrar.taken.add("Ctrl+Alt+K");
		const r = await h.setHotkey({ action: "live", hotkey: "Ctrl+Alt+K" });
		expect(r).toMatchObject({ ok: false, error: "os", message: "Another app already uses this shortcut." });
		expect(settings.current.hotkeys.live).toBe("Alt+Shift+L");
		expect(registrar.applied.at(-1)?.live).toBe("Alt+Shift+L");
		expect(store.writes).toBe(0);
	});

	test("unbinding and restoring defaults", async () => {
		const { h, settings } = handlers();
		await h.setHotkey({ action: "snip", hotkey: null });
		expect(settings.current.hotkeys.snip).toBeNull();
		const r = await h.resetHotkeys();
		expect(r.ok).toBe(true);
		expect(settings.current.hotkeys).toEqual(DEFAULT_HOTKEYS.windows);
	});

	test("launch at login writes the Run value and the setting (GLIM-77)", async () => {
		const { h, settings, io } = handlers();
		const on = await h.setLaunchAtLogin({ enabled: true });
		expect(on).toEqual({ enabled: true, supported: true });
		expect(io.runValue).toBe('"C:\\Glimpse\\bin\\launcher.exe"');
		expect(settings.current.system.launchAtLogin).toBe(true);
		const off = await h.setLaunchAtLogin({ enabled: false });
		expect(off.enabled).toBe(false);
		expect(settings.current.system.launchAtLogin).toBe(false);
		expect((await h.setLaunchAtLogin({ enabled: "yes" })).error).toBeDefined();
	});

	test("model requests validate ids before touching the manager", () => {
		const { h } = handlers();
		expect(h.downloadModel({ id: "../etc" })).toEqual({ ok: false, message: "Unknown model." });
		expect(h.cancelModelDownload({})).toEqual({ ok: false, message: "Unknown model." });
		expect(h.addLanguagePacks({ language: 3 })).toEqual({ ok: false, message: "Unknown language." });
	});

	test("cache, diagnostics and logs go through the command bus", async () => {
		const { h, dispatched } = handlers();
		await h.clearCache();
		await h.copyDiagnostics();
		await h.openLogs();
		expect(dispatched).toEqual(["cache.clear", "diagnostics.copy", "logs.open"]);
	});

	test("providerSummaries names providers from the registry", () => {
		const s = providerSummaries({ ocr: "paddleocr", translation: ["bergamot", "gone"] }, (id) =>
			id === "bergamot" ? { name: "Firefox Translations", kind: "local" } : undefined,
		);
		expect(s.translation.map((p) => p.name)).toEqual(["Firefox Translations", "gone"]);
		expect(s.ocr?.name).toBe("paddleocr");
	});
});

describe("ServiceHotkeyRegistrar (real HotkeyService, fake backend)", () => {
	const quiet = { info() {}, warn() {}, debug() {}, error() {}, child: () => quiet } as never;
	const backend = (taken: string[]) => {
		const registered = new Set<string>();
		return {
			name: "fake",
			registered,
			register(hotkey: string) {
				if (taken.includes(hotkey)) return { ok: false, detail: "held by another app" };
				registered.add(hotkey);
				return { ok: true, detail: "ok" };
			},
			unregister(hotkey: string) {
				registered.delete(hotkey);
			},
			dispose() {},
		};
	};
	const handlers = { snip: () => {}, live: () => {} };

	test("maps registered, conflict, unbound and actions nothing uses yet", async () => {
		const b = backend(["Alt+Shift+L"]);
		const r = new ServiceHotkeyRegistrar(new HotkeyService(b, quiet), handlers);
		const seen: HotkeyStatus[] = [];
		r.subscribe((s) => seen.push(s));
		const s = await r.apply({ ...DEFAULT_HOTKEYS.windows, resnip: "Ctrl+Alt+R" });
		expect(s.snip).toEqual({ state: "ready" });
		expect(s.live).toMatchObject({ state: "failed", reason: "in-use" });
		expect(s.pauseLive).toEqual({ state: "unbound" });
		expect(s.resnip).toEqual({ state: "inactive" });
		expect(seen).toHaveLength(1);
		expect([...b.registered]).toEqual(["Alt+Shift+S"]);
		// Re-applying replaces the registrations.
		await r.apply({ ...DEFAULT_HOTKEYS.windows, snip: "Ctrl+Alt+S", live: "Ctrl+Alt+L" });
		expect([...b.registered].sort()).toEqual(["Ctrl+Alt+L", "Ctrl+Alt+S"]);
		expect(r.status().live).toEqual({ state: "ready" });
	});

	test("no backend (Linux) reports shortcuts unavailable", async () => {
		const r = new ServiceHotkeyRegistrar(new HotkeyService(null, quiet), handlers);
		const s = await r.apply(DEFAULT_HOTKEYS.windows);
		expect(s.snip).toMatchObject({ state: "failed", reason: "unavailable" });
	});

	test("setHotkey through the real service: an OS conflict keeps the old binding", async () => {
		const b = backend(["Ctrl+Alt+K"]);
		const reg = new ServiceHotkeyRegistrar(new HotkeyService(b, quiet), handlers);
		const { h, settings } = handlers2(reg);
		await reg.apply(settings.current.hotkeys);
		const r = await h.setHotkey({ action: "live", hotkey: "Ctrl+Alt+K" });
		expect(r).toMatchObject({ ok: false, error: "os" });
		expect(settings.current.hotkeys.live).toBe("Alt+Shift+L");
		expect(b.registered.has("Alt+Shift+L")).toBe(true);
		const ok = await h.setHotkey({ action: "live", hotkey: "Ctrl+Alt+J" });
		expect(ok.ok).toBe(true);
		expect(b.registered.has("Ctrl+Alt+J")).toBe(true);
	});
});

describe("launch at login (GLIM-77)", () => {
	// The macOS paths go through node:path, which is win32 path logic on a Windows runner; the
	// macOS branch never runs there, so those cases only run on macOS and Linux.
	const posixPaths = process.platform !== "win32";

	test("finds the .app bundle from the Bun binary", () => {
		expect(macBundleOf("/Applications/Glimpse.app/Contents/MacOS/bun")).toBe("/Applications/Glimpse.app");
		expect(macBundleOf("/Users/me/.bun/bin/bun")).toBeNull();
	});

	test.if(posixPaths)("targets per platform", () => {
		const mac = loginTarget({
			platform: "macos",
			execPath: "/Applications/Glimpse.app/Contents/MacOS/bun",
			home: "/Users/me",
			exists: () => true,
		});
		expect(mac).toEqual({
			os: "macos",
			bundle: "/Applications/Glimpse.app",
			plist: `/Users/me/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`,
		});
		expect(loginTarget({ platform: "macos", execPath: "/usr/bin/bun", home: "/h", exists: () => true }).os).toBe(
			"unsupported",
		);
		expect(loginTarget({ platform: "windows", execPath: "/x/bin/bun.exe", home: "", exists: () => false }).os).toBe(
			"unsupported",
		);
		expect(loginTarget({ platform: "linux", execPath: "/x", home: "", exists: () => true }).os).toBe("unsupported");
	});

	test.if(posixPaths)("the LaunchAgent opens the bundle at login, escaped", () => {
		const plist = launchAgentPlist("/Applications/Tom & Jerry/Glimpse.app");
		expect(plist).toContain("<string>/usr/bin/open</string>");
		expect(plist).toContain("<string>/Applications/Tom &amp; Jerry/Glimpse.app</string>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
	});

	test("reg.exe arguments and query parsing", () => {
		expect(regAddArgs("C:\\Program Files\\Glimpse\\launcher.exe")).toEqual([
			"add",
			"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
			"/v",
			"Glimpse",
			"/t",
			"REG_SZ",
			"/d",
			'"C:\\Program Files\\Glimpse\\launcher.exe"',
			"/f",
		]);
		expect(parseRegQuery('\r\nHKEY_CURRENT_USER\\x\r\n    Glimpse    REG_SZ    "C:\\a b\\launcher.exe"\r\n')).toBe(
			'"C:\\a b\\launcher.exe"',
		);
		expect(parseRegQuery("ERROR: not found")).toBeNull();
	});

	test.if(posixPaths)("macOS: set writes and removes the plist; reconcile re-points a moved app", async () => {
		const io = fakeLoginIO();
		const plist = "/Users/me/Library/LaunchAgents/x.plist";
		const item = new LoginItem({ os: "macos", bundle: "/Applications/Glimpse.app", plist }, io);
		expect((await item.set(true)).enabled).toBe(true);
		expect(io.files.get(plist)).toBe(launchAgentPlist("/Applications/Glimpse.app"));
		io.files.set(plist, launchAgentPlist("/Users/me/Downloads/Glimpse.app")); // the app was moved
		expect((await item.status()).enabled).toBe(false);
		expect((await item.reconcile(true)).enabled).toBe(true);
		expect(io.files.get(plist)).toContain("/Applications/Glimpse.app");
		expect((await item.reconcile(false)).enabled).toBe(false);
		expect(io.files.has(plist)).toBe(false);
	});

	test("unsupported targets never touch the OS", async () => {
		const io = fakeLoginIO();
		const item = new LoginItem({ os: "unsupported", reason: "dev" }, io);
		expect(await item.set(true)).toEqual({ enabled: false, supported: false, reason: "dev" });
		expect(io.regCalls).toEqual([]);
		expect(io.files.size).toBe(0);
	});

	test("reconcile never creates an entry the user didn't ask for", async () => {
		const io = fakeLoginIO();
		const item = new LoginItem({ os: "windows", launcher: "C:\\g\\launcher.exe" }, io);
		await item.reconcile(false);
		expect(io.regCalls.filter((c) => c[0] === "add")).toEqual([]);
	});
});

describe("Models settings (GLIM-96)", () => {
	let dir: string;
	let served: Map<string, Uint8Array>;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "glimpse-models-settings-"));
		served = new Map();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const file = (name: string, text: string) => {
		const body = new TextEncoder().encode(text);
		const url = `https://models.test/${name}`;
		served.set(url, body);
		return { name, urls: [url], sha256: createHash("sha256").update(body).digest("hex"), size: body.byteLength };
	};

	const manifest = (): ModelManifest => ({
		schema: 1,
		models: [
			{
				id: "ocr-rec-th",
				kind: "ocr-recognizer",
				recognizer: "th",
				bundled: false,
				licence: "Apache-2.0",
				attribution: "test",
				revision: "1",
				files: [file("th.onnx", "thai model ".repeat(50))],
			},
		],
	});

	let gate: Promise<void> = Promise.resolve();
	const fakeFetch = async (url: string) => {
		await gate;
		const body = served.get(url);
		return body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 });
	};

	const setup = () => {
		const root = join(dir, "default");
		const manager = new ModelManager({
			root,
			fetch: fakeFetch,
			freeBytes: async () => 1e12,
			progressIntervalMs: 0,
		});
		const saved: (string | null)[] = [];
		const models = new ModelsSettings({
			manager,
			manifest: manifest(),
			packs: new ModelManagerPackSource(manager),
			loadCatalogue: async () => {
				throw new Error("offline");
			},
			defaultDirectory: root,
			target: () => languageCode("en"),
			saveDirectory: async (d) => {
				saved.push(d);
			},
			freeBytes: async () => 5e9,
		});
		return { manager, models, saved, root };
	};

	test("lists models, downloads one, reports its size on disk", async () => {
		const { manager, models } = setup();
		await manager.scan();
		let snap = await models.snapshot();
		expect(snap.rows).toEqual([
			{ id: "ocr-rec-th", kind: "ocr", name: "Thai", bytes: 550, state: { status: "missing" } },
		]);
		expect(snap).toMatchObject({ isDefaultDirectory: true, usedBytes: 0, freeBytes: 5e9, catalogue: "idle" });
		expect(models.download("ocr-rec-th")).toEqual({ ok: true });
		expect(models.download("nope")).toMatchObject({ ok: false });
		await manager.install({ id: "ocr-rec-th", version: "1", files: manifest().models[0]?.files ?? [] });
		snap = await models.snapshot();
		expect(snap.rows[0]?.state).toEqual({ status: "installed", bundled: false });
		expect(snap.usedBytes).toBeGreaterThanOrEqual(550);
	});

	test("the catalogue is only fetched on request, and offline is reported", async () => {
		const { manager, models } = setup();
		await manager.scan();
		expect((await models.loadCatalogue()).catalogue).toBe("offline");
		expect(models.addLanguage("ja")).toMatchObject({ ok: false });
	});

	test("languagePlan: the target itself, and nothing to plan without a catalogue (GLIM-76)", async () => {
		const { manager, models } = setup();
		await manager.scan();
		expect(models.languagePlan("en")).toEqual({ status: "same", items: [] });
		expect(models.languagePlan("ja")).toEqual({ status: "unavailable", items: [] });
		expect(models.languagePlan("not a language")).toEqual({ status: "unavailable", items: [] });
	});

	test("moving the folder moves installed models and saves the setting", async () => {
		const { manager, models, saved } = setup();
		await manager.scan();
		await manager.install({ id: "ocr-rec-th", version: "1", files: manifest().models[0]?.files ?? [] });
		const target = join(dir, "elsewhere");
		expect(await models.moveTo(target)).toEqual({ ok: true });
		expect(manager.root).toBe(target);
		expect(existsSync(join(target, "ocr-rec-th", "th.onnx"))).toBe(true);
		expect(saved).toEqual([target]);
		const snap = await models.snapshot();
		expect(snap.isDefaultDirectory).toBe(false);
		expect(snap.rows[0]?.state.status).toBe("installed");
		// Back to the default folder stores null.
		expect(await models.moveTo(null)).toEqual({ ok: true });
		expect(saved.at(-1)).toBeNull();
	});

	test("a running download blocks the move with a clear message", async () => {
		const { manager, models, root } = setup();
		await manager.scan();
		let release = () => {};
		gate = new Promise((r) => {
			release = r;
		});
		const install = manager.install({ id: "ocr-rec-th", version: "1", files: manifest().models[0]?.files ?? [] });
		const r = await models.moveTo(join(dir, "elsewhere"));
		expect(r).toEqual({
			ok: false,
			message: "A download is running. Wait for it to finish or cancel it, then move the models.",
		});
		expect(manager.root).toBe(root);
		release();
		await install;
		gate = Promise.resolve();
	});

	test("refuses a folder inside the current one", async () => {
		const { manager, models, root } = setup();
		await manager.scan();
		expect(await models.moveTo(join(root, "sub"))).toMatchObject({ ok: false });
	});

	test("folderSize adds up nested files", async () => {
		const d = join(dir, "sz");
		mkdirSync(join(d, "a"), { recursive: true });
		await Bun.write(join(d, "x"), "12345");
		await Bun.write(join(d, "a", "y"), "123");
		expect(await folderSize(d)).toBe(8);
		expect(await folderSize(join(dir, "missing"))).toBe(0);
	});
});
