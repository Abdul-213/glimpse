// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { loadSettings, ProviderRegistry } from "@glimpse/core";
import { Utils } from "electrobun/main";
import pkg from "../../package.json" with { type: "json" };
import type { AppInfo } from "../shared/rpc.ts";
import { CommandBus } from "./commands.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { exclusionOpsFor } from "./native/exclusion.ts";
import { platform } from "./platform.ts";
import { createCaptureSource } from "./services/capture/index.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { createAppLogger } from "./services/log.ts";
import { ModelManager } from "./services/models/model-manager.ts";
import { bundledModelsDir, catalogueCacheFile, modelsRoot } from "./services/models/paths.ts";
import { type AppProviderContext, providerContext, registerProviders } from "./services/providers.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { watchTaskbarTheme } from "./services/taskbar-theme.ts";
import { ModelManagerPackSource } from "./services/translation/bergamot-packs.ts";
import { loadPackCatalogue } from "./services/translation/pack-catalogue.ts";
import { TranslationPacks } from "./services/translation/translation-packs.ts";
import { TranslationService, warmPairsFor } from "./services/translation/translation-service.ts";
import { createTray } from "./tray.ts";
import { CaptureExclusion } from "./windows/capture-exclusion.ts";
import { SettingsWindow } from "./windows/settings.ts";

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

const appInfo: AppInfo = {
	name: "Glimpse",
	version: pkg.version,
	platform,
	electrobun: ELECTROBUN_VERSION,
	bun: Bun.version,
};

// Model download manager (GLIM-38). Consumers (OCR/translation providers, onboarding) come later.
// Seam: the storage location will come from settings (GLIM-53, GLIM-96); until then the default folder.
const modelsDir = modelsRoot(Utils.paths.userData);
const models = new ModelManager({ root: modelsDir, bundledDir: bundledModelsDir(import.meta.dir) });

// Translation (GLIM-101, GLIM-102): Bergamot over the model manager's packs, the core
// pipeline and the GLIM-20 caches. Providers load after the model scan, in the background.
const translationLog = log.child("translation");
const bergamotPacks = new ModelManagerPackSource(models);
const { ctx: providerCtx, bergamotWorker } = providerContext({
	packs: bergamotPacks,
	mainDir: import.meta.dir,
	warmPairs: () => warmPairsFor(loadedSettings.settings),
	log: translationLog,
});
const translationPacks = new TranslationPacks({
	manager: models,
	packs: bergamotPacks,
	chain: () => translation.chain,
});
const translation: TranslationService<AppProviderContext> = new TranslationService({
	registry: providers,
	ctx: providerCtx,
	settings: () => loadedSettings.settings,
	log: translationLog,
	readinessOf: (from, to) => translationPacks.readiness(from, to),
	onPrivateChange: (on) => tray.update({ private: on }),
});
translation.startTimers();
void loadPackCatalogue(bergamotPacks, catalogueCacheFile(modelsDir), { refresh: true, log: translationLog });
models
	.scan()
	.then(() => {
		log.child("models").info("scan complete", { installed: models.installedIds().length });
		translationLog.info("starting providers", { bergamotWorker: bergamotWorker ?? "default (source tree)" });
		return translation.start();
	})
	.catch((error) => log.child("models").warn("model scan failed", { error }));

// Capture (GLIM-36). Nothing captures yet: the Snip and Live pipelines (GLIM-48, GLIM-56)
// take `capture.source`. Every window controller gets `exclusion` so Glimpse never
// captures its own windows.
const captureLog = log.child("capture");
const capture = createCaptureSource({ shellDisplays: readDisplays, log: (message) => captureLog.info(message) });
const exclusion = new CaptureExclusion(exclusionOpsFor(), capture.source, (message) => captureLog.warn(message));

const settings = new SettingsWindow(appInfo, exclusion);

const diagnostics = () =>
	buildDiagnostics({
		appInfo,
		locale,
		displays: readDisplays,
		providers,
		providersConfig: () => loadedSettings.settings.providers,
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
commands.handle("snip.start", stub("snip.start"));
commands.handle("live.start", stub("live.start"));
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
	capture.source.dispose();
	logs.file.close();
	Utils.quit();
});

const firstTranslator = () => {
	const id = loadedSettings.settings.providers.translation[0];
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
});
