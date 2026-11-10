// GLIM-164: "Show Glimpse in screen sharing and recordings" from Settings and the tray reaches
// the open windows at once, and Glimpse's own capture still never reads them. Real
// AppSettings, CommandBus, TrayController and CaptureExclusion; only the OS calls are fakes.
import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import {
	createLogger,
	DEFAULT_HOTKEYS,
	defaultSettings,
	languageCode,
	ProviderRegistry,
	rect,
	type SettingsEnv,
} from "@glimpse/core";
import { MemoryLogSink, MemorySettingsStore } from "@glimpse/core/testing";
import { CommandBus } from "../src/bun/commands.ts";
import { wireScreenSharing } from "../src/bun/screen-sharing.ts";
import { AppSettings } from "../src/bun/services/app-settings.ts";
import { type AppProviderContext, registerProviders } from "../src/bun/services/providers.ts";
import { buildTrayMenu, TrayController, type TrayMenuItem } from "../src/bun/tray-menu.ts";
import { CaptureExclusion, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";

type Normal = Extract<TrayMenuItem, { type: "normal" }>;
const trayItem = (menu: TrayMenuItem[]) =>
	menu.find((i): i is Normal => i.type === "normal" && i.action === "screen-sharing.toggle");

/** Windows-like OS: the display affinity per HWND, which only the flag keeps out of frames. */
function windowsOs() {
	const affinity = new Map<number, "exclude" | "none">();
	const ops: ExclusionOps = {
		exclude: (h) => {
			affinity.set(Number(h), "exclude");
			return { excluded: true, windowId: Number(h), detail: "WDA_EXCLUDEFROMCAPTURE" };
		},
		windowId: (h) => Number(h),
		setHidden: (h, hidden) => {
			affinity.set(Number(h), hidden ? "exclude" : "none");
			return { excluded: hidden, detail: hidden ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" };
		},
		ownCaptureSkipsIds: false,
	};
	return { ops, affinity };
}

const win = (n: number) => ({ ptr: n as unknown as Pointer, on: () => {} });

function setup(saved?: { showInScreenSharing: boolean }) {
	const registry = new ProviderRegistry<AppProviderContext>();
	registerProviders(registry);
	const env: SettingsEnv = {
		hotkeys: DEFAULT_HOTKEYS.windows,
		providers: registry.configSchema(),
		targetLanguage: languageCode("en"),
	};
	const defaults = defaultSettings(env);
	const initial = saved ? { ...defaults, privacy: { ...defaults.privacy, ...saved } } : defaults;
	const settings = new AppSettings(initial, new MemorySettingsStore(), env);
	const os = windowsOs();
	const exclusion = new CaptureExclusion(os.ops, { setExcludedWindows: () => {} });
	const menus: TrayMenuItem[][] = [];
	const tray = new TrayController(
		{ setMenu: (m) => menus.push(m), setImage: () => {} },
		{
			platform: "windows",
			live: "off",
			private: false,
			translation: null,
			hotkeys: { snip: null, live: null },
			taskbarTheme: "dark",
		},
	);
	const commands = new CommandBus(createLogger({ sinks: [new MemoryLogSink()] }));
	wireScreenSharing({ settings, exclusion, tray, commands });
	// The app's windows: two popups (one moved over the Live region), Settings, a picker overlay.
	const popup = rect(400, 100, 300, 200);
	const settingsWindow = rect(50, 50, 760, 560);
	exclusion.protect(win(1), undefined, { role: "popup", bounds: () => popup });
	exclusion.protect(win(2), undefined, { role: "window", bounds: () => settingsWindow });
	exclusion.protect(win(3), undefined, { role: "surface" });
	const lastMenu = () => menus[menus.length - 1] ?? [];
	return { settings, exclusion, os, tray, commands, lastMenu, popup, settingsWindow };
}

describe("Show Glimpse in screen sharing and recordings (GLIM-164)", () => {
	test("on by default: popups and Settings are shown to capture, surfaces never are; the tray is ticked", () => {
		const s = setup();
		expect(s.settings.current.privacy.showInScreenSharing).toBe(true);
		expect(s.exclusion.hideFromCapture).toBe(false);
		expect(s.os.affinity.get(1)).toBeUndefined(); // never flagged: WDA_NONE
		expect(s.os.affinity.get(2)).toBeUndefined();
		expect(s.os.affinity.get(3)).toBe("exclude");
		expect(trayItem(s.lastMenu())?.checked).toBe(true);
		// ...and Glimpse's own capture paints both over.
		expect(s.exclusion.maskRects()).toEqual([s.popup, s.settingsWindow]);
	});

	test("the tray toggle flips the setting, the open windows and the tray tick at once, both ways", async () => {
		const s = setup();
		await s.commands.dispatch("screen-sharing.toggle", "tray");
		expect(s.settings.current.privacy.showInScreenSharing).toBe(false);
		expect(s.os.affinity.get(1)).toBe("exclude");
		expect(s.os.affinity.get(2)).toBe("exclude");
		expect(s.os.affinity.get(3)).toBe("exclude");
		expect(trayItem(s.lastMenu())?.checked).toBe(false);
		// Hidden from every capture: nothing left for Glimpse to paint over.
		expect(s.exclusion.maskRects()).toEqual([]);

		await s.commands.dispatch("screen-sharing.toggle", "tray");
		expect(s.settings.current.privacy.showInScreenSharing).toBe(true);
		expect(s.os.affinity.get(1)).toBe("none");
		expect(s.os.affinity.get(2)).toBe("none");
		expect(s.os.affinity.get(3)).toBe("exclude");
		expect(trayItem(s.lastMenu())?.checked).toBe(true);
		expect(s.exclusion.maskRects()).toHaveLength(2);
	});

	test("Settings › Privacy (a settings update) ticks the tray and applies to open windows", async () => {
		const s = setup();
		await s.settings.update({ privacy: { showInScreenSharing: false } });
		expect(trayItem(s.lastMenu())?.checked).toBe(false);
		expect(s.os.affinity.get(1)).toBe("exclude");
		await s.settings.update({ privacy: { showInScreenSharing: true } });
		expect(trayItem(s.lastMenu())?.checked).toBe(true);
		expect(s.os.affinity.get(2)).toBe("none");
	});

	test("saved off: windows opened later are flagged and the tray is unticked", () => {
		const s = setup({ showInScreenSharing: false });
		expect(s.exclusion.hideFromCapture).toBe(true);
		expect(s.os.affinity.get(1)).toBe("exclude");
		expect(s.os.affinity.get(2)).toBe("exclude");
		expect(trayItem(s.lastMenu())?.checked).toBe(false);
		expect(buildTrayMenu({ ...s.tray.state, showInScreenSharing: true }).length).toBe(s.lastMenu().length);
	});

	test("an unchanged value doesn't touch the windows", async () => {
		const s = setup();
		s.os.affinity.clear();
		await s.settings.update({ privacy: { clearCacheOnLock: false } });
		expect(s.os.affinity.size).toBe(0);
	});
});
