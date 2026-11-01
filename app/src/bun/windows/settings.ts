import { BrowserView, BrowserWindow } from "electrobun/main";
import type { SettingsRPC } from "../../shared/settings-rpc.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import type { SettingsDeps } from "./settings-handlers.ts";
import { createSettingsHandlers } from "./settings-handlers.ts";

/**
 * The Settings window (GLIM-69): one instance, created on demand, re-activated if already
 * open. DESIGN.md Layout > Settings: 720 x 520 minimum, resizable. The handlers live in
 * settings-handlers.ts (tested on Linux); this file only wires them to Electrobun and pushes
 * state changes to the open view. Native materials (Mica / windowBackground vibrancy) need
 * helper support that doesn't exist yet; the view paints the solid window surface.
 */
export class SettingsWindow {
	private window: BrowserWindow | null = null;
	private unsubscribe: (() => void)[] = [];

	constructor(
		private readonly deps: SettingsDeps,
		private readonly exclusion: CaptureExclusion,
	) {}

	open(): void {
		if (this.window) {
			this.window.activate();
			return;
		}
		const h = createSettingsHandlers(this.deps);
		const rpc = BrowserView.defineRPC<SettingsRPC>({
			maxRequestTime: 60_000,
			handlers: {
				requests: {
					getAppInfo: h.getAppInfo,
					getSnapshot: h.getSnapshot,
					updateSettings: h.updateSettings,
					getSourceLanguages: h.getSourceLanguages,
					setHotkey: h.setHotkey,
					resetHotkeys: h.resetHotkeys,
					setLaunchAtLogin: h.setLaunchAtLogin,
					getModels: h.getModels,
					loadPackCatalogue: h.loadPackCatalogue,
					downloadModel: h.downloadModel,
					addLanguagePacks: h.addLanguagePacks,
					cancelModelDownload: h.cancelModelDownload,
					removeModel: h.removeModel,
					revealModelsDirectory: h.revealModelsDirectory,
					clearCache: h.clearCache,
					copyDiagnostics: h.copyDiagnostics,
					openLogs: h.openLogs,
				},
				messages: {
					closeSettings: () => this.window?.close(),
				},
			},
		});
		const win = new BrowserWindow({
			title: "Glimpse Settings",
			url: "views://settings/index.html",
			frame: { width: 760, height: 560 },
			rpc,
			// Created hidden so it is excluded from capture before it is ever on screen.
			hidden: true,
		});
		this.unsubscribe = [
			this.deps.settings.subscribe((s) => rpc.send.settingsChanged(s)),
			this.deps.hotkeys.subscribe((s) => rpc.send.hotkeysChanged(s)),
			this.deps.models.subscribe((s) => rpc.send.modelsChanged(s)),
		];
		win.on("close", () => {
			for (const u of this.unsubscribe) u();
			this.unsubscribe = [];
			this.window = null;
		});
		this.window = win;
		this.exclusion.protect(win, () => win.show());
	}
}
