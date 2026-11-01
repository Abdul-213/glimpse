// Onboarding window request handlers (GLIM-45, GLIM-76), separate from the Electrobun window
// so they are tested on Linux. Views are less trusted than main: every handler validates
// what it gets, and state lives in the services, not here.

import type {
	OnboardingActionResult,
	OnboardingMode,
	OnboardingSnapshot,
	ScreenAccessStatus,
} from "../../shared/onboarding-rpc.ts";
import type { AppInfo } from "../../shared/rpc.ts";
import type { ScreenAccess } from "../services/screen-access.ts";

export interface OnboardingDeps {
	readonly appInfo: AppInfo;
	readonly screenAccess: ScreenAccess;
	/** Open a web page in the default browser. */
	readonly openUrl: (url: string) => boolean;
	readonly installGuideUrl: string;
}

export function createOnboardingHandlers(deps: OnboardingDeps, mode: () => OnboardingMode) {
	const { screenAccess } = deps;
	return {
		getSnapshot: (): OnboardingSnapshot => ({
			app: deps.appInfo,
			mode: mode(),
			screenAccess: screenAccess.refresh(),
		}),
		requestScreenAccess: (): ScreenAccessStatus => screenAccess.request(),
		openScreenAccessSettings: (): ScreenAccessStatus => screenAccess.openSettings(),
		refreshScreenAccess: (): ScreenAccessStatus => screenAccess.refresh(),
		restartApp: (): OnboardingActionResult =>
			screenAccess.restart()
				? { ok: true }
				: { ok: false, message: "Glimpse can't restart itself here. Quit it from the menu bar and open it again." },
		openInstallGuide: (): OnboardingActionResult =>
			deps.openUrl(deps.installGuideUrl) ? { ok: true } : { ok: false, message: "Couldn't open the browser." },
	};
}

export type OnboardingHandlers = ReturnType<typeof createOnboardingHandlers>;
