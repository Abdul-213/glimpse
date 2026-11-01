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
import { platform } from "./platform.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { createAppLogger } from "./services/log.ts";
import { ModelManager } from "./services/models/model-manager.ts";
import { bundledModelsDir, modelsRoot } from "./services/models/paths.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { watchTaskbarTheme } from "./services/taskbar-theme.ts";
import { createTray } from "./tray.ts";
import { SettingsWindow } from "./windows/settings.ts";

const logs = createAppLogger({ dir: Utils.paths.userLogs });
const log = logs.logger;
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

// Provider implementations (packages/providers, GLIM-46/47 and later) register here.
const providers = new ProviderRegistry<unknown>();

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
const models = new ModelManager({
	root: modelsRoot(Utils.paths.userData),
	bundledDir: bundledModelsDir(import.meta.dir),
});
models
	.scan()
	.then(() => log.child("models").info("scan complete", { installed: models.installedIds().length }))
	.catch((error) => log.child("models").warn("model scan failed", { error }));

const settings = new SettingsWindow(appInfo);

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
		}),
		logTail: () => logs.file.tail(200),
		redactor: log.redactor,
	});

// Command bus (GLIM-41): the tray (and later hotkeys, popups, Settings) dispatch; features
// handle. Snip (GLIM-48), Live (GLIM-56) and the cache (GLIM-67) replace the stubs below.
const commands = new CommandBus(log.child("commands"));
const stub = (command: string) => () => log.info("not implemented yet", { command });
commands.handle("snip.start", stub("snip.start"));
commands.handle("live.start", stub("live.start"));
commands.handle("live.stop", stub("live.stop"));
commands.handle("live.pause", stub("live.pause"));
commands.handle("live.resume", stub("live.resume"));
commands.handle("cache.clear", stub("cache.clear"));
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
		// App-wide Private state (GLIM-20); the Live popup toggle will share it.
		private: loadedSettings.settings.privacy.privateByDefault,
		translation: firstTranslator(),
		hotkeys: { snip: loadedSettings.settings.hotkeys.snip, live: loadedSettings.settings.hotkeys.live },
		taskbarTheme: "dark",
	},
	commands,
);

commands.handle("private.toggle", () => {
	tray.update({ private: !tray.state.private });
	log.info("private mode", { on: tray.state.private });
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
});
