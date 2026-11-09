// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadSettings, opensAtLaunch, ProviderRegistry, parseModelManifest, systemTimers } from "@glimpse/core";
import { FASTTEXT_MODEL_ID } from "@glimpse/providers/language-detect";
import Electrobun, { Screen, Utils } from "electrobun/main";
import modelManifestJson from "../../models/manifest.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };
import { INSTALL_GUIDE_URL } from "../shared/onboarding-rpc.ts";
import type { AppInfo } from "../shared/rpc.ts";
import { CommandBus } from "./commands.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { loadAnnounceNative } from "./native/announce.ts";
import { exclusionOpsFor } from "./native/exclusion.ts";
import { frameNativesFor } from "./native/frame.ts";
import { loadMacNative } from "./native/macos.ts";
import { overlayOpsFor } from "./native/overlay.ts";
import { loadWindowsCapture, loadWindowsChrome } from "./native/windows.ts";
import { platform } from "./platform.ts";
import { AppSettings } from "./services/app-settings.ts";
import { reportingCapture } from "./services/capture/capture-report.ts";
import { withDeniedReport } from "./services/capture/denied-report.ts";
import { createCaptureSource } from "./services/capture/index.ts";
import { MaskedCaptureSource } from "./services/capture/masked.ts";
import { CloudSettings } from "./services/cloud-settings.ts";
import { CloudUsage, fileCloudUsageStore } from "./services/cloud-usage.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { HotkeyService } from "./services/hotkeys.ts";
import { CarbonHotkeyBackend } from "./services/hotkeys-carbon.ts";
import { ElectrobunHotkeyBackend } from "./services/hotkeys-electrobun.ts";
import { liveHotkeyHandlers, ServiceHotkeyRegistrar } from "./services/hotkeys-port.ts";
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
import { PresenceTracker } from "./services/session/presence.ts";
import { SystemSession } from "./services/session/system-session.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { watchTaskbarTheme } from "./services/taskbar-theme.ts";
import { ModelManagerPackSource } from "./services/translation/bergamot-packs.ts";
import { loadPackCatalogue } from "./services/translation/pack-catalogue.ts";
import { pipelineStages } from "./services/translation/pipeline-stages.ts";
import { small100Entry } from "./services/translation/small100-model.ts";
import { TranslationPacks } from "./services/translation/translation-packs.ts";
import { TranslationService, warmPairsFor } from "./services/translation/translation-service.ts";
import { fileUpdateStateStore, UpdateChecker } from "./services/update-check.ts";
import { createTray } from "./tray.ts";
import { finishSetupNotice } from "./tray-menu.ts";
import { CaptureExclusion } from "./windows/capture-exclusion.ts";
import { LiveAnnouncements } from "./windows/live-announcements.ts";
import { ElectrobunLivePopupWindow } from "./windows/live-popup.ts";
import { LivePopupController, liveViewInit } from "./windows/live-popup-controller.ts";
import { OnboardingWindow } from "./windows/onboarding.ts";
import { electrobunOverlayFactory, screenProbe } from "./windows/picker.ts";
import { PickerController, pickerSettingsFrom } from "./windows/picker-controller.ts";
import { ElectrobunPopupWindow } from "./windows/popup.ts";
import { SnipPopupController } from "./windows/popup-controller.ts";
import { snipViewInit } from "./windows/popup-init.ts";
import { SettingsWindow } from "./windows/settings.ts";
import { providerSummaries } from "./windows/settings-handlers.ts";
import { WindowChrome } from "./windows/window-chrome.ts";

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
// The spend guard (GLIM-120): this month's Vision images and Translation characters, counted
// locally in <userData>/cloud-usage.json and never sent anywhere.
const cloudUsage = new CloudUsage({
	store: fileCloudUsageStore(Utils.paths.userData),
	cap: () => appSettings.current.cloud.spendCap,
	log: log.child("cloud-usage"),
});
void cloudUsage.load();
const {
	ctx: providerCtx,
	bergamotWorker,
	ocrWorker,
	small100Worker,
} = providerContext({
	packs: bergamotPacks,
	// PaddleOCR (GLIM-103) reads its model files through the model manager.
	models,
	mainDir: import.meta.dir,
	warmPairs: () => warmPairsFor(appSettings.current),
	log: translationLog,
	secrets,
	usage: cloudUsage,
});
const translationPacks = new TranslationPacks({
	manager: models,
	packs: bergamotPacks,
	chain: () => translation.chain,
	// GLIM-100: a long-tail pack row downloads the SMaLL-100 model.
	models: [small100Entry()].filter((m) => m !== null),
});
// Language detection (GLIM-104): fastText joins ELD once its model is downloaded.
const stages = pipelineStages(translationLog, {
	fastTextDir: () => models.modelDir(FASTTEXT_MODEL_ID),
	mainDir: import.meta.dir,
});
models.subscribe((id, state) => {
	if (id !== FASTTEXT_MODEL_ID || (state.status !== "installed" && state.status !== "missing")) return;
	stages.detector.invalidate();
	void stages.detector.load();
});
const translation: TranslationService<AppProviderContext> = new TranslationService({
	registry: providers,
	ctx: providerCtx,
	settings: () => appSettings.current,
	log: translationLog,
	readinessOf: (from, to) => translationPacks.readiness(from, to),
	// GLIM-109: GLIM-56 grouping and GLIM-21 detection over ELD.
	...stages,
	onPrivateChange: (on) => {
		tray.update({ private: on });
		// `livePopup` is declared below; Private only changes once the app runs.
		livePopup?.privateChanged(on);
	},
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
			small100Worker: small100Worker ?? "default (source tree)",
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
// read through `screen`, which paints over Glimpse windows the OS lets into a frame. Under it,
// a `permission-denied` capture means Screen Recording was turned off while running, so
// ScreenAccess shows its notice and window (GLIM-45, GLIM-121); `screenAccess` is declared
// below and this only runs on a failed capture.
exclusion.setHideFromCapture(loadedSettings.settings.privacy.hideFromCapture);
const screen = new MaskedCaptureSource(
	withDeniedReport(capture.source, () => screenAccess.reportCaptureDenied()),
	() => exclusion.maskRects(),
);

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
// Native window chrome (GLIM-116, GLIM-110): materials, cloaked hide, popup edges, and the
// theme from Settings › General (System / Light / Dark) applied to every window at once.
const chromeLog = log.child("chrome");
const chrome = new WindowChrome({
	os: platform,
	native: platform === "macos" ? (macNative?.binding ?? null) : platform === "windows" ? loadWindowsChrome() : null,
	theme: () => appSettings.current.appearance.theme,
	log: (message) => chromeLog.info(message),
});
appSettings.subscribe((next, previous) => {
	if (next.appearance.theme !== previous.appearance.theme) chrome.themeChanged();
});
// Settings talks to the hotkey service through the HotkeyRegistrar port: it applies the
// bindings with the actions' handlers and reports per-action status (GLIM-69). `commands` is
// declared below; the handlers only run on a key press.
const hotkeyRegistrar = new ServiceHotkeyRegistrar(hotkeys, {
	snip: () => void commands.dispatch("snip.start", "hotkey"),
	live: () => void commands.dispatch("live.start", "hotkey"),
	// GLIM-130: optional, unbound by default (Settings › Shortcuts). `live` is declared below.
	...liveHotkeyHandlers(
		(command) => void commands.dispatch(command, "hotkey"),
		() => ({ active: live.active, paused: live.status === "paused" || live.status === "error" }),
	),
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
	usage: cloudUsage,
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
	chrome,
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
	chrome,
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
	// GLIM-156: a hidden overlay is replaced, never re-shown (see recycleOverlays).
	recycleOverlays: platform === "windows",
});
picker.prepare();
// Snip popup (GLIM-65): one hidden window created now, reused for every Snip. A confirmed
// Snip region runs through the translation pipeline and streams into it; the overlays stay
// up under it as the results layer until it closes.
const popupLog = log.child("popup");
// GLIM-156: one line per Snip capture (black ratio, plan, overlay states) for blank reports.
const snipScreen = reportingCapture(screen, {
	log: captureLog,
	context: () => ({
		status: capture.status,
		overlays: picker?.overlayStates() ?? [],
		excludedWindowIds: exclusion.windowIds.length,
		masks: exclusion.maskRects().length,
		hideFromCapture: exclusion.hideFromCapture,
	}),
});
let snipPopup: SnipPopupController | null = null;
const popupWindow = new ElectrobunPopupWindow({
	exclusion,
	init: snipViewInit(platform),
	controller: () => snipPopup,
	displays: readDisplays,
	log: (message) => popupLog.info(message),
	chrome,
	// GLIM-158: the On screen hint shows on one Snip after install, then never again.
	overlayHint: {
		offered: () => !appSettings.current.onboarding.overlayHintSeen,
		seen: () => {
			if (!appSettings.current.onboarding.overlayHintSeen)
				void appSettings.update({ onboarding: { overlayHintSeen: true } });
		},
	},
});
snipPopup = new SnipPopupController({
	window: popupWindow,
	displays: readDisplays,
	runner: {
		snip: (rect, onEvent, signal, runId) => translation.snip(snipScreen, rect, onEvent, signal, runId),
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
		// The spend guard's "Continue this month" (GLIM-120).
		continueCloud: () => cloudSettings.continueCloud(),
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
		showOnScreen: appSettings.current.snip.showOnScreen,
		uiDir: "ltr",
	}),
	pointer: () => screenProbe.cursor(),
	// "Sent to Google" when the full name doesn't fit (GLIM-80): the registry's vendor.
	providerShortName: (id) => providers.get(id)?.info.vendor ?? null,
	log: popupLog,
});
// A press on the results layer is a click outside the popup (snip-popup.md §5).
// GLIM-152: a press on a box or its badge picks that block in the popup instead; hovering a
// box lights its popup block.
picker.onResultsPointerDown((blockId) => snipPopup?.screenPress(blockId));
picker.onResultsHover((blockId) => snipPopup?.screenHover(blockId));
// Live (GLIM-48/58/59/90): a Live region is pinned. The service runs the capture loop, change
// detection and the pipeline session, draws the native frame around the region and emits typed
// session events (logged for now; the docked popup, GLIM-79, renders them).
const liveLog = log.child("live");
const frameNatives = frameNativesFor(readDisplays);
const live = new LiveService({
	capture: screen,
	openPipeline: (o) => translation.openLive(() => {}, o),
	// GLIM-79: the cloud consent (live-popup.md L10) and the popup's cloud row.
	providers: () => {
		const ref = (p: { info: { id: string; kind: "local" | "cloud"; name: string } } | null | undefined) =>
			p ? { id: p.info.id, kind: p.info.kind, name: p.info.name } : null;
		return { ocr: ref(translation.ocr), translation: ref(translation.chain[0]) };
	},
	rememberConsent: (id) => {
		const remembered = appSettings.current.cloud.liveConsent;
		if (!remembered.includes(id)) void appSettings.update({ cloud: { liveConsent: [...remembered, id] } });
	},
	private: () => translation.private,
	// GLIM-122: "Use on-device" with a cloud OCR provider reads with the local one.
	canReadLocally: () => translation.canReadLocally,
	prepareLocalOnly: () => translation.prepareLocalOcr(),
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
	onState: (state) => tray.update({ live: state, ...(state === "off" ? { livePopupHidden: false } : {}) }),
	perfNow: () => performance.now(),
});
// The docked Live popup (GLIM-79): one hidden window created now, reused for every session.
let livePopup: LivePopupController | null = null;
const livePopupWindow = new ElectrobunLivePopupWindow({
	exclusion,
	init: liveViewInit(platform),
	controller: () => livePopup,
	displays: readDisplays,
	log: (message) => liveLog.info(message),
	chrome,
});
livePopup = new LivePopupController({
	window: livePopupWindow,
	live,
	displays: readDisplays,
	settings: () => ({
		reducedMotion: appSettings.current.appearance.motion === "reduced",
		uiDir: "ltr",
		// GLIM-154: the same setting as Snip; the cards are in the target language.
		showOnScreen: appSettings.current.snip.showOnScreen,
		target: appSettings.current.language.target,
		update: appSettings.current.live.update,
	}),
	// GLIM-157: the popup's Update toggle is Settings › Live › Update.
	setUpdateMode: (mode) => void appSettings.update({ live: { update: mode } }),
	setPrivate: (on) => translation.setPrivate(on),
	// L18: the session pauses while the picker is open; a new area replaces it, Esc resumes
	// it as it was (a session the user had paused stays paused).
	repin: () => {
		const wasRunning = live.status !== "paused" && live.status !== "error";
		if (wasRunning) live.pause("user");
		const off = picker?.onOutcome((o) => {
			off?.();
			if (o.kind === "cancelled" && wasRunning && live.active) live.resume("user");
		});
		picker?.open("live");
	},
	focus: pickerNatives.focus,
	// Manual Ctrl/⌘C only: Live never copies by itself (GLIM-71).
	clipboard: { writeText: (text) => Utils.clipboardWriteText(text) },
	eol: platform === "windows" ? "\r\n" : "\n",
	// GLIM-123 (L12): the pack row's Download, the same consent path as Snip (GLIM-57).
	packs: translationPacks,
	// GLIM-131: "Edit source languages…" on the skipped line.
	openSettings: (section) => settings.open(section),
	// GLIM-120: the spend guard's "Continue this month".
	continueCloud: () => cloudSettings.continueCloud(),
	// GLIM-151: drags follow the OS cursor; the moved offset is remembered per display.
	cursor: () => Screen.getCursorScreenPoint(),
	offsets: {
		get: () => appSettings.current.live.popupOffsets,
		set: (popupOffsets) => void appSettings.update({ live: { popupOffsets: [...popupOffsets] } }),
	},
	log: liveLog.child("popup"),
});
// GLIM-92: Live changes read aloud (live-popup.md §10): the view's live regions plus the
// OS announcement while the popup isn't focused. Default: on when a screen reader runs.
const liveAnnouncements = new LiveAnnouncements({
	popup: livePopup,
	post: (sessionId, text, kind) => livePopupWindow.announce(sessionId, text, kind),
	speak: (text, kind) => livePopupWindow.speak(text, kind),
	screenReaderActive: () => loadAnnounceNative().native?.screenReaderActive() ?? null,
	mode: () => appSettings.current.live.announceChanges,
	timers: systemTimers,
	log: liveLog.child("a11y"),
});
picker.onRegionSelected((region) => {
	if (region.mode === "snip") {
		return snipPopup?.open(region.rect) ? "keep" : undefined;
	}
	void live.start(region.rect);
	return undefined;
});

// Screen lock / unlock and sleep / wake (GLIM-119) from the native helpers: Live pauses at
// once ("Paused while the screen was locked", L17) and resumes when the user is back, unless
// they had paused it themselves; the translation cache is wiped on each lock and sleep when
// Settings › Privacy says so (GLIM-20, GLIM-107). PresenceTracker folds the OS's overlapping
// notifications.
const sessionNative = platform === "macos" ? macNative : platform === "windows" ? loadWindowsCapture() : null;
const systemSession = new SystemSession({
	binding: sessionNative?.binding ?? null,
	unavailableReason:
		sessionNative && !sessionNative.status.available ? sessionNative.status.reason : `no native helper on ${platform}`,
	log: log.child("session"),
});
const presence = new PresenceTracker(
	{
		pause: (reason) => live.pause(reason),
		resume: (reason) => live.resume(reason),
		wipe: (reason) => void translation.wipeForAway(reason),
	},
	systemTimers,
);
systemSession.subscribe((event) => presence.handle(event.kind));
systemSession.start();

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
			systemSession: systemSession.status.state,
			presence: presence.state,
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
// GLIM-157: Refresh (popup button, Ctrl/⌘R in the popup, the optional hotkey, the tray).
commands.handle("live.refresh", () => live.refresh("user"));
// GLIM-81: the tray mirrors the popup (live-popup.md §6.3).
commands.handle("live.popup.toggle", () => {
	const hidden = !livePopup?.hidden;
	livePopup?.setHidden(hidden);
	tray.update({ livePopupHidden: hidden });
});
commands.handle("live.popup.focus", () => {
	livePopup?.focusPopup();
	tray.update({ livePopupHidden: false });
});
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
	void cloudUsage.flush();
	void translation.dispose();
	hotkeys.dispose();
	snipPopup?.dispose();
	popupWindow.close();
	picker?.dispose();
	pickerNatives.sampler.stop();
	presence.dispose();
	systemSession.dispose();
	liveAnnouncements.dispose();
	livePopup?.dispose();
	livePopupWindow.close();
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
		showOnScreen: appSettings.current.snip.showOnScreen,
		liveManual: appSettings.current.live.update === "manual",
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

// GLIM-158: the tray's Show translations on screen is Settings › General's switch (new Snips
// and Live sessions open with it); a running Live session follows it at once.
commands.handle("overlay.toggle", () => {
	void appSettings.update({ snip: { showOnScreen: !appSettings.current.snip.showOnScreen } });
});
appSettings.subscribe((next, previous) => {
	if (next.snip.showOnScreen === previous.snip.showOnScreen) return;
	tray.update({ showOnScreen: next.snip.showOnScreen });
	livePopup?.setOverlay(next.snip.showOnScreen);
});
appSettings.subscribe((next, previous) => {
	if (next.live.update === previous.live.update) return;
	tray.update({ liveManual: next.live.update === "manual" });
	livePopup?.settingsChanged();
});

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
	systemSession: systemSession.status.state,
	hotkeys: hotkeys.backendName,
});
