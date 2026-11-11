// Onboarding window RPC (GLIM-45 screen access, GLIM-76 first-run setup). Types only, plain
// JSON (ARCHITECTURE.md §5). Main owns the state; the view renders snapshots and pushes and
// sends intents back as requests whose responses say what actually happened.

import type { HotkeyBindings, LanguageCode, OnboardingStep, ScreenAccessState } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { AppInfo } from "./rpc.ts";
import type { HotkeyStatus, LoginItemStatus, SetHotkeyParams, SetHotkeyResult } from "./settings-rpc.ts";

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
 * - `setup`          first-run setup (GLIM-76): welcome, screen access (macOS), target
 *                    language, downloads, shortcuts, done
 * - `screen-access`  only the permission step (tray "Allow Screen Access…", a Snip or Live
 *                    start without access, or access lost after an update)
 */
export type OnboardingMode = "setup" | "screen-access";

export interface LanguageChoice {
	readonly code: LanguageCode;
	/** In the UI language ("Japanese"). */
	readonly name: string;
	/** Its own name ("日本語"). */
	readonly nativeName: string;
}

/** One language to read, in the download step. */
export interface DownloadLanguage extends LanguageChoice {
	/**
	 * - `ready`        can be translated now (packs installed)
	 * - `available`    needs `bytes` of downloads
	 * - `downloading`  some of it is queued or downloading (`done` of `bytes`)
	 * - `failed`       a download failed (`message`)
	 * - `unavailable`  no language pack into the target
	 */
	readonly state: "ready" | "available" | "downloading" | "failed" | "unavailable";
	readonly bytes: number;
	readonly done: number;
	readonly message?: string;
}

export interface DownloadsSnapshot {
	/** Picked languages first (in pick order), then suggestions. */
	readonly languages: readonly DownloadLanguage[];
	/** Codes the user picked (persisted, so a resumed setup shows them again). */
	readonly picked: readonly LanguageCode[];
	/** Every language with a pack, for "Add a language". Empty until the catalogue loads. */
	readonly addable: readonly LanguageChoice[];
	readonly catalogue: "idle" | "loading" | "ready" | "cached" | "offline";
	/** Bytes of the picked languages' downloads that are running or queued, and how much is done. */
	readonly active: { readonly done: number; readonly total: number } | null;
	readonly freeBytes: number | null;
}

export interface SetupState {
	/** This OS's steps, in order. */
	readonly steps: readonly OnboardingStep[];
	readonly step: OnboardingStep;
	/** Opened at a later step than the first: "Welcome back". */
	readonly resumed: boolean;
	readonly target: LanguageCode;
	/** Languages Glimpse can translate into on this computer. */
	readonly targets: readonly LanguageChoice[];
	/** Suggested first in the target list: the OS language and English. */
	readonly suggestedTargets: readonly LanguageCode[];
	readonly downloads: DownloadsSnapshot;
	readonly hotkeys: { readonly bindings: HotkeyBindings; readonly status: HotkeyStatus };
	readonly loginItem: LoginItemStatus;
}

export interface OnboardingSnapshot {
	readonly app: AppInfo;
	readonly mode: OnboardingMode;
	readonly screenAccess: ScreenAccessStatus;
	/** Present in `setup` mode. */
	readonly setup: SetupState | null;
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
			/** Move to a step (saved, so setup resumes there). */
			goToStep: { params: { step: OnboardingStep }; response: SetupState };
			setTarget: { params: { language: string }; response: SetupState };
			/** Remember the picked languages (no download yet). */
			pickLanguages: { params: { languages: readonly string[] }; response: DownloadsSnapshot };
			/** Download what the picked languages need. */
			downloadLanguages: { params: undefined; response: DownloadsSnapshot };
			cancelDownloads: { params: undefined; response: DownloadsSnapshot };
			loadPackCatalogue: { params: undefined; response: DownloadsSnapshot };
			setHotkey: { params: SetHotkeyParams; response: SetHotkeyResult };
			/** "Skip setup": close, don't open at launch again; the tray keeps "Finish setup…". */
			skipSetup: { params: undefined; response: OnboardingActionResult };
			/** The last step's Finish. */
			finishSetup: { params: { launchAtLogin: boolean }; response: OnboardingActionResult };
		};
		messages: {
			closeOnboarding: undefined;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			screenAccessChanged: ScreenAccessStatus;
			downloadsChanged: DownloadsSnapshot;
			hotkeysChanged: HotkeyStatus;
		};
	}>;
};
