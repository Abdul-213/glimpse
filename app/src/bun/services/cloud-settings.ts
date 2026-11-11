// Settings › Providers, main side (GLIM-75): API keys in the OS keychain, "Test key", and which
// provider does each task. No Electrobun imports: tested on Linux with a memory SecretStore
// and a fake fetch.
//
// Rules (PRODUCT.md privacy, GLIM-22):
// - A key enters once, from the Settings view, and goes straight to the keychain. It is never
//   sent back to a view, logged, or written to settings; the view sees `saved`, the last four
//   characters and test results.
// - A cloud provider is picked only with a saved key and the user's confirmation. Picking it
//   for translation puts it first in the chain, ahead of the local translators (the registry
//   drops a cloud translator listed after a local one, so there is never a silent fallback
//   to the cloud). "On this computer" removes every cloud provider from that task.
// - Removing a key also switches every task that used it back to this computer, and any key
//   change drops the translation cache (GLIM-20) and re-checks the providers that use it.

import {
	type AnyProviderFactory,
	type CloudUsageSummary,
	emptyUsage,
	type ProviderRegistry,
	type SecretStore,
	SecretStoreError,
	type Settings,
	SPEND_CAPS,
	type SpendCap,
	usageMonth,
	usageSummary,
} from "@glimpse/core";
import {
	cleanGoogleKey,
	type FetchLike,
	GOOGLE_API_NAMES,
	GOOGLE_SECRET_ID,
	testGoogleKey,
} from "@glimpse/providers/google";
import type {
	ApiKeyStatus,
	ApiKeyTestResult,
	CloudActionResult,
	CloudLink,
	CloudProviderStatus,
	CloudSnapshot,
	CloudTask,
	ProviderSummary,
	SetProviderParams,
} from "../../shared/settings-rpc.ts";
import type { AppSettings } from "./app-settings.ts";

/** Where "How to get a key" and the data-terms line point (GLIM-22 sources). */
export const CLOUD_LINKS: Readonly<Record<CloudLink, string>> = {
	console: "https://console.cloud.google.com/apis/library",
	credentials: "https://console.cloud.google.com/apis/credentials",
	terms: "https://cloud.google.com/translate/data-usage",
	pricing: "https://cloud.google.com/translate/pricing",
	visionPricing: "https://cloud.google.com/vision/pricing",
	// Per-API daily request caps (GLIM-22 "Spend guard": the only hard stop Google offers).
	quotas: "https://console.cloud.google.com/apis/dashboard",
};

/** The spend guard's counters (GLIM-120, services/cloud-usage.ts). */
export interface CloudUsageView {
	readonly summary: CloudUsageSummary;
	subscribe(listener: (summary: CloudUsageSummary) => void): () => void;
	continueThisMonth(): Promise<unknown>;
}

/** Keys Glimpse knows how to store and test. One today: the shared Google Cloud key. */
const KEYS = [{ secretId: GOOGLE_SECRET_ID, vendor: "Google", label: "Google Cloud API key" }] as const;

export interface CloudSettingsDeps<Ctx> {
	readonly registry: ProviderRegistry<Ctx>;
	readonly secrets: SecretStore;
	readonly settings: AppSettings;
	/** Default: the global fetch. */
	readonly fetch?: FetchLike;
	/** A key was saved or removed: drop the cache, re-check providers (TranslationService.keyChanged). */
	readonly onKeyChanged?: (secretId: string) => void | Promise<void>;
	readonly openUrl: (url: string) => boolean;
	readonly now?: () => number;
	/** The spend guard (GLIM-120). Without it, Settings shows zero usage and the guard does nothing. */
	readonly usage?: CloudUsageView;
}

const summary = (f: AnyProviderFactory<unknown>): ProviderSummary => ({
	id: f.info.id,
	name: f.info.name,
	kind: f.info.kind,
});

export class CloudSettings<Ctx> {
	readonly #deps: CloudSettingsDeps<Ctx>;
	readonly #tests = new Map<string, ApiKeyTestResult>();
	readonly #listeners = new Set<(snapshot: CloudSnapshot) => void>();

	constructor(deps: CloudSettingsDeps<Ctx>) {
		this.#deps = deps;
		// Settings changes (the Live popup remembering consent, a provider switch) reach open views.
		deps.settings.subscribe((next, previous) => {
			if (next.providers !== previous.providers || next.cloud !== previous.cloud) void this.#emit();
		});
		// New counts reach an open Providers pane (written at most every couple of seconds).
		deps.usage?.subscribe(() => void this.#emit());
	}

	subscribe(listener: (snapshot: CloudSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async #emit(): Promise<CloudSnapshot> {
		const snap = await this.snapshot();
		for (const l of [...this.#listeners]) l(snap);
		return snap;
	}

	#cloudFactories(): AnyProviderFactory<Ctx>[] {
		return this.#deps.registry.list().filter((f) => f.info.kind === "cloud" && f.capabilities.secretId !== null);
	}

	#isSelected(settings: Settings, id: string): boolean {
		return settings.providers.ocr === id || settings.providers.translation[0] === id;
	}

	async snapshot(): Promise<CloudSnapshot> {
		const { registry, secrets, settings } = this.#deps;
		const current = settings.current;
		const status = await secrets.status().catch(
			(): Awaited<ReturnType<SecretStore["status"]>> => ({
				available: false,
				kind: "unknown",
				userMessage: "The system password store returned an unexpected error.",
			}),
		);
		const cloud = this.#cloudFactories();
		const keys: ApiKeyStatus[] = [];
		for (const k of KEYS) {
			let hint: string | null = null;
			let saved = false;
			if (status.available) {
				try {
					const value = await secrets.get(k.secretId);
					saved = value !== null && value !== "";
					hint = saved && value && value.length >= 16 ? `…${value.slice(-4)}` : null;
				} catch {
					saved = false;
				}
			}
			keys.push({
				secretId: k.secretId,
				vendor: k.vendor,
				label: k.label,
				saved,
				hint,
				lastTest: saved ? (this.#tests.get(k.secretId) ?? null) : null,
				usedBy: cloud.filter((f) => f.capabilities.secretId === k.secretId).map((f) => f.info.name),
			});
		}
		const providers: CloudProviderStatus[] = cloud.map((f) => ({
			id: f.info.id,
			name: f.info.name,
			vendor: f.info.vendor ?? "",
			task: f.info.task,
			sends: f.info.task === "ocr" ? "image" : "text",
			secretId: f.capabilities.secretId ?? "",
			selected: this.#isSelected(current, f.info.id),
		}));
		const defaults = registry.defaultConfig();
		const local = (id: string) => {
			const f = registry.get(id);
			return f && f.info.kind === "local" ? summary(f) : null;
		};
		return {
			keychain: status.available ? { available: true } : { available: false, message: status.userMessage },
			keys,
			providers,
			local: {
				ocr: defaults.ocr === null ? null : local(defaults.ocr),
				translation: defaults.translation.map(local).filter((p): p is ProviderSummary => p !== null),
			},
			liveConsent: current.cloud.liveConsent,
			usage: this.#usage(current.cloud.spendCap),
		};
	}

	#usage(cap: SpendCap): CloudUsageSummary {
		if (this.#deps.usage) return this.#deps.usage.summary;
		const month = usageMonth((this.#deps.now ?? Date.now)());
		return usageSummary(emptyUsage(month), cap, month);
	}

	async setSpendCap(params: unknown): Promise<CloudActionResult> {
		const cap = (params as { cap?: unknown } | null)?.cap;
		if (!(SPEND_CAPS as readonly unknown[]).includes(cap)) return this.#result("Unknown setting.");
		if (cap !== this.#deps.settings.current.cloud.spendCap) {
			await this.#deps.settings.update({ cloud: { spendCap: cap as SpendCap } });
		}
		return this.#result();
	}

	/** "Continue this month" (Settings or a popup): resume what the guard paused. */
	async continueCloud(): Promise<CloudActionResult> {
		await this.#deps.usage?.continueThisMonth();
		return this.#result();
	}

	async #result(error?: string): Promise<CloudActionResult> {
		const cloud = await this.#emit();
		return error === undefined ? { ok: true, cloud } : { ok: false, message: error, cloud };
	}

	#known(secretId: unknown): secretId is string {
		return typeof secretId === "string" && KEYS.some((k) => k.secretId === secretId);
	}

	async saveKey(secretId: unknown, input: unknown): Promise<CloudActionResult> {
		if (!this.#known(secretId) || typeof input !== "string") return this.#result("Unknown key.");
		const cleaned = cleanGoogleKey(input.slice(0, 4096));
		if ("problem" in cleaned) return this.#result(cleaned.problem);
		try {
			await this.#deps.secrets.set(secretId, cleaned.key);
		} catch (error) {
			return this.#result(error instanceof SecretStoreError ? error.userMessage : "The key couldn't be saved.");
		}
		this.#tests.delete(secretId);
		await this.#deps.onKeyChanged?.(secretId);
		return this.#result();
	}

	async removeKey(secretId: unknown): Promise<CloudActionResult> {
		if (!this.#known(secretId)) return this.#result("Unknown key.");
		try {
			await this.#deps.secrets.delete(secretId);
		} catch (error) {
			return this.#result(error instanceof SecretStoreError ? error.userMessage : "The key couldn't be removed.");
		}
		this.#tests.delete(secretId);
		// Nothing may keep pointing at a provider that can no longer work: back to this computer.
		const users = this.#cloudFactories().filter((f) => f.capabilities.secretId === secretId);
		for (const f of users) await this.#select(f.info.task, null);
		await this.#deps.onKeyChanged?.(secretId);
		return this.#result();
	}

	async testKey(secretId: unknown): Promise<CloudActionResult> {
		if (!this.#known(secretId)) return this.#result("Unknown key.");
		let key: string | null;
		try {
			key = await this.#deps.secrets.get(secretId);
		} catch (error) {
			return this.#result(error instanceof SecretStoreError ? error.userMessage : "The key couldn't be read.");
		}
		if (!key) return this.#result("No key is saved.");
		const r = await testGoogleKey(key, this.#deps.fetch ? { fetch: this.#deps.fetch } : {});
		this.#tests.set(secretId, {
			at: (this.#deps.now ?? Date.now)(),
			ok: r.ok,
			checks: r.checks.map((c) =>
				c.ok
					? { api: c.api, name: GOOGLE_API_NAMES[c.api], ok: true }
					: { api: c.api, name: GOOGLE_API_NAMES[c.api], ok: false, problem: c.problem, message: c.message },
			),
		});
		return this.#result();
	}

	async setProvider(params: unknown): Promise<CloudActionResult> {
		const p = params as Partial<SetProviderParams> | null;
		const task = p?.task;
		if (task !== "ocr" && task !== "translation") return this.#result("Unknown task.");
		const id = p?.id ?? null;
		if (id === null) {
			await this.#select(task, null);
			return this.#result();
		}
		const f = this.#cloudFactories().find((c) => c.info.id === id);
		if (!f || f.info.task !== task) return this.#result("That provider isn't available.");
		if (p?.confirmed !== true) return this.#result("Confirm before sending text to a cloud service.");
		const secretId = f.capabilities.secretId;
		const saved = secretId !== null && (await this.#deps.secrets.has(secretId).catch(() => false));
		if (!saved) return this.#result(`Add your ${f.info.vendor ?? ""} API key first.`.replace("  ", " "));
		await this.#select(task, id);
		return this.#result();
	}

	/** Point `task` at a cloud provider, or (null) back at this computer's providers. */
	async #select(task: CloudTask, id: string | null): Promise<void> {
		const { settings, registry } = this.#deps;
		const current = settings.current.providers;
		const defaults = registry.defaultConfig();
		const isCloud = (pid: string) => registry.get(pid)?.info.kind === "cloud";
		if (task === "ocr") {
			const ocr = id ?? (current.ocr !== null && !isCloud(current.ocr) ? current.ocr : defaults.ocr);
			if (ocr !== current.ocr) await settings.update({ providers: { ocr } });
			return;
		}
		const local = current.translation.filter((pid) => !isCloud(pid));
		const base = local.length > 0 ? local : defaults.translation;
		const translation = id === null ? base : [id, ...base];
		if (translation.join("|") !== current.translation.join("|")) {
			await settings.update({ providers: { translation: [...translation] } });
		}
	}

	async resetLiveConsent(): Promise<CloudActionResult> {
		await this.#deps.settings.update({ cloud: { liveConsent: [] } });
		return this.#result();
	}

	openLink(link: unknown): { ok: true } | { ok: false; message: string } {
		const url = typeof link === "string" ? CLOUD_LINKS[link as CloudLink] : undefined;
		if (!url) return { ok: false, message: "Unknown link." };
		return this.#deps.openUrl(url) ? { ok: true } : { ok: false, message: "Couldn't open your browser." };
	}
}

/** What the Settings window uses (independent of the provider context type). */
export type CloudSettingsApi = Pick<
	CloudSettings<never>,
	| "snapshot"
	| "saveKey"
	| "removeKey"
	| "testKey"
	| "setProvider"
	| "resetLiveConsent"
	| "setSpendCap"
	| "continueCloud"
	| "openLink"
	| "subscribe"
>;
