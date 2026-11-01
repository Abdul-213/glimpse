// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadSettings, ProviderRegistry, parseModelManifest } from "@glimpse/core";
import { Utils } from "electrobun/main";
import modelManifestJson from "../../models/manifest.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };
import type { AppInfo } from "../shared/rpc.ts";
import { CommandBus } from "./commands.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { exclusionOpsFor } from "./native/exclusion.ts";
import { loadMacNative } from "./native/macos.ts";
import { overlayOpsFor } from "./native/overlay.ts";
import { platform } from "./platform.ts";
import { AppSettings } from "./services/app-settings.ts";
import { createCaptureSource } from "./services/capture/index.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { HotkeyService } from "./services/hotkeys.ts";
import { CarbonHotkeyBackend } from "./services/hotkeys-carbon.ts";
import { ElectrobunHotkeyBackend } from "./services/hotkeys-electrobun.ts";
import { ServiceHotkeyRegistrar } from "./services/hotkeys-port.ts";
import { createAppLogger } from "./services/log.ts";
import { LoginItem, loginTarget, systemLoginItemIO } from "./services/login-item.ts";
import { loadBergamotCatalogue } from "./services/models/catalogue.ts";
import { ModelManager } from "./services/models/model-manager.ts";
import { ModelsSettings } from "./services/models/models-settings.ts";
import { bundledModelsDir, catalogueCacheFile, modelsRoot } from "./services/models/paths.ts";
import { createPickerNatives } from "./services/picker/index.ts";
import { type AppProviderContext, providerContext, registerProviders } from "./services/providers.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { watchTaskbarTheme } from "./services/taskbar-theme.ts";
import { ModelManagerPackSource } from "./services/translation/bergamot-packs.ts";
import { loadPackCatalogue } from "./services/translation/pack-catalogue.ts";
import { pipelineStages } from "./services/translation/pipeline-stages.ts";
import { TranslationPacks } from "./services/translation/translation-packs.ts";
import { TranslationService, warmPairsFor } from "./services/translation/translation-service.ts";
import { createTray } from "./tray.ts";
import { CaptureExclusion } from "./windows/capture-exclusion.ts";
import { electrobunOverlayFactory, screenProbe } from "./windows/picker.ts";
import { PickerController } from "./windows/picker-controller.ts";
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
const settings = new SettingsWindow(
	{
		appInfo,
		settings: appSettings,
		hotkeys: hotkeyRegistrar,
		loginItem,
		models: modelsSettings,
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
	settings: () => ({
		// Settings fields for these two land with GLIM-105; the spec defaults until then.
		confirmOnRelease: true,
		showLoupe: true,
		reducedMotion: loadedSettings.settings.appearance.motion === "reduced",
	}),
});
picker.prepare();
// Snip (GLIM-65) and Live (GLIM-59) subscribe to picker.onRegionSelected. Until they land:
// a Snip region runs through the translation pipeline (capture -> OCR -> detect -> translate)
// and its events are logged as types and counts only (never screen text); a Live region is
// just captured once, so the path to the capture service is exercised.
picker.onRegionSelected((region) => {
	if (region.mode === "snip") {
		translation
			.snip(capture.source, region.rect, (event) => {
				const counts =
					event.type === "detected"
						? { boxes: event.boxes.length }
						: event.type === "recognised"
							? { blocks: event.blocks.length }
							: event.type === "progress"
								? { done: event.done, total: event.total }
								: event.type === "done"
									? {
											blocks: event.result.blocks.length,
											translated: Object.keys(event.result.translations).length,
											error: event.result.error?.kind ?? null,
											totalMs: event.result.timings.totalMs,
										}
									: {};
				pickerLog.info("snip pipeline event (no popup yet, GLIM-65)", { type: event.type, ...counts });
			})
			.catch((error) => pickerLog.warn("snip pipeline failed", { error }));
		return undefined;
	}
	capture.source
		.capture(region.rect)
		.then((frame) =>
			pickerLog.info("region captured (no Snip/Live consumer yet)", {
				mode: region.mode,
				width: frame.width,
				height: frame.height,
				scale: frame.scale,
				pieces: region.pieces.length,
			}),
		)
		.catch((error) => pickerLog.warn("region capture failed", { error }));
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
		}),
		logTail: () => logs.file.tail(200),
		redactor: log.redactor,
	});

// Command bus (GLIM-41): the tray (and later hotkeys, popups, Settings) dispatch; features
// handle. Snip (GLIM-65) and Live (GLIM-48/56) replace the stubs below; they call
// `translation.snip()` / `translation.openLive()`.
const commands = new CommandBus(log.child("commands"));
const stub = (command: string) => () => log.info("not implemented yet", { command });
// The picker owns the start commands up to "region selected"; Snip / Live take it from there.
commands.handle("snip.start", () => picker?.toggle("snip"));
commands.handle("live.start", () => picker?.toggle("live"));
commands.handle("live.stop", stub("live.stop"));
commands.handle("live.pause", stub("live.pause"));
commands.handle("live.resume", stub("live.resume"));
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
	picker?.dispose();
	pickerNatives.sampler.stop();
	capture.source.dispose();
	logs.file.close();
	Utils.quit();
});

const firstTranslator = () => {
	const id = appSettings.current.providers.translation[0];
	const factory = id ? providers.get(id) : undefined;
	return factory ? { name: factory.info.name, kind: factory.info.kind } : null;
};

const tray = createTray(
	{
		platform,
		live: "off",
		// App-wide Private state (GLIM-20), owned by the translation service; the Live popup toggle shares it.
		private: translation.private,
		translation: firstTranslator(),
		hotkeys: { snip: loadedSettings.settings.hotkeys.snip, live: loadedSettings.settings.hotkeys.live },
		taskbarTheme: "dark",
	},
	commands,
);

// The service updates the tray through onPrivateChange.
commands.handle("private.toggle", () => translation.setPrivate(!translation.private));

void hotkeyRegistrar.apply(loadedSettings.settings.hotkeys);

// Settings changes apply without a restart (GLIM-69).
appSettings.subscribe((next, previous) => {
	if (next.diagnostics.logLevel !== previous.diagnostics.logLevel) logs.applySettingsLevel(next.diagnostics.logLevel);
	if (next.hotkeys !== previous.hotkeys) tray.update({ hotkeys: { snip: next.hotkeys.snip, live: next.hotkeys.live } });
});

// GLIM-108: providers, languages and the idle wipe apply to the translation service at once.
appSettings.subscribe((next, previous) => {
	void translation.applySettings(next, previous);
	if (next.providers !== previous.providers) tray.update({ translation: firstTranslator() });
});

if (platform === "windows") {
	watchTaskbarTheme((taskbarTheme) => tray.update({ taskbarTheme }));
}

// Until onboarding (GLIM-76) exists, show Settings on launch so a start is visible.
settings.open();

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
	hotkeys: hotkeys.backendName,
});
