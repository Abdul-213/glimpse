// Fake main process for the dev-only onboarding preview (GLIM-45, GLIM-76): in-memory state so
// the real OnboardingApp renders and responds in a plain browser and in headless screenshots.
// Dev-only, never shipped (build-views.ts DEV_ONLY_VIEWS), so it may use @glimpse/core at
// runtime for language names and the step list; real views can't.
import {
	DEFAULT_HOTKEYS,
	type HotkeyBindings,
	type LanguageCode,
	type OnboardingStep,
	onboardingSteps,
	type ScreenAccessState,
	sourceLanguageChoices,
} from "@glimpse/core";
import type {
	DownloadLanguage,
	DownloadsSnapshot,
	LanguageChoice,
	OnboardingSnapshot,
	ScreenAccessStatus,
	SetupState,
} from "../../shared/onboarding-rpc.ts";
import type { HotkeyStatus } from "../../shared/settings-rpc.ts";
import type { OnboardingClient, OnboardingPushHandlers, OnboardingRequests } from "../onboarding/client.ts";

export interface PreviewOptions {
	os: "macos" | "windows";
	mode: "setup" | "screen-access";
	/** Screen access: not-determined | denied | denied-opened | lost | lost-opened | granted. */
	access: string;
	step: string;
	/**
	 * downloads: `pick` (nothing started) | `downloading` | `offline` | `failed`.
	 * shortcuts: `conflict` (Live's shortcut is taken by another app).
	 */
	scenario: string;
	resumed: boolean;
}

const MB = 1024 * 1024;
const code = (c: string) => c as LanguageCode;

function accessFrom(os: PreviewOptions["os"], access: string): ScreenAccessStatus {
	if (os === "windows") return { state: "not-needed", settingsOpened: false, canRestart: false };
	const [state, opened] = access.split("-opened") as [string, string | undefined];
	const known: ScreenAccessState[] = ["not-determined", "denied", "lost", "granted"];
	const s = (known as string[]).includes(state) ? (state as ScreenAccessState) : "not-determined";
	return { state: s, settingsOpened: opened !== undefined, canRestart: true };
}

const SIZES: Record<string, number> = {
	ja: 38 * MB,
	"zh-Hans": 41 * MB,
	ko: 37 * MB,
	es: 22 * MB,
	fr: 22 * MB,
	de: 23 * MB,
};

export function fakeOnboardingClient(opts: PreviewOptions): OnboardingClient {
	let access = accessFrom(opts.os, opts.access);
	let handlers: OnboardingPushHandlers | null = null;
	const steps = onboardingSteps({ screenAccessStep: opts.os === "macos" });
	let step: OnboardingStep = (steps as string[]).includes(opts.step) ? (opts.step as OnboardingStep) : "welcome";
	let target = code("en");
	const hotkeyDefaults = opts.os === "macos" ? DEFAULT_HOTKEYS.macos : DEFAULT_HOTKEYS.windows;
	let bindings: HotkeyBindings = hotkeyDefaults;
	const choices: LanguageChoice[] = sourceLanguageChoices("en")
		.filter((c) => c.localTranslation)
		.map((c) => ({ code: c.code, name: c.name, nativeName: c.nativeName }));
	const sc = opts.scenario;
	let picked: LanguageCode[] = sc === "pick" || sc === "" ? [code("ja"), code("zh-Hans")] : [code("ja"), code("ko")];
	if (opts.step !== "downloads" && sc === "") picked = [code("ja"), code("ko")];
	let downloading = sc === "downloading" || (opts.step !== "downloads" && sc !== "pick");
	let catalogue: DownloadsSnapshot["catalogue"] = sc === "offline" ? "offline" : "ready";

	const row = (c: LanguageChoice): DownloadLanguage => {
		if (catalogue === "offline") return { ...c, state: "unavailable", bytes: 0, done: 0 };
		const bytes = SIZES[c.code] ?? 24 * MB;
		if (c.code === "es" && opts.os === "windows") return { ...c, state: "ready", bytes: 0, done: 0 };
		if (picked.includes(c.code) && sc === "failed" && c.code === "ko")
			return {
				...c,
				state: "failed",
				bytes,
				done: 0,
				message: "Couldn't connect. Check your connection and try again.",
			};
		if (picked.includes(c.code) && downloading) {
			const done = c.code === "ja" ? bytes : Math.round(bytes * 0.42);
			return c.code === "ja"
				? { ...c, state: "ready", bytes: 0, done: 0 }
				: { ...c, state: "downloading", bytes, done };
		}
		return { ...c, state: "available", bytes, done: 0 };
	};

	const downloads = (): DownloadsSnapshot => {
		const byCode = new Map(choices.map((c) => [c.code as string, c]));
		const suggested = ["ja", "zh-Hans", "ko", "es", "fr", "de"]
			.map((c) => byCode.get(c))
			.filter((c): c is LanguageChoice => c !== undefined && !picked.includes(c.code))
			.slice(0, 3);
		const rows = [...picked.map((c) => byCode.get(c)).filter((c) => c !== undefined), ...suggested].map(row);
		const active = rows.filter((r) => picked.includes(r.code) && r.state === "downloading");
		return {
			languages: rows,
			picked,
			addable: choices.filter((c) => c.code !== target),
			catalogue,
			active:
				active.length > 0
					? {
							done: active.reduce((n, r) => n + r.done, 0) + 38 * MB,
							total: active.reduce((n, r) => n + r.bytes, 0) + 38 * MB,
						}
					: null,
			freeBytes: 112 * 1024 * MB,
		};
	};

	const hotkeyStatus = (): HotkeyStatus => ({
		snip: { state: "ready" },
		live:
			sc === "conflict"
				? {
						state: "failed",
						reason: "in-use",
						message: "Another app already uses this shortcut. Choose another one.",
					}
				: { state: "ready" },
		pauseLive: { state: "unbound" },
		resnip: { state: "unbound" },
		toggleLivePopup: { state: "unbound" },
	});

	const setup = (): SetupState => ({
		steps,
		step,
		resumed: opts.resumed,
		target,
		targets: choices,
		suggestedTargets: [target, code(opts.os === "macos" ? "de" : "es"), code("en")].filter(
			(c, i, a) => a.indexOf(c) === i,
		),
		downloads: downloads(),
		hotkeys: { bindings, status: hotkeyStatus() },
		loginItem: { enabled: false, supported: true },
	});

	const snapshot = (): OnboardingSnapshot => ({
		app: { name: "Glimpse", version: "0.0.1", platform: opts.os, electrobun: "2.0.6-beta.2", bun: "1.4.4" },
		mode: opts.mode,
		screenAccess: access,
		setup: opts.mode === "setup" ? setup() : null,
	});

	const push = () => handlers?.screenAccessChanged(access);
	const ok = { ok: true } as const;

	const request: OnboardingRequests = {
		getSnapshot: async () => snapshot(),
		requestScreenAccess: async () => {
			access = access.state === "not-determined" ? { ...access, state: "denied" } : { ...access, settingsOpened: true };
			push();
			return access;
		},
		openScreenAccessSettings: async () => {
			access = { ...access, settingsOpened: true };
			push();
			return access;
		},
		refreshScreenAccess: async () => access,
		restartApp: async () => {
			access = { ...access, state: "granted" };
			push();
			return ok;
		},
		openInstallGuide: async () => ok,
		goToStep: async ({ step: s }) => {
			step = s;
			return setup();
		},
		setTarget: async ({ language }) => {
			target = code(language);
			return setup();
		},
		pickLanguages: async ({ languages }) => {
			picked = languages.map(code);
			return downloads();
		},
		downloadLanguages: async () => {
			downloading = true;
			return downloads();
		},
		cancelDownloads: async () => {
			downloading = false;
			return downloads();
		},
		loadPackCatalogue: async () => {
			catalogue = "ready";
			return downloads();
		},
		setHotkey: async ({ action, hotkey }) => {
			bindings = { ...bindings, [action]: hotkey };
			return { ok: true, bindings, status: hotkeyStatus() };
		},
		skipSetup: async () => ok,
		finishSetup: async () => ok,
	};

	return {
		request,
		listen: (h) => {
			handlers = h;
		},
		close: () => {
			document.body.dataset["closed"] = "true";
		},
	};
}
