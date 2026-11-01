// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadSettings, opensAtLaunch, ProviderRegistry, parseModelManifest } from "@glimpse/core";
import Electrobun, { Utils } from "electrobun/main";
import modelManifestJson from "../../models/manifest.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };
import { INSTALL_GUIDE_URL } from "../shared/onboarding-rpc.ts";
import type { AppInfo } from "../shared/rpc.ts";
import { CommandBus } from "./commands.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { exclusionOpsFor } from "./native/exclusion.ts";
import { frameNativesFor } from "./native/frame.ts";
import { loadMacNative } from "./native/macos.ts";
import { overlayOpsFor } from "./native/overlay.ts";
import { platform } from "./platform.ts";
import { AppSettings } from "./services/app-settings.ts";
import { createCaptureSource } from "./services/capture/index.ts";
import { MaskedCaptureSource } from "./services/capture/masked.ts";
import { CloudSettings } from "./services/cloud-settings.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { HotkeyService } from "./services/hotkeys.ts";
import { CarbonHotkeyBackend } from "./services/hotkeys-carbon.ts";
import { ElectrobunHotkeyBackend } from "./services/hotkeys-electrobun.ts";
import { ServiceHotkeyRegistrar } from "./services/hotkeys-port.ts";
import { LiveService } from "./services/live/live-service.ts";
import { PinnedFrame } from "./services/live/pinned-frame.ts";
import { createAppLogger } from "./services/log.ts";
import { LoginItem, loginTarget, systemLoginItemIO } from "./services/login-item.ts";
import { loadBergamotCatalogue } from "./services/models/catalogue.ts";
import { ModelManager } from "./services/models/model-manager.ts";
import { ModelsSettings } from "./services/models/models-settings.ts";
import { bundledModelsDir, catalogueCacheFile, modelsRoot } from "./services/models/paths.ts";
import { createPickerNatives } from "./services/picker/index.ts";
import { type AppProviderContext, providerContext, registerProviders } from "./services/providers.ts";
import { ScreenAccess, screenAccessNotice } from "./services/screen-access.ts";
import { screenAccessOS } from "./services/screen-access-os.ts";
import { KeychainSecretStore } from "./services/secrets.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { watchTaskbarTheme } from "./services/taskbar-theme.ts";
import { ModelManagerPackSource } from "./services/translation/bergamot-packs.ts";
import { loadPackCatalogue } from "./services/translation/pack-catalogue.ts";
import { pipelineStages } from "./services/translation/pipeline-stages.ts";
import { TranslationPacks } from "./services/translation/translation-packs.ts";
import { TranslationService, warmPairsFor } from "./services/translation/translation-service.ts";
import { fileUpdateStateStore, UpdateChecker } from "./services/update-check.ts";
import { createTray } from "./tray.ts";
import { finishSetupNotice } from "./tray-menu.ts";
import { CaptureExclusion } from "./windows/capture-exclusion.ts";
import { OnboardingWindow } from "./windows/onboarding.ts";
import { electrobunOverlayFactory, screenProbe } from "./windows/picker.ts";
import { PickerController, pickerSettingsFrom } from "./windows/picker-controller.ts";
import { ElectrobunPopupWindow } from "./windows/popup.ts";
import { SnipPopupController } from "./windows/popup-controller.ts";
import { snipViewInit } from "./windows/popup-init.ts";
import { SettingsWindow } from "./windows/settings.ts";
import { providerSummaries } from "./windows/settings-handlers.ts";

const logs = createAppLogger({ dir: Utils.paths.userLogs });
const log = logs.logger;
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

// Provider implementations (packages/providers) register in services/providers.ts.
const providers = new ProviderRegistry<AppProviderContext>();
registerProviders(providers);

const locale = Intl.DateTimeFormat().resolvedOptions().locale;
const settingsStore = FileSettingsStore.inDirectory(Utils.paths.userData);
const settingsEnv = settingsEnvFor(platform, locale, providers);
const loadedSettings = await loadSettings(settingsStore, settingsEnv);
logs.applySettingsLevel(loadedSettings.settings.diagnostics.logLevel);
const settingsLog = log.child("settings");
for (const warning of loadedSettings.warnings) settingsLog.warn(warning);
// The live settings (GLIM-69): main owns them; Settings and features subscribe to changes.
const appSettings = new AppSettings(loadedSettings.settings, settingsStore, settingsEnv, settingsLog);

const appInfo: AppInfo = {
	name: "Glimpse",
	version: pkg.version,
	platform,
	electrobun: ELECTROBUN_VERSION,
	bun: Bun.version,
};

// Model download manager (GLIM-38). Consumers (OCR/translation providers, onboarding) come later.
// Storage location from settings (GLIM-96); Settings › Models moves it with relocate().
const modelsDir = modelsRoot(Utils.paths.userData, loadedSettings.settings.models.directory);
const models = new ModelManager({ root: modelsDir, bundledDir: bundledModelsDir(import.meta.dir) });

// Translation (GLIM-101, GLIM-102): Bergamot over the model manager's packs, the core
// pipeline and the GLIM-20 caches. Providers load after the model scan, in the background.
const translationLog = log.child("translation");
const bergamotPacks = new ModelManagerPackSource(models);
// API keys for cloud providers live in the OS keychain (GLIM-40); every value read or saved is
// registered with the log redactor. Cloud providers are opt-in (GLIM-60/61): only used once
// picked in Settings › Providers.
const secrets = new KeychainSecretStore({
	logger: log.child("secrets"),
	onValue: (value) => log.redactor.addSecret(value),
});
const {
	ctx: providerCtx,
	bergamotWorker,
	ocrWorker,
} = providerContext({
	packs: bergamotPacks,
	// PaddleOCR (GLIM-103) reads its model files through the model manager.
	models,
	mainDir: import.meta.dir,
	warmPairs: () => warmPairsFor(appSettings.current),
	log: translationLog,
	secrets,
});
const translationPacks = new TranslationPacks({
	manager: models,
	packs: bergamotPacks,
	chain: () => translation.chain,
});
const stages = pipelineStages(translationLog);
const translation: TranslationService<AppProviderContext> = new TranslationService({
	registry: providers,
	ctx: providerCtx,
	settings: () => appSettings.current,
	log: translationLog,
	readinessOf: (from, to) => translationPacks.readiness(from, to),
	// GLIM-109: GLIM-56 grouping and GLIM-21 detection over ELD.
	...stages,
	onPrivateChange: (on) => tray.update({ private: on }),
});
translation.startTimers();
void loadPackCatalogue(bergamotPacks, catalogueCacheFile(modelsDir), { refresh: true, log: translationLog });
models
	.scan()
	.then(() => {
		log.child("models").info("scan complete", { installed: models.installedIds().length });
		translationLog.info("starting providers", {
			bergamotWorker: bergamotWorker ?? "default (source tree)",
			ocrWorker: ocrWorker ?? "default (source tree)",
		});
		void stages.detector.load();
		return translation.start();
	})
	.catch((error) => log.child("models").warn("model scan failed", { error }));

// Capture (GLIM-36). Nothing captures yet: the Snip and Live pipelines (GLIM-48, GLIM-56)
// take `capture.source`. Every window controller gets `exclusion` so Glimpse never
// captures its own windows.
const captureLog = log.child("capture");
const capture = createCaptureSource({ shellDisplays: readDisplays, log: (message) => captureLog.info(message) });
const exclusion = new CaptureExclusion(exclusionOpsFor(), capture.source, (message) => captureLog.warn(message));
// GLIM-98: Settings › Privacy › Hide Glimpse from screenshots and screen sharing. Snip and Live
// read through `screen`, which paints over Glimpse windows the OS lets into a frame.
exclusion.setHideFromCapture(loadedSettings.settings.privacy.hideFromCapture);
const screen = new MaskedCaptureSource(capture.source, () => exclusion.maskRects());

// Global hotkeys (GLIM-23): Electrobun RegisterHotKey on Windows, Carbon on macOS.
const macNative = platform === "macos" ? loadMacNative() : null;
const hotkeyBackend =
	platform === "windows"
		? new ElectrobunHotkeyBackend()
		: macNative?.binding
			? new CarbonHotkeyBackend(macNative.binding)
			: null;
const hotkeys = new HotkeyService(
	hotkeyBackend,
	log.child("hotkeys"),
	platform === "macos" && macNative && !macNative.status.available ? macNative.status.reason : undefined,
);
// Settings talks to the hotkey service through the HotkeyRegistrar port: it applies the
// bindings with the actions' handlers and reports per-action status (GLIM-69). `commands` is
// declared below; the handlers only run on a key press.
const hotkeyRegistrar = new ServiceHotkeyRegistrar(hotkeys, {
	snip: () => void commands.dispatch("snip.start", "hotkey"),
	live: () => void commands.dispatch("live.start", "hotkey"),
});

// Screen Recording permission (GLIM-45): macOS only. Snip and Live open the screen-access
// window instead of the picker while it's missing; the tray lists it first.
const screenAccess = new ScreenAccess({
	os: screenAccessOS(platform, macNative?.binding ? () => macNative.binding?.preflight() ?? false : null),
	memory: () => appSettings.current.permissions.screenAccess,
	saveMemory: async (screenAccess) => {
		await appSettings.update({ permissions: { screenAccess } });
	},
	// `commands` is declared below; this only runs from the window's Restart button.
	quit: () => void commands.dispatch("app.quit", "internal"),
	log: captureLog.child("screen-access"),
});
const whenScreenAccess = (start: () => void) => () => {
	if (screenAccess.canCapture) start();
	else onboarding.open("screen-access");
};

const loginItem = new LoginItem(
	loginTarget({ platform, execPath: process.execPath, home: homedir(), exists: (p) => existsSync(p) }),
	systemLoginItemIO(),
);
loginItem
	.reconcile(loadedSettings.settings.system.launchAtLogin)
	.catch((error) => settingsLog.warn("launch at login: could not update the login item", { error }));
// Settings window (GLIM-69).
const modelsSettings = new ModelsSettings({
	manager: models,
	manifest: parseModelManifest(modelManifestJson),
	packs: bergamotPacks,
	loadCatalogue: () => loadBergamotCatalogue({ cacheFile: catalogueCacheFile(models.root) }),
	defaultDirectory: modelsRoot(Utils.paths.userData),
	target: () => appSettings.current.language.target,
	saveDirectory: async (directory) => {
		await appSettings.update({ models: { directory } });
	},
	uiLocale: locale,
});
// Cloud providers and API keys (GLIM-75): keys go to the keychain and never back to a view;
// a key change drops the translation cache and re-checks the providers that use it.
const cloudSettings = new CloudSettings({
	registry: providers,
	secrets,
	settings: appSettings,
	onKeyChanged: (secretId) => translation.keyChanged(secretId),
	openUrl: (url) => Utils.openExternal(url),
});
// Update notification (GLIM-70): GitHub's latest release, at most once a day, notify only.
const updates = new UpdateChecker({
	currentVersion: appInfo.version,
	enabled: () => appSettings.current.updates.check,
	store: fileUpdateStateStore(Utils.paths.userData),
	fetch: (url, init) => fetch(url, init),
	log: log.child("updates"),
});
const openUpdatePage = (): boolean => {
	const s = updates.status;
	return s.state === "available" && Utils.openExternal(s.release.url);
};
const settings = new SettingsWindow(
	{
		appInfo,
		updates: {
			status: () => updates.status,
			subscribe: (listener) => updates.subscribe(listener),
			openPage: openUpdatePage,
		},
		settings: appSettings,
		hotkeys: hotkeyRegistrar,
		loginItem,
		models: modelsSettings,
		cloud: cloudSettings,
		installedPairs: () => bergamotPacks.installed(),
		providers: () =>
			providerSummaries(appSettings.current.providers, (id) => {
				const f = providers.get(id);
				return f ? { name: f.info.name, kind: f.info.kind } : undefined;
			}),
		// `commands` is declared below; this only runs once the window is open.
		dispatch: (command, source) => commands.dispatch(command, source),
		chooseFolder: async (startingFolder) => {
			const paths = await Utils.openFileDialog({
				startingFolder,
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});
			return paths.find((p) => p.trim() !== "") ?? null;
		},
		reveal: (path) => Utils.openPath(path),
		settingsWarnings: loadedSettings.warnings,
		uiLocale: locale,
	},
	exclusion,
);
// First-run setup and the screen-access window (GLIM-45, GLIM-76). Shares the Settings
// window's services, so shortcuts, launch at login and downloads follow the same rules.
const onboarding = new OnboardingWindow(
	{
		appInfo,
		screenAccess,
		settingsDeps: settings.deps,
		openUrl: (url) => Utils.openExternal(url),
		installGuideUrl: INSTALL_GUIDE_URL,
		locale,
	},
	exclusion,
);

// Region picker (GLIM-44, GLIM-91): one hidden overlay per display, created now so a
// hotkey only has to show them (spec 8: scrim within 100 ms). Loupe pixels come from the
// capture source; window list and focus from the native helper.
const pickerLog = log.child("picker");
const pickerNatives = createPickerNatives({
	capture: capture.source,
	shellDisplays: readDisplays,
	log: (message) => pickerLog.warn(message),
});
let picker: PickerController | null = null;
picker = new PickerController({
	factory: electrobunOverlayFactory({
		exclusion,
		ops: overlayOpsFor(),
		controller: () => picker,
		log: (message) => pickerLog.info(message),
	}),
	displays: readDisplays,
	probe: screenProbe,
	windows: pickerNatives.windows,
	sampler: pickerNatives.sampler,
	focus: pickerNatives.focus,
	os: platform,
	log: pickerLog,
	// Show magnifier, Translate on release, reduced motion (GLIM-105): read on every open.
	settings: () => pickerSettingsFrom(appSettings.current),
	// `live` is declared below; this only runs when the picker opens.
	liveRunning: () => live.active,
});
picker.prepare();
// Snip popup (GLIM-65): one hidden window created now, reused for every Snip. A confirmed
// Snip region runs through the translation pipeline and streams into it; the overlays stay
// up under it as the results layer until it closes.
const popupLog = log.child("popup");
let snipPopup: SnipPopupController | null = null;
const popupWindow = new ElectrobunPopupWindow({
	exclusion,
	init: snipViewInit(platform),
	controller: () => snipPopup,
	displays: readDisplays,
	log: (message) => popupLog.info(message),
});
snipPopup = new SnipPopupController({
	window: popupWindow,
	displays: readDisplays,
	runner: {
		snip: (rect, onEvent, signal, runId) => translation.snip(screen, rect, onEvent, signal, runId),
		translate: (blocks, onEvent, signal, runId, opts) =>
			translation.translateBlocks(blocks, onEvent, { runId, signal, ...opts }),
		// E3 "Translate on this device" (GLIM-80).
		canTranslateLocally: (blocks) => translation.canTranslateLocally(blocks),
	},
	// Pack rows and the E2 Download button: the user's consent to fetch (GLIM-57).
	packs: translationPacks,
	clipboard: { writeText: (text) => Utils.clipboardWriteText(text) },
	eol: platform === "windows" ? "\r\n" : "\n",
	targets: {
		snipAgain: () => picker?.toggle("snip"),
		// "Check key…" opens Providers, "Edit source languages…" Languages (GLIM-117).
		openSettings: (section) => settings.open(section),
		openExternal: (url) => {
			if (!Utils.openExternal(url)) popupLog.warn("could not open a link", { url });
		},
	},
	focus: pickerNatives.focus,
	// The overlays stay up under the popup as the results layer, drawing its detection boxes (GLIM-115).
	results: { dismiss: () => picker?.dismiss(), showBoxes: (state) => picker?.showResults(state) },
	settings: () => ({
		reducedMotion: appSettings.current.appearance.motion === "reduced",
		alwaysShowLanguages: appSettings.current.snip.alwaysShowLanguages,
		showOriginalUnder: appSettings.current.snip.showOriginalUnder,
		// Snip only: Live never touches the clipboard (GLIM-71).
		autoCopy: appSettings.current.snip.copyAfterSnip,
		uiDir: "ltr",
	}),
	pointer: () => screenProbe.cursor(),
	// "Sent to Google" when the full name doesn't fit (GLIM-80): the registry's vendor.
	providerShortName: (id) => providers.get(id)?.info.vendor ?? null,
	log: popupLog,
});
// A press on the results layer is a click outside the popup (snip-popup.md §5).
picker.onResultsPointerDown(() => snipPopup?.outsideClick());
// Live (GLIM-48/58/59/90): a Live region is pinned. The service runs the capture loop, change
// detection and the pipeline session, draws the native frame around the region and emits typed
// session events (logged for now; the docked popup, GLIM-79, renders them).
const liveLog = log.child("live");
const frameNatives = frameNativesFor(readDisplays);
const live = new LiveService({
	capture: screen,
	openPipeline: () => translation.openLive(() => {}),
	settings: () => appSettings.current,
	frame: () =>
		new PinnedFrame({
			...frameNatives,
			displays: readDisplays,
			exclude: (windowId) => exclusion.register(windowId),
			log: liveLog,
		}),
	log: liveLog,
	// `tray` is declared below; the state only changes once a session runs.
	onState: (state) => tray.update({ live: state }),
	perfNow: () => performance.now(),
});
picker.onRegionSelected((region) => {
	if (region.mode === "snip") {
		return snipPopup?.open(region.rect) ? "keep" : undefined;
	}
	void live.start(region.rect);
	return undefined;
});

const diagnostics = () =>
	buildDiagnostics({
		appInfo,
		locale,
		displays: readDisplays,
		providers,
		providersConfig: () => appSettings.current.providers,
		state: () => ({
			settingsSource: loadedSettings.source,
			settingsWarnings: loadedSettings.warnings.length,
			logLevel: log.level,
			logOverride: logs.overrides.level ?? "none",
			screenTextLogging: logs.overrides.screenText,
			logLinesDropped: logs.file.dropped,
			logsDir: logs.file.dir,
			// Counters only, never text (GLIM-20 stats).
			translationCache: translation.caches.stats(),
			translationProviders: translation.chain.map((p) => `${p.info.id}:${p.status.state}`),
			private: translation.private,
			live: live.status,
			// Counters and timings only (GLIM-58 per-grab costs), never text.
			liveStats: live.stats(),
			liveFrame: frameNatives.status,
		}),
		logTail: () => logs.file.tail(200),
		redactor: log.redactor,
	});

// Command bus (GLIM-41): the tray (and later hotkeys, popups, Settings) dispatch; features
// handle. Snip (GLIM-65) owns snip.*, Live (GLIM-59, services/live/live-service.ts) owns live.*;
// they call `translation.snip()` / `translation.openLive()`.
const commands = new CommandBus(log.child("commands"));
// The picker owns the start commands up to "region selected"; Snip / Live take it from there.
// A new Snip or Live hotkey closes an open Snip popup without restoring focus: the new
// picker takes over (snip-popup.md §7.4). Without screen access (GLIM-45) the picker would only
// show the wallpaper, so the screen-access window opens instead.
commands.handle("snip.start", () => {
	snipPopup?.dismiss(null, "hotkey");
	whenScreenAccess(() => picker?.toggle("snip"))();
});
commands.handle("live.start", () => {
	snipPopup?.dismiss(null, "hotkey");
	// live-popup.md §6.3: the Live hotkey stops a pinned session; otherwise it opens the picker.
	if (live.active && !picker?.isOpen) live.stop();
	else whenScreenAccess(() => picker?.toggle("live"))();
});
commands.handle("screen-access.open", () => onboarding.open("screen-access"));
commands.handle("onboarding.open", () => onboarding.open("setup"));
commands.handle("live.stop", () => live.stop());
commands.handle("live.pause", () => live.pause("user"));
commands.handle("live.resume", () => live.resume());
commands.handle("cache.clear", () => translation.clearCache("user"));
commands.handle("settings.open", () => settings.open());
commands.handle("diagnostics.copy", () => {
	Utils.clipboardWriteText(diagnostics());
	log.info("diagnostics copied to the clipboard");
});
commands.handle("logs.open", () => {
	if (!Utils.openPath(logs.file.dir)) log.warn("could not open the logs folder", { dir: logs.file.dir });
});
commands.handle("app.quit", () => {
	log.info("quit");
	void translation.dispose();
	hotkeys.dispose();
	snipPopup?.dispose();
	popupWindow.close();
	picker?.dispose();
	pickerNatives.sampler.stop();
	live.dispose();
	capture.source.dispose();
	logs.file.close();
	Utils.quit();
});

// Problems and unfinished setup, listed first in the tray (GLIM-45, GLIM-76).
const trayNotices = () =>
	[screenAccessNotice(screenAccess.state), finishSetupNotice(appSettings.current.onboarding)].filter((n) => n !== null);

const firstTranslator = () => {
	const id = appSettings.current.providers.translation[0];
	const factory = id ? providers.get(id) : undefined;
	return factory ? { name: factory.info.name, kind: factory.info.kind } : null;
};
// GLIM-80: a cloud OCR provider sends screen images; the tray says so too.
const cloudOcr = () => {
	const id = appSettings.current.providers.ocr;
	const factory = id ? providers.get(id) : undefined;
	return factory?.info.kind === "cloud" ? factory.info.name : null;
};

const tray = createTray(
	{
		platform,
		live: "off",
		// App-wide Private state (GLIM-20), owned by the translation service; the Live popup toggle shares it.
		private: translation.private,
		translation: firstTranslator(),
		cloudOcr: cloudOcr(),
		hotkeys: { snip: loadedSettings.settings.hotkeys.snip, live: loadedSettings.settings.hotkeys.live },
		taskbarTheme: "dark",
		notices: trayNotices(),
	},
	commands,
);
screenAccess.subscribe(() => tray.update({ notices: trayNotices() }));
appSettings.subscribe((next, previous) => {
	if (next.onboarding !== previous.onboarding) tray.update({ notices: trayNotices() });
});

// GLIM-70: the tray offers a newer release; the first check waits a minute after start, then
// the checker is asked hourly and only goes to GitHub once a day.
commands.handle("update.open", () => {
	if (!openUpdatePage()) log.warn("could not open the release page");
});
updates.subscribe((s) => tray.update({ update: s.state === "available" ? { version: s.release.version } : null }));
appSettings.subscribe((next, previous) => {
	if (next.updates.check !== previous.updates.check) {
		updates.settingsChanged();
		if (next.updates.check) void updates.checkIfDue();
	}
});
void updates.load();
setTimeout(() => void updates.checkIfDue(), 60_000);
setInterval(() => void updates.checkIfDue(), 60 * 60_000);

// The service updates the tray through onPrivateChange.
commands.handle("private.toggle", () => translation.setPrivate(!translation.private));

void hotkeyRegistrar.apply(loadedSettings.settings.hotkeys);

// Settings changes apply without a restart (GLIM-69).
appSettings.subscribe((next, previous) => {
	if (next.diagnostics.logLevel !== previous.diagnostics.logLevel) logs.applySettingsLevel(next.diagnostics.logLevel);
	if (next.privacy.hideFromCapture !== previous.privacy.hideFromCapture) {
		exclusion.setHideFromCapture(next.privacy.hideFromCapture);
	}
	if (next.hotkeys !== previous.hotkeys) tray.update({ hotkeys: { snip: next.hotkeys.snip, live: next.hotkeys.live } });
});

// GLIM-108: providers, languages and the idle wipe apply to the translation service at once.
appSettings.subscribe((next, previous) => {
	void translation.applySettings(next, previous);
	if (next.providers !== previous.providers) tray.update({ translation: firstTranslator(), cloudOcr: cloudOcr() });
});

// Settings › Live (fps, diff threshold, stability) and language changes reach a pinned session at once.
appSettings.subscribe((next, previous) => live.applySettings(next, previous));

// GLIM-106: a menu-bar app on macOS. LSUIElement (scripts/mac-accessory.ts) starts it as an
// accessory app; this is the backstop for builds without it. Electrobun shows the Dock icon
// again when the app is re-opened from Finder or Spotlight, so hide it again and open
// Settings, the usual answer of a menu-bar app to being launched twice.
if (platform === "macos") {
	Utils.setDockIconVisible(false);
	Electrobun.events.on("reopen", () => {
		Utils.setDockIconVisible(false);
		void commands.dispatch("settings.open", "internal");
	});
}

if (platform === "windows") {
	watchTaskbarTheme((taskbarTheme) => tray.update({ taskbarTheme }));
}

// Launch (GLIM-76): first-run setup until it is finished or skipped, resuming at the saved
// step. After an update an unsigned build has lost Screen Recording (GLIM-45): say so at
// once. Otherwise Glimpse starts quietly in the tray / menu bar.
if (opensAtLaunch(appSettings.current.onboarding)) onboarding.open("setup");
else if (screenAccess.refresh().state === "lost") onboarding.open("screen-access");

log.info("started", {
	version: appInfo.version,
	platform,
	bun: appInfo.bun,
	electrobun: appInfo.electrobun,
	displays: readDisplays().length,
	settings: loadedSettings.source,
	logLevel: log.level,
	capture: capture.status,
	picker: pickerNatives.status,
	liveFrame: frameNatives.status,
	hotkeys: hotkeys.backendName,
});
