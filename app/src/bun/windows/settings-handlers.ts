// Settings window request handlers (GLIM-69), separate from the Electrobun window so they are
// tested on Linux. Every handler validates its params: views are less trusted than main
// (ARCHITECTURE.md §5 rule 3). State changes go through AppSettings, the hotkey registrar,
// the login item and the models service; nothing here holds state of its own.
import {
	canonicalHotkey,
	groupSourceLanguages,
	type HotkeyAction,
	type HotkeyBindings,
	hotkeyProblem,
	isPlainObject,
	type LanguageCode,
	type LanguagePair,
	planRoute,
	type SettingsPatch,
	sourceLanguageChoices,
} from "@glimpse/core";
import type { AppInfo } from "../../shared/rpc.ts";
import {
	type ActionResult,
	EDITABLE_SECTIONS,
	type LoginItemStatus,
	type ModelsSnapshot,
	type ProviderSummary,
	type SetHotkeyResult,
	type SettingsEdit,
	type SettingsSnapshot,
	type SourceLanguagesSnapshot,
	type UpdateResult,
} from "../../shared/settings-rpc.ts";
import type { Command, CommandSource } from "../commands.ts";
import type { AppSettings } from "../services/app-settings.ts";
import type { CloudSettingsApi } from "../services/cloud-settings.ts";
import { HOTKEY_ACTIONS, type HotkeyRegistrar } from "../services/hotkeys-port.ts";
import type { LoginItem } from "../services/login-item.ts";
import type { ModelsSettings } from "../services/models/models-settings.ts";

export interface SettingsDeps {
	readonly appInfo: AppInfo;
	readonly settings: AppSettings;
	readonly hotkeys: HotkeyRegistrar;
	readonly loginItem: LoginItem;
	readonly models: ModelsSettings;
	/** Cloud providers and API keys (GLIM-75). Keys never come back through it. */
	readonly cloud: CloudSettingsApi;
	/** Installed translation packs as pairs (for "pack installed" hints in Languages). */
	readonly installedPairs: () => readonly LanguagePair[];
	readonly providers: () => SettingsSnapshot["providers"];
	readonly dispatch: (command: Command, source: CommandSource) => Promise<boolean>;
	/** Native folder picker; null when cancelled. */
	readonly chooseFolder: (startIn: string) => Promise<string | null>;
	readonly reveal: (path: string) => boolean;
	readonly settingsWarnings: readonly string[];
	readonly uiLocale: string;
}

const ACTION_NAMES: Record<HotkeyAction, string> = {
	snip: "Snip",
	live: "Live",
	pauseLive: "Pause or resume Live",
	resnip: "Snip the last region again",
	toggleLivePopup: "Show or hide the Live popup",
};

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/;

const isAction = (v: unknown): v is HotkeyAction => typeof v === "string" && (HOTKEY_ACTIONS as string[]).includes(v);

const bad = (message: string): ActionResult => ({ ok: false, message });

function modelId(params: unknown): string | null {
	const id = isPlainObject(params) ? params["id"] : undefined;
	return typeof id === "string" && MODEL_ID.test(id) ? id : null;
}

export function createSettingsHandlers(deps: SettingsDeps) {
	const { settings } = deps;

	const snapshot = async (): Promise<SettingsSnapshot> => ({
		app: deps.appInfo,
		settings: settings.current,
		defaultHotkeys: settings.env.hotkeys,
		hotkeys: deps.hotkeys.status(),
		loginItem: await deps.loginItem.status(),
		providers: deps.providers(),
		settingsWarnings: deps.settingsWarnings,
	});

	/** Apply bindings with the OS; on refusal for `action`, put the old ones back. */
	const applyHotkeys = async (next: HotkeyBindings, action: HotkeyAction | null): Promise<SetHotkeyResult> => {
		const previous = settings.current.hotkeys;
		const status = await deps.hotkeys.apply(next);
		const mine = action ? status[action] : undefined;
		if (mine?.state === "failed") {
			await deps.hotkeys.apply(previous);
			return { ok: false, error: "os", message: mine.message };
		}
		const { settings: saved } = await settings.update({ hotkeys: next });
		return { ok: true, bindings: saved.hotkeys, status: deps.hotkeys.status() };
	};

	return {
		getAppInfo: (): AppInfo => deps.appInfo,

		getSnapshot: snapshot,

		async updateSettings(params: unknown): Promise<UpdateResult> {
			if (!isPlainObject(params)) {
				return { settings: settings.current, issues: [{ path: "", message: "expected an object" }] };
			}
			const patch: Record<string, unknown> = {};
			const issues: UpdateResult["issues"][number][] = [];
			for (const [key, value] of Object.entries(params)) {
				if ((EDITABLE_SECTIONS as readonly string[]).includes(key) && isPlainObject(value)) patch[key] = value;
				else issues.push({ path: key, message: "can't be changed from Settings this way" });
			}
			const r = await settings.update(patch as SettingsPatch);
			return { settings: r.settings, issues: [...issues, ...r.issues] };
		},

		getSourceLanguages(): SourceLanguagesSnapshot {
			const choices = sourceLanguageChoices(deps.uiLocale);
			const target = settings.current.language.target;
			const pairs = deps.installedPairs();
			const packInstalled: LanguageCode[] = choices
				.filter((c) => {
					if (!c.localTranslation) return false;
					const route = planRoute(c.code, target, pairs);
					return route !== null && route.kind !== "identity";
				})
				.map((c) => c.code);
			return { groups: groupSourceLanguages(choices, deps.uiLocale), packInstalled };
		},

		async setHotkey(params: unknown): Promise<SetHotkeyResult> {
			if (!isPlainObject(params) || !isAction(params["action"])) {
				return { ok: false, error: "invalid", message: "Unknown shortcut." };
			}
			const action = params["action"];
			const raw = params["hotkey"];
			if (raw !== null && typeof raw !== "string") return { ok: false, error: "invalid", message: "Unknown shortcut." };
			const current = settings.current.hotkeys;
			if (raw === null) return applyHotkeys({ ...current, [action]: null }, null);
			const combo = canonicalHotkey(raw);
			if (!combo) {
				return {
					ok: false,
					error: "invalid",
					message: `This shortcut can't be used: ${hotkeyProblem(raw) ?? "unknown key"}.`,
				};
			}
			const owner = HOTKEY_ACTIONS.find((a) => a !== action && current[a] === combo);
			if (owner && params["swap"] !== true) {
				return { ok: false, error: "conflict", owner, message: `Already used for ${ACTION_NAMES[owner]}.` };
			}
			const next: HotkeyBindings = { ...current, [action]: combo, ...(owner ? { [owner]: current[action] } : {}) };
			return applyHotkeys(next, action);
		},

		resetHotkeys: (): Promise<SetHotkeyResult> => applyHotkeys(settings.env.hotkeys, null),

		async setLaunchAtLogin(params: unknown): Promise<LoginItemStatus> {
			const enabled = isPlainObject(params) ? params["enabled"] : undefined;
			if (typeof enabled !== "boolean") return { ...(await deps.loginItem.status()), error: "Invalid request." };
			try {
				const status = await deps.loginItem.set(enabled);
				if (status.supported) await settings.update({ system: { launchAtLogin: status.enabled } });
				return status;
			} catch (error) {
				const status = await deps.loginItem.status();
				return { ...status, error: error instanceof Error ? error.message : String(error) };
			}
		},

		getModels: (): Promise<ModelsSnapshot> => deps.models.snapshot(),
		loadPackCatalogue: (): Promise<ModelsSnapshot> => deps.models.loadCatalogue(),

		downloadModel(params: unknown): ActionResult {
			const id = modelId(params);
			return id ? deps.models.download(id) : bad("Unknown model.");
		},

		addLanguagePacks(params: unknown): ActionResult {
			const language = isPlainObject(params) ? params["language"] : undefined;
			return typeof language === "string" && language.length <= 64
				? deps.models.addLanguage(language)
				: bad("Unknown language.");
		},

		cancelModelDownload(params: unknown): ActionResult {
			const id = modelId(params);
			return id ? deps.models.cancel(id) : bad("Unknown model.");
		},

		async removeModel(params: unknown): Promise<ActionResult> {
			const id = modelId(params);
			return id ? deps.models.remove(id) : bad("Unknown model.");
		},

		async chooseModelsDirectory(): Promise<ActionResult> {
			const current = (await deps.models.snapshot()).directory;
			const folder = await deps.chooseFolder(current);
			if (!folder) return { ok: true };
			return deps.models.moveTo(folder);
		},

		resetModelsDirectory: (): Promise<ActionResult> => deps.models.moveTo(null),

		async revealModelsDirectory(): Promise<ActionResult> {
			const dir = (await deps.models.snapshot()).directory;
			return deps.reveal(dir) ? { ok: true } : bad("Couldn't open the folder.");
		},

		clearCache: async (): Promise<ActionResult> =>
			(await deps.dispatch("cache.clear", "settings")) ? { ok: true } : bad("Couldn't clear the cache."),
		copyDiagnostics: async (): Promise<ActionResult> =>
			(await deps.dispatch("diagnostics.copy", "settings")) ? { ok: true } : bad("Couldn't copy diagnostics."),
		openOnboarding: async (): Promise<ActionResult> =>
			(await deps.dispatch("onboarding.open", "settings")) ? { ok: true } : bad("Couldn't open setup."),
		openLogs: async (): Promise<ActionResult> =>
			(await deps.dispatch("logs.open", "settings")) ? { ok: true } : bad("Couldn't open the logs folder."),

		// Cloud providers and API keys (GLIM-75). Params are checked by CloudSettings.
		getCloud: () => deps.cloud.snapshot(),
		saveApiKey: (params: unknown) =>
			isPlainObject(params)
				? deps.cloud.saveKey(params["secretId"], params["key"])
				: deps.cloud.saveKey(undefined, undefined),
		removeApiKey: (params: unknown) => deps.cloud.removeKey(isPlainObject(params) ? params["secretId"] : undefined),
		testApiKey: (params: unknown) => deps.cloud.testKey(isPlainObject(params) ? params["secretId"] : undefined),
		setProvider: (params: unknown) => deps.cloud.setProvider(isPlainObject(params) ? params : null),
		resetLiveConsent: () => deps.cloud.resetLiveConsent(),
		openCloudLink: (params: unknown): ActionResult =>
			deps.cloud.openLink(isPlainObject(params) ? params["link"] : undefined),
	};
}

export type SettingsHandlers = ReturnType<typeof createSettingsHandlers>;

/** Provider names for the Providers pane, from the registry and the current config. */
export function providerSummaries(
	config: { readonly ocr: string | null; readonly translation: readonly string[] },
	lookup: (id: string) => { readonly name: string; readonly kind: "local" | "cloud" } | undefined,
): SettingsSnapshot["providers"] {
	const one = (id: string): ProviderSummary => {
		const f = lookup(id);
		return { id, name: f?.name ?? id, kind: f?.kind ?? "local" };
	};
	return { ocr: config.ocr ? one(config.ocr) : null, translation: config.translation.map(one) };
}

export type { SettingsEdit };
