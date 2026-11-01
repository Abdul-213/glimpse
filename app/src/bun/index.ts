// Glimpse main process entry (runs in Electrobun's Bun worker; the native event loop
// owns the OS main thread, see ARCHITECTURE.md "Process model").
//
// Composition root only: build services, wire them to the tray and windows. Logic
// lives in @glimpse/core; OS calls live in src/bun/native/ behind interfaces.
import { Utils } from "electrobun/main";
import pkg from "../../package.json" with { type: "json" };
import type { AppInfo } from "../shared/rpc.ts";
import { readDisplays } from "./displays.ts";
import { ELECTROBUN_VERSION } from "./electrobun-version.ts";
import { platform } from "./platform.ts";
import { createTray } from "./tray.ts";
import { SettingsWindow } from "./windows/settings.ts";

const appInfo: AppInfo = {
	name: "Glimpse",
	version: pkg.version,
	platform,
	electrobun: ELECTROBUN_VERSION,
	bun: Bun.version,
};

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
	`[glimpse] started ${appInfo.version} on ${platform} (bun ${appInfo.bun}), displays: ${readDisplays().length}`,
);
