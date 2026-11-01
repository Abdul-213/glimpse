import { describe, expect, test } from "bun:test";
import {
	DEFAULT_HOTKEYS,
	languageCode,
	nextStep,
	offersFinishSetup,
	onboardingSteps,
	opensAtLaunch,
	ProviderRegistry,
	parseSettings,
	previousStep,
	resumeStep,
	type SettingsEnv,
	stripSteps,
} from "../src/index.ts";

describe("GLIM-76 onboarding flow", () => {
	const mac = onboardingSteps({ screenAccessStep: true });
	const win = onboardingSteps({ screenAccessStep: false });

	test("macOS has a screen-access step, Windows doesn't", () => {
		expect(mac).toEqual(["welcome", "screen-access", "language", "downloads", "shortcuts", "done"]);
		expect(win).toEqual(["welcome", "language", "downloads", "shortcuts", "done"]);
		expect(stripSteps(mac)).toEqual(["screen-access", "language", "downloads", "shortcuts"]);
		expect(stripSteps(win)).toEqual(["language", "downloads", "shortcuts"]);
	});

	test("next and back stay inside the flow", () => {
		expect(nextStep(mac, "welcome")).toBe("screen-access");
		expect(nextStep(win, "welcome")).toBe("language");
		expect(nextStep(mac, "done")).toBe("done");
		expect(previousStep(mac, "language")).toBe("screen-access");
		expect(previousStep(mac, "welcome")).toBe("welcome");
	});

	test("resume at the saved step, or the first one this OS has", () => {
		expect(resumeStep(mac, "downloads")).toBe("downloads");
		expect(resumeStep(win, "screen-access")).toBe("welcome");
		expect(resumeStep(win, "nonsense")).toBe("welcome");
	});

	test("opens at launch until finished or skipped; the tray offers it until finished", () => {
		expect(opensAtLaunch({ completed: false, dismissed: false })).toBe(true);
		expect(opensAtLaunch({ completed: false, dismissed: true })).toBe(false);
		expect(opensAtLaunch({ completed: true, dismissed: false })).toBe(false);
		expect(offersFinishSetup({ completed: false, dismissed: true })).toBe(true);
		expect(offersFinishSetup({ completed: true, dismissed: false })).toBe(false);
	});

	test("settings keep the step; a bad step falls back to welcome", () => {
		const env: SettingsEnv = {
			hotkeys: DEFAULT_HOTKEYS.macos,
			providers: new ProviderRegistry().configSchema(),
			targetLanguage: languageCode("en"),
		};
		const ok = parseSettings({ onboarding: { step: "downloads", languages: ["ja"] } }, env);
		expect(ok.settings.onboarding.step).toBe("downloads");
		expect(ok.settings.onboarding.languages).toEqual([languageCode("ja")]);
		const bad = parseSettings({ onboarding: { step: "teleport" } }, env);
		expect(bad.settings.onboarding.step).toBe("welcome");
		expect(bad.issues.length).toBe(1);
	});
});
