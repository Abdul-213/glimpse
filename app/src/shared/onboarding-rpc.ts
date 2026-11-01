// Onboarding window RPC (GLIM-45 screen access, GLIM-76 first-run setup). Types only, plain
// JSON (ARCHITECTURE.md §5). Main owns the state; the view renders snapshots and pushes and
// sends intents back as requests whose responses say what actually happened.

import type { ScreenAccessState } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { AppInfo } from "./rpc.ts";

/** Where the install guide lives (GLIM-63), linked from the unsigned-build notes. */
export const INSTALL_GUIDE_URL = "https://github.com/Abdul-213/glimpse/blob/develop/docs/install.md";

export interface ScreenAccessStatus {
	readonly state: ScreenAccessState;
	/** The user opened System Settings from Glimpse in this run: a restart may be all that's left. */
	readonly settingsOpened: boolean;
	/** Glimpse can quit and reopen itself (it runs from its app bundle). */
	readonly canRestart: boolean;
}

/**
 * Why the window is open:
 * - `screen-access`  only the permission step (tray "Allow Screen Access…", a Snip or Live
 *                    start without access, or access lost after an update)
 */
export type OnboardingMode = "screen-access";

export interface OnboardingSnapshot {
	readonly app: AppInfo;
	readonly mode: OnboardingMode;
	readonly screenAccess: ScreenAccessStatus;
}

export type OnboardingActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type OnboardingRPC = {
	bun: RPCSchema<{
		requests: {
			getSnapshot: { params: undefined; response: OnboardingSnapshot };
			/** Ask macOS (shows the system prompt only the first time), else open System Settings. */
			requestScreenAccess: { params: undefined; response: ScreenAccessStatus };
			openScreenAccessSettings: { params: undefined; response: ScreenAccessStatus };
			/** Re-check now (the window regained focus). */
			refreshScreenAccess: { params: undefined; response: ScreenAccessStatus };
			/** Quit and reopen Glimpse so a new grant takes effect. */
			restartApp: { params: undefined; response: OnboardingActionResult };
			openInstallGuide: { params: undefined; response: OnboardingActionResult };
		};
		messages: {
			closeOnboarding: undefined;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			screenAccessChanged: ScreenAccessStatus;
		};
	}>;
};
