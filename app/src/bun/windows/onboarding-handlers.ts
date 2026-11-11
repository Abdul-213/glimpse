// Onboarding window request handlers (GLIM-45, GLIM-76), separate from the Electrobun window
// so they are tested on Linux. Views are less trusted than main: every handler validates
// what it gets, and state lives in the services (settings, models, hotkeys, screen access),
// not here. Shortcuts and launch at login go through the Settings handlers, so both windows
// apply the same rules.
import {
	isPlainObject,
	type LanguageCode,
	ONBOARDING_STEPS,
	type OnboardingStep,
	onboardingSteps,
	parseLanguageCode,
	resumeStep,
	sourceLanguageChoices,
	sourceLanguageFor,
} from "@glimpse/core";
import type {
	DownloadLanguage,
	DownloadsSnapshot,
	LanguageChoice,
	OnboardingActionResult,
	OnboardingMode,
	OnboardingSnapshot,
	ScreenAccessStatus,
	SetupState,
} from "../../shared/onboarding-rpc.ts";
import type { AppInfo } from "../../shared/rpc.ts";
import type { SetHotkeyResult } from "../../shared/settings-rpc.ts";
import type { ScreenAccess } from "../services/screen-access.ts";
import { createSettingsHandlers, type SettingsDeps } from "./settings-handlers.ts";

export interface OnboardingDeps {
	readonly appInfo: AppInfo;
	readonly screenAccess: ScreenAccess;
	/** Settings, hotkeys, login item and models: shared with the Settings window. */
	readonly settingsDeps: SettingsDeps;
	/** Open a web page in the default browser. */
	readonly openUrl: (url: string) => boolean;
	readonly installGuideUrl: string;
	/** The OS locale (`de-AT`), for the suggested target language. */
	readonly locale: string;
}

/** Shown in the download step before the user adds any (common reasons to need Glimpse). */
export const SUGGESTED_SOURCES = ["ja", "zh-Hans", "ko", "es", "fr", "de", "ru", "ar"] as const;
const MAX_SUGGESTIONS = 3;
const MAX_PICKED = 64;

const ENGLISH = "en" as LanguageCode;

const isStep = (v: unknown): v is OnboardingStep =>
	typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);

export function createOnboardingHandlers(deps: OnboardingDeps, mode: () => OnboardingMode) {
	const { screenAccess, settingsDeps } = deps;
	const { settings, models } = settingsDeps;
	const settingsHandlers = createSettingsHandlers(settingsDeps);
	const steps = () => onboardingSteps({ screenAccessStep: screenAccess.required });
	const uiLocale = settingsDeps.uiLocale;

	/** Every language with a local pack (Bergamot pivots via English), in the UI language's order. */
	const translatable = (): LanguageChoice[] =>
		sourceLanguageChoices(uiLocale)
			.filter((c) => c.localTranslation)
			.map((c) => ({ code: c.code, name: c.name, nativeName: c.nativeName }));

	const downloadLanguage = (choice: LanguageChoice): DownloadLanguage => {
		const plan = models.languagePlan(choice.code);
		if (plan.status === "same" || plan.status === "ready") return { ...choice, state: "ready", bytes: 0, done: 0 };
		if (plan.status === "unavailable") return { ...choice, state: "unavailable", bytes: 0, done: 0 };
		let bytes = 0;
		let done = 0;
		let busy = false;
		let failed: string | undefined;
		for (const item of plan.items) {
			const s = item.state;
			if (s.status === "downloading") {
				busy = true;
				bytes += s.total > 0 ? s.total : item.bytes;
				done += s.done;
			} else {
				bytes += item.bytes;
				if (s.status === "queued" || s.status === "verifying") busy = true;
				if (s.status === "verifying") done += item.bytes;
				if (s.status === "failed") failed = s.message;
			}
		}
		if (failed !== undefined) return { ...choice, state: "failed", bytes, done, message: failed };
		return { ...choice, state: busy ? "downloading" : "available", bytes, done };
	};

	const downloads = async (): Promise<DownloadsSnapshot> => {
		const target = settings.current.language.target;
		const all = translatable();
		const byCode = new Map(all.map((c) => [c.code as string, c]));
		const picked = settings.current.onboarding.languages.filter((c) => byCode.has(c) && c !== target);
		const suggested = SUGGESTED_SOURCES.map((c) => byCode.get(c))
			.filter((c): c is LanguageChoice => c !== undefined && c.code !== target && !picked.includes(c.code))
			.slice(0, MAX_SUGGESTIONS);
		const rows = [...picked.map((c) => byCode.get(c)).filter((c) => c !== undefined), ...suggested].map(
			downloadLanguage,
		);
		const active = rows.filter((r) => picked.includes(r.code) && r.state === "downloading");
		const snap = await models.snapshot();
		return {
			languages: rows,
			picked,
			addable: all.filter((c) => c.code !== target),
			catalogue: snap.catalogue,
			active:
				active.length > 0
					? { done: active.reduce((n, r) => n + r.done, 0), total: active.reduce((n, r) => n + r.bytes, 0) }
					: null,
			freeBytes: snap.freeBytes,
		};
	};

	const setup = async (): Promise<SetupState> => {
		const list = steps();
		const step = resumeStep(list, settings.current.onboarding.step);
		const osLanguage = parseLanguageCode(deps.locale.split("-")[0] ?? "") ?? ENGLISH;
		const targets = translatable();
		const target = settings.current.language.target;
		if (!targets.some((t) => t.code === target)) targets.push({ code: target, name: target, nativeName: "" });
		return {
			steps: list,
			step,
			resumed: step !== list[0],
			target,
			targets,
			suggestedTargets: [...new Set([target, osLanguage, ENGLISH])],
			downloads: await downloads(),
			hotkeys: { bindings: settings.current.hotkeys, status: settingsDeps.hotkeys.status() },
			loginItem: await settingsDeps.loginItem.status(),
		};
	};

	const save = (patch: Parameters<typeof settings.update>[0]) => settings.update(patch);

	return {
		downloads,

		getSnapshot: async (): Promise<OnboardingSnapshot> => ({
			app: deps.appInfo,
			mode: mode(),
			screenAccess: screenAccess.refresh(),
			setup: mode() === "setup" ? await setup() : null,
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

		async goToStep(params: unknown): Promise<SetupState> {
			const step = isPlainObject(params) ? params["step"] : undefined;
			if (isStep(step) && steps().includes(step)) await save({ onboarding: { step } });
			return setup();
		},

		async setTarget(params: unknown): Promise<SetupState> {
			const raw = isPlainObject(params) ? params["language"] : undefined;
			const code = typeof raw === "string" ? parseLanguageCode(raw) : null;
			if (code && translatable().some((t) => t.code === code)) await save({ language: { target: code } });
			return setup();
		},

		async pickLanguages(params: unknown): Promise<DownloadsSnapshot> {
			const raw = isPlainObject(params) ? params["languages"] : undefined;
			if (Array.isArray(raw)) {
				const codes = raw
					.filter((c): c is string => typeof c === "string")
					.map((c) => sourceLanguageFor(c))
					.filter((c): c is LanguageCode => c !== null);
				await save({ onboarding: { languages: [...new Set(codes)].slice(0, MAX_PICKED) } });
			}
			return downloads();
		},

		async downloadLanguages(): Promise<DownloadsSnapshot> {
			for (const code of settings.current.onboarding.languages) {
				const plan = models.languagePlan(code);
				if (plan.status === "needs-download" && plan.items.some((i) => i.state.status !== "downloading"))
					models.addLanguage(code);
			}
			return downloads();
		},

		async cancelDownloads(): Promise<DownloadsSnapshot> {
			for (const code of settings.current.onboarding.languages) {
				for (const item of models.languagePlan(code).items) {
					if (item.state.status === "downloading" || item.state.status === "queued") models.cancel(item.id);
				}
			}
			return downloads();
		},

		async loadPackCatalogue(): Promise<DownloadsSnapshot> {
			await models.loadCatalogue();
			return downloads();
		},

		setHotkey: (params: unknown): Promise<SetHotkeyResult> => settingsHandlers.setHotkey(params),

		async skipSetup(): Promise<OnboardingActionResult> {
			await save({ onboarding: { dismissed: true } });
			return { ok: true };
		},

		async finishSetup(params: unknown): Promise<OnboardingActionResult> {
			const enabled = isPlainObject(params) ? params["launchAtLogin"] : undefined;
			if (typeof enabled === "boolean") {
				const status = await settingsHandlers.setLaunchAtLogin({ enabled });
				if (status.error) return { ok: false, message: `Couldn't change Open at login: ${status.error}` };
			}
			const last = steps().at(-1) ?? "done";
			await save({ onboarding: { completed: true, dismissed: false, step: last } });
			return { ok: true };
		},
	};
}

export type OnboardingHandlers = ReturnType<typeof createOnboardingHandlers>;
