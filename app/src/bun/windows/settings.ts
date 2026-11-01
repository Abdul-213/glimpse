import { BrowserView, BrowserWindow } from "electrobun/main";
import type { SettingsRPC, SettingsSection } from "../../shared/settings-rpc.ts";
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
	/** Switches the open view to a pane (set while the window exists). */
	private showSection: ((section: SettingsSection) => void) | null = null;
	/** The pane a new window opens at; the view reads it with its first snapshot. */
	private initialSection: SettingsSection | null = null;

	constructor(
		readonly deps: SettingsDeps,
		private readonly exclusion: CaptureExclusion,
	) {}

	/** Open (or bring forward) Settings, at `section` if given (GLIM-117: popup deep links). */
	open(section?: SettingsSection): void {
		if (this.window) {
			if (section) this.showSection?.(section);
			this.window.activate();
			return;
		}
		this.initialSection = section ?? null;
		const h = createSettingsHandlers({ ...this.deps, initialSection: () => this.initialSection });
		const rpc = BrowserView.defineRPC<SettingsRPC>({
			// Moving models between volumes can take a while.
			maxRequestTime: 10 * 60_000,
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
					chooseModelsDirectory: h.chooseModelsDirectory,
					resetModelsDirectory: h.resetModelsDirectory,
					revealModelsDirectory: h.revealModelsDirectory,
					clearCache: h.clearCache,
					copyDiagnostics: h.copyDiagnostics,
					openLogs: h.openLogs,
					getCloud: h.getCloud,
					saveApiKey: h.saveApiKey,
					removeApiKey: h.removeApiKey,
					testApiKey: h.testApiKey,
					setProvider: h.setProvider,
					resetLiveConsent: h.resetLiveConsent,
					openCloudLink: h.openCloudLink,
					openOnboarding: h.openOnboarding,
					openUpdatePage: h.openUpdatePage,
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
			this.deps.cloud.subscribe((s) => rpc.send.cloudChanged(s)),
			...(this.deps.updates ? [this.deps.updates.subscribe((s) => rpc.send.updateChanged(s))] : []),
		];
		this.showSection = (s) => {
			// A reload of the view (or a late first snapshot) opens at the latest ask too.
			this.initialSection = s;
			rpc.send.showSection(s);
		};
		win.on("close", () => {
			for (const u of this.unsubscribe) u();
			this.unsubscribe = [];
			this.window = null;
			this.showSection = null;
			this.initialSection = null;
		});
		this.window = win;
		this.exclusion.protect(win, () => win.show());
	}
}
