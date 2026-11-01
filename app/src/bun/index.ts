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
import { ModelManager } from "./services/models/model-manager.ts";
import { bundledModelsDir, modelsRoot } from "./services/models/paths.ts";
import { settingsEnvFor } from "./services/settings-env.ts";
import { FileSettingsStore } from "./services/settings-store.ts";
import { createTray } from "./tray.ts";
import { SettingsWindow } from "./windows/settings.ts";

// Provider implementations (packages/providers, GLIM-46/47 and later) register here.
const providers = new ProviderRegistry<unknown>();

const settingsStore = FileSettingsStore.inDirectory(Utils.paths.userData);
const settingsEnv = settingsEnvFor(platform, Intl.DateTimeFormat().resolvedOptions().locale, providers);
const loadedSettings = await loadSettings(settingsStore, settingsEnv);
for (const warning of loadedSettings.warnings) console.warn(`[glimpse] ${warning}`);

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
	.then(() => console.log(`[glimpse] models in ${models.root}: ${models.installedIds().join(", ") || "none"}`))
	.catch((err) => console.warn("[glimpse] model scan failed", err));

const settings = new SettingsWindow(appInfo);

createTray(platform, (action) => {
	switch (action) {
		case "settings":
			settings.open();
			break;
		case "quit":
			Utils.quit();
			break;
	}
});

// Until onboarding (GLIM-76) exists, show Settings on launch so a start is visible.
settings.open();

console.log(
	`[glimpse] started ${appInfo.version} on ${platform} (bun ${appInfo.bun}), displays: ${readDisplays().length}, settings: ${loadedSettings.source}`,
);
