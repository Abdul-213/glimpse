// Settings window RPC (GLIM-69). Types only, plain JSON (ARCHITECTURE.md §5).
//
// The main process owns every setting. The view asks for a snapshot once, then renders what
// main pushes (`settingsChanged`, `modelsChanged`, `hotkeysChanged`). Every intent goes back as
// a request that main validates; the response says what actually happened, so the view never
// guesses.

import type {
	CloudUsageSummary,
	HotkeyAction,
	HotkeyBindings,
	Issue,
	LanguageCode,
	Settings,
	SourceLanguageGroup,
	SpendCap,
	UpdateStatus,
} from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { AppInfo } from "./rpc.ts";

/** The parts of Settings the view may patch directly. The rest go through their own request. */
export type EditableSection =
	| "language"
	| "appearance"
	| "snip"
	| "picker"
	| "live"
	| "privacy"
	| "diagnostics"
	| "updates";

export const EDITABLE_SECTIONS: readonly EditableSection[] = [
	"language",
	"appearance",
	"snip",
	"picker",
	"live",
	"privacy",
	"diagnostics",
	"updates",
];

/** The window's panes, in sidebar order. `SettingsWindow.open(section)` opens at one (GLIM-117). */
export const SETTINGS_SECTIONS = [
	"general",
	"languages",
	"shortcuts",
	"providers",
	"models",
	"privacy",
	"about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const isSettingsSection = (v: unknown): v is SettingsSection =>
	typeof v === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(v);

type DeepPartial<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { readonly [K in keyof T]?: DeepPartial<T[K]> }
		: T;

export type SettingsEdit = { readonly [K in EditableSection]?: DeepPartial<Settings[K]> };

export interface UpdateResult {
	readonly settings: Settings;
	/** Fields that were rejected (they keep their current value). */
	readonly issues: readonly Issue[];
}

// ── Shortcuts ───────────────────────────────────────────────────────────────────────────

/**
 * Registration outcome for one action (the hotkey service's report, GLIM-23):
 * - `ready`       registered with the OS
 * - `unbound`     no shortcut set
 * - `unverified`  saved, but the OS can't confirm it works (macOS shortcuts inside other apps)
 * - `inactive`    saved, but nothing uses this action yet (its feature hasn't landed)
 * - `failed`      the OS refused it; `reason` says why
 */
export type HotkeyRegistration =
	| { readonly state: "ready" }
	| { readonly state: "unbound" }
	| { readonly state: "unverified" }
	| { readonly state: "inactive" }
	| { readonly state: "failed"; readonly reason: "in-use" | "reserved" | "unavailable"; readonly message: string };

export type HotkeyStatus = Readonly<Record<HotkeyAction, HotkeyRegistration>>;

export interface SetHotkeyParams {
	readonly action: HotkeyAction;
	/** Canonical accelerator (`Alt+Shift+S`) or null to unbind. */
	readonly hotkey: string | null;
	/** When another action has this combo: give that action this one's old combo (the Swap button). */
	readonly swap?: boolean;
}

export type SetHotkeyResult =
	| { readonly ok: true; readonly bindings: HotkeyBindings; readonly status: HotkeyStatus }
	| {
			readonly ok: false;
			/** `conflict`: another Glimpse action has it. `invalid`: GLIM-23 rules. `os`: registration failed. */
			readonly error: "conflict" | "invalid" | "os";
			readonly message: string;
			/** For `conflict`: the action that already uses it, so the view can offer Swap. */
			readonly owner?: HotkeyAction;
	  };

// ── Models (GLIM-96) ────────────────────────────────────────────────────────────────────

/**
 * `model`: a whole on-demand translation model (SMaLL-100, GLIM-100). `detector`: the fastText
 * language identifier (GLIM-104).
 */
export type ModelKind = "ocr" | "runtime" | "pack" | "model" | "detector";

export type ModelRowState =
	| { readonly status: "installed"; readonly bundled: boolean }
	| { readonly status: "missing" }
	| { readonly status: "queued" }
	| { readonly status: "downloading"; readonly done: number; readonly total: number }
	| { readonly status: "verifying" }
	| { readonly status: "failed"; readonly error: string; readonly message: string };

export interface ModelRow {
	readonly id: string;
	readonly kind: ModelKind;
	/** "Japanese → English", "Chinese and Japanese text", "Translation engine". */
	readonly name: string;
	/** "Reads Latin-script languages", for OCR rows. */
	readonly detail?: string;
	/** On disk when installed, else the download size. Bytes. */
	readonly bytes: number;
	readonly state: ModelRowState;
}

export interface ModelsSnapshot {
	/** Folder holding downloaded models. */
	readonly directory: string;
	/** True when the folder is the default (`<userData>/models`). */
	readonly isDefaultDirectory: boolean;
	/** Bytes used by downloaded (not bundled) models. */
	readonly usedBytes: number;
	/** Free bytes on that volume, or null if unknown. */
	readonly freeBytes: number | null;
	readonly rows: readonly ModelRow[];
	/** Languages with a pack in the catalogue, for "Add a language"; empty until the catalogue loads. */
	readonly addable: readonly { readonly code: LanguageCode; readonly name: string; readonly nativeName: string }[];
	/** Pack catalogue status. `idle`: not loaded this session (no network until the user asks). */
	readonly catalogue: "idle" | "loading" | "ready" | "cached" | "offline";
	/** A move between folders is running. */
	readonly moving: boolean;
}

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

// ── Launch at login (GLIM-77) ───────────────────────────────────────────────────────────

export interface LoginItemStatus {
	readonly enabled: boolean;
	/** False in dev builds and on Linux: the switch is shown disabled with `reason`. */
	readonly supported: boolean;
	readonly reason?: string;
	/** The last change failed: what the OS said, in words for the user. */
	readonly error?: string;
}

// ── Cloud providers and API keys (GLIM-75) ──────────────────────────────────────────────
//
// Keys go one way: the view sends a pasted key once (`saveApiKey`), main stores it in the OS
// keychain, and from then on the view only ever sees status (saved or not, the last four
// characters, the last test result). Nothing here carries a key back.

export type CloudTask = "ocr" | "translation";

/** One API's verdict from "Test key". `problem` is a GoogleProblem (`api-disabled`, ...). */
export type ApiKeyCheck =
	| { readonly api: "vision" | "translate"; readonly name: string; readonly ok: true }
	| {
			readonly api: "vision" | "translate";
			readonly name: string;
			readonly ok: false;
			readonly problem: string;
			/** What to do about it, in words for the user. */
			readonly message: string;
	  };

export interface ApiKeyTestResult {
	/** When it ran (ms since epoch), for "checked just now". */
	readonly at: number;
	readonly ok: boolean;
	readonly checks: readonly ApiKeyCheck[];
}

export interface ApiKeyStatus {
	/** Keychain entry id (`google-cloud`). */
	readonly secretId: string;
	/** "Google". */
	readonly vendor: string;
	/** "Google Cloud API key". */
	readonly label: string;
	readonly saved: boolean;
	/** "…3f2a": the last four characters of a saved key, or null. Never more. */
	readonly hint: string | null;
	/** The last "Test key" result this session, or null. Cleared when the key changes. */
	readonly lastTest: ApiKeyTestResult | null;
	/** The providers that use this key, by name ("Google Cloud Vision", ...). */
	readonly usedBy: readonly string[];
}

export interface CloudProviderStatus {
	readonly id: string;
	/** "Google Cloud Translation". */
	readonly name: string;
	readonly vendor: string;
	readonly task: CloudTask;
	/** What leaves the device when it is used (GLIM-22 indicator: image vs text). */
	readonly sends: "image" | "text";
	readonly secretId: string;
	/** Picked for its task in settings. */
	readonly selected: boolean;
}

export interface CloudSnapshot {
	/** The OS keychain can be used. When it can't, keys can't be saved (no plaintext fallback). */
	readonly keychain: { readonly available: true } | { readonly available: false; readonly message: string };
	readonly keys: readonly ApiKeyStatus[];
	readonly providers: readonly CloudProviderStatus[];
	/** On-device providers per task (what "On this computer" means), from the registry. */
	readonly local: { readonly ocr: ProviderSummary | null; readonly translation: readonly ProviderSummary[] };
	/** Cloud translators Live won't ask about again (`settings.cloud.liveConsent`). */
	readonly liveConsent: readonly string[];
	/** This month's counters and the spend guard (GLIM-120). Local only, never sent anywhere. */
	readonly usage: CloudUsageSummary;
}

export interface SetProviderParams {
	readonly task: CloudTask;
	/** A cloud provider id, or null for "On this computer". */
	readonly id: string | null;
	/** The user confirmed "Translate with ‹Provider›?". Required for cloud providers. */
	readonly confirmed?: boolean;
}

/** Fixed links main opens in the browser (the view can't pass a URL). */
export type CloudLink = "console" | "credentials" | "terms" | "pricing" | "visionPricing" | "quotas";

export type CloudActionResult =
	| { readonly ok: true; readonly cloud: CloudSnapshot }
	| { readonly ok: false; readonly message: string; readonly cloud: CloudSnapshot };

// ── The snapshot ────────────────────────────────────────────────────────────────────────

export interface SettingsSnapshot {
	readonly app: AppInfo;
	readonly settings: Settings;
	/** GLIM-23 defaults for this OS, for "Restore defaults". */
	readonly defaultHotkeys: HotkeyBindings;
	readonly hotkeys: HotkeyStatus;
	readonly loginItem: LoginItemStatus;
	/** Translation and OCR providers in use. Cloud details and keys: `getCloud` (GLIM-75). */
	readonly providers: {
		readonly ocr: ProviderSummary | null;
		readonly translation: readonly ProviderSummary[];
	};
	/** Startup warnings about the settings file, if any (shown in About). */
	readonly settingsWarnings: readonly string[];
	/** GLIM-70: whether a newer release is out (About). Pushed again with `updateChanged`. */
	readonly update: UpdateStatus;
	/** The pane to open at (a popup's "Check key…" asks for Providers), or null for the first one. */
	readonly section: SettingsSection | null;
}

export interface ProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly kind: "local" | "cloud";
}

/** One source-language choice with what the app knows right now (GLIM-68). */
export interface SourceLanguagesSnapshot {
	readonly groups: readonly SourceLanguageGroup[];
	/** Languages whose local translation pack into the target language is installed. */
	readonly packInstalled: readonly LanguageCode[];
}

export type SettingsRPC = {
	bun: RPCSchema<{
		requests: {
			getAppInfo: { params: undefined; response: AppInfo };
			getSnapshot: { params: undefined; response: SettingsSnapshot };
			updateSettings: { params: SettingsEdit; response: UpdateResult };
			getSourceLanguages: { params: undefined; response: SourceLanguagesSnapshot };
			setHotkey: { params: SetHotkeyParams; response: SetHotkeyResult };
			resetHotkeys: { params: undefined; response: SetHotkeyResult };
			setLaunchAtLogin: { params: { enabled: boolean }; response: LoginItemStatus };
			getModels: { params: undefined; response: ModelsSnapshot };
			loadPackCatalogue: { params: undefined; response: ModelsSnapshot };
			downloadModel: { params: { id: string }; response: ActionResult };
			addLanguagePacks: { params: { language: string }; response: ActionResult };
			cancelModelDownload: { params: { id: string }; response: ActionResult };
			removeModel: { params: { id: string }; response: ActionResult };
			chooseModelsDirectory: { params: undefined; response: ActionResult };
			resetModelsDirectory: { params: undefined; response: ActionResult };
			revealModelsDirectory: { params: undefined; response: ActionResult };
			clearCache: { params: undefined; response: ActionResult };
			copyDiagnostics: { params: undefined; response: ActionResult };
			openLogs: { params: undefined; response: ActionResult };
			getCloud: { params: undefined; response: CloudSnapshot };
			saveApiKey: { params: { secretId: string; key: string }; response: CloudActionResult };
			removeApiKey: { params: { secretId: string }; response: CloudActionResult };
			testApiKey: { params: { secretId: string }; response: CloudActionResult };
			setProvider: { params: SetProviderParams; response: CloudActionResult };
			resetLiveConsent: { params: undefined; response: CloudActionResult };
			/** The spend guard (GLIM-120): pause at the free tier, or only count. */
			setSpendCap: { params: { cap: SpendCap }; response: CloudActionResult };
			/** "Continue this month": resume cloud use the guard paused, until the month ends. */
			continueCloud: { params: undefined; response: CloudActionResult };
			openCloudLink: { params: { link: CloudLink }; response: ActionResult };
			/** Open first-run setup again (GLIM-76). */
			openOnboarding: { params: undefined; response: ActionResult };
			/** Open the newer release's page in the browser (GLIM-70). */
			openUpdatePage: { params: undefined; response: ActionResult };
		};
		messages: {
			closeSettings: undefined;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			settingsChanged: Settings;
			hotkeysChanged: HotkeyStatus;
			modelsChanged: ModelsSnapshot;
			cloudChanged: CloudSnapshot;
			updateChanged: UpdateStatus;
			/** Switch to a pane: Settings was asked to open at it while already open (GLIM-117). */
			showSection: SettingsSection;
		};
	}>;
};
