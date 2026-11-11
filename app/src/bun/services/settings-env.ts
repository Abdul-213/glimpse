// Machine-dependent inputs to the core settings schema: GLIM-23 hotkeys for this OS, the
// target language from the OS locale, and the installed providers. Pure, so it is tested
// without Electrobun.

import { DEFAULT_HOTKEYS, defaultTargetLanguage, type ProviderRegistry, type SettingsEnv } from "@glimpse/core";
import type { Platform } from "../../shared/rpc.ts";

export function settingsEnvFor(
	platform: Platform,
	locale: string | undefined,
	providers: ProviderRegistry<unknown>,
): SettingsEnv {
	return {
		// Linux is a dev target only; it gets the Windows-style bindings.
		hotkeys: platform === "macos" ? DEFAULT_HOTKEYS.macos : DEFAULT_HOTKEYS.windows,
		providers: providers.configSchema(),
		targetLanguage: defaultTargetLanguage(locale),
	};
}
