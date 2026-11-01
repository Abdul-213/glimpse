// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { loadSettings, ProviderRegistry } from "@glimpse/core";
import { Utils } from "electrobun/main";
import pkg from "../../package.json" with { type: "json" };
import type { AppInfo } from "../shared/rpc.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { platform } from "./platform.ts";
import { buildDiagnostics } from "./services/diagnostics.ts";
import { createAppLogger } from "./services/log.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
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

createTray(platform, (action) => {
	switch (action) {
		case "settings":
			settings.open();
			break;
		case "copy-diagnostics":
			Utils.clipboardWriteText(diagnostics());
			log.info("diagnostics copied to the clipboard");
			break;
		case "open-logs":
			if (!Utils.openPath(logs.file.dir)) log.warn("could not open the logs folder", { dir: logs.file.dir });
			break;
		case "quit":
			log.info("quit from tray");
			logs.file.close();
			Utils.quit();
			break;
	}
});

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
