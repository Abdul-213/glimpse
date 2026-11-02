// GLIM-75: Settings › Providers, main side. Keys to the keychain only, never back to the view.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_HOTKEYS,
	defaultSettings,
	languageCode,
	PROVIDER_IDS,
	ProviderRegistry,
	type SettingsEnv,
} from "@glimpse/core";
import { MemorySecretStore, MemorySettingsStore } from "@glimpse/core/testing";
import { GOOGLE_SECRET_ID } from "@glimpse/providers/google";
import { VISION_ENDPOINT } from "@glimpse/providers/ocr/google-vision";
import { FakeFetch } from "@glimpse/providers/testing";
import { LANGUAGES_V2_ENDPOINT } from "@glimpse/providers/translation/google-v2";
import { AppSettings } from "../src/bun/services/app-settings.ts";
import { CLOUD_LINKS, CloudSettings } from "../src/bun/services/cloud-settings.ts";
import { type AppProviderContext, registerProviders } from "../src/bun/services/providers.ts";
import { createSettingsHandlers, type SettingsDeps } from "../src/bun/windows/settings-handlers.ts";

const KEY = "AIzaSyD-test-key-00000000000000000000000";

function setup(options: { key?: string; fetch?: FakeFetch } = {}) {
	const registry = new ProviderRegistry<AppProviderContext>();
	registerProviders(registry);
	const env: SettingsEnv = {
		hotkeys: DEFAULT_HOTKEYS.windows,
		providers: registry.configSchema(),
		targetLanguage: languageCode("en"),
	};
	const settings = new AppSettings(defaultSettings(env), new MemorySettingsStore(), env);
	const secrets = new MemorySecretStore(options.key ? { [GOOGLE_SECRET_ID]: options.key } : {});
	const keyChanges: string[] = [];
	const opened: string[] = [];
	const fake =
		options.fetch ??
		new FakeFetch()
			.on("GET", LANGUAGES_V2_ENDPOINT, { json: { data: { languages: [{ language: "en" }] } } })
			.on("POST", VISION_ENDPOINT, { json: {} });
	const cloud = new CloudSettings({
		registry,
		secrets,
		settings,
		fetch: fake.fetch,
		onKeyChanged: (id) => {
			keyChanges.push(id);
		},
		openUrl: (url) => {
			opened.push(url);
			return true;
		},
		now: () => 1_000,
	});
	return { cloud, settings, secrets, keyChanges, opened, fake, registry };
}

const json = (v: unknown) => JSON.stringify(v);

describe("CloudSettings", () => {
	test("snapshot: no key, both Google providers listed, nothing selected", async () => {
		const { cloud } = setup();
		const s = await cloud.snapshot();
		expect(s.keychain).toEqual({ available: true });
		expect(s.keys).toEqual([
			{
				secretId: GOOGLE_SECRET_ID,
				vendor: "Google",
				label: "Google Cloud API key",
				saved: false,
				hint: null,
				lastTest: null,
				usedBy: ["Google Cloud Translation", "Google Cloud Vision"],
			},
		]);
		expect(s.providers.map((p) => [p.id, p.task, p.sends, p.selected])).toEqual([
			[PROVIDER_IDS.googleTranslate, "translation", "text", false],
			[PROVIDER_IDS.googleVision, "ocr", "image", false],
		]);
		expect(s.local.ocr?.id).toBe(PROVIDER_IDS.paddleocr);
		expect(s.local.translation.map((p) => p.id)).toEqual([PROVIDER_IDS.bergamot, PROVIDER_IDS.small100]);
	});

	test("save: cleaned key goes to the keychain; the snapshot only says saved + last 4", async () => {
		const { cloud, secrets, keyChanges } = setup();
		const r = await cloud.saveKey(GOOGLE_SECRET_ID, `  ${KEY}\n`);
		expect(r.ok).toBe(true);
		expect(secrets.items.get(GOOGLE_SECRET_ID)).toBe(KEY);
		expect(r.cloud.keys[0]).toMatchObject({ saved: true, hint: `…${KEY.slice(-4)}` });
		expect(json(r)).not.toContain(KEY);
		expect(json(r)).not.toContain(KEY.slice(0, 12));
		expect(keyChanges).toEqual([GOOGLE_SECRET_ID]);
	});

	test("save rejects junk, unknown key ids and a keychain failure, without storing", async () => {
		const { cloud, secrets } = setup();
		expect(await cloud.saveKey(GOOGLE_SECRET_ID, "not a key")).toMatchObject({ ok: false });
		expect(await cloud.saveKey("other", KEY)).toMatchObject({ ok: false, message: "Unknown key." });
		secrets.failNext = "locked";
		const locked = await cloud.saveKey(GOOGLE_SECRET_ID, KEY);
		expect(locked).toMatchObject({ ok: false, message: expect.stringContaining("locked") });
		expect(secrets.items.size).toBe(0);
	});

	test("keychain unavailable: reported, no plaintext fallback", async () => {
		const { cloud, secrets } = setup();
		secrets.failWith = "unavailable";
		const s = await cloud.snapshot();
		expect(s.keychain).toMatchObject({ available: false });
		expect(s.keys[0]?.saved).toBe(false);
	});

	test("cloud providers need a key and a confirmation; translation goes first, ahead of local", async () => {
		const { cloud, settings } = setup();
		const noKey = await cloud.setProvider({ task: "translation", id: PROVIDER_IDS.googleTranslate, confirmed: true });
		expect(noKey).toMatchObject({ ok: false, message: "Add your Google API key first." });
		await cloud.saveKey(GOOGLE_SECRET_ID, KEY);
		const unconfirmed = await cloud.setProvider({ task: "translation", id: PROVIDER_IDS.googleTranslate });
		expect(unconfirmed.ok).toBe(false);
		expect(settings.current.providers.translation).toEqual([PROVIDER_IDS.bergamot, PROVIDER_IDS.small100]);

		const ok = await cloud.setProvider({ task: "translation", id: PROVIDER_IDS.googleTranslate, confirmed: true });
		expect(ok.ok).toBe(true);
		expect(settings.current.providers.translation).toEqual([
			PROVIDER_IDS.googleTranslate,
			PROVIDER_IDS.bergamot,
			PROVIDER_IDS.small100,
		]);
		expect(ok.cloud.providers.find((p) => p.id === PROVIDER_IDS.googleTranslate)?.selected).toBe(true);

		// Wrong task, unknown id.
		expect((await cloud.setProvider({ task: "ocr", id: PROVIDER_IDS.googleTranslate, confirmed: true })).ok).toBe(
			false,
		);
		expect((await cloud.setProvider({ task: "ocr", id: "nope", confirmed: true })).ok).toBe(false);

		await cloud.setProvider({ task: "ocr", id: PROVIDER_IDS.googleVision, confirmed: true });
		expect(settings.current.providers.ocr).toBe(PROVIDER_IDS.googleVision);

		// Back to this computer.
		await cloud.setProvider({ task: "translation", id: null });
		await cloud.setProvider({ task: "ocr", id: null });
		expect(settings.current.providers).toMatchObject({
			ocr: PROVIDER_IDS.paddleocr,
			translation: [PROVIDER_IDS.bergamot, PROVIDER_IDS.small100],
		});
	});

	test("removing the key deletes it and switches every task that used it back to this computer", async () => {
		const { cloud, settings, secrets, keyChanges } = setup({ key: KEY });
		await cloud.setProvider({ task: "translation", id: PROVIDER_IDS.googleTranslate, confirmed: true });
		await cloud.setProvider({ task: "ocr", id: PROVIDER_IDS.googleVision, confirmed: true });
		const r = await cloud.removeKey(GOOGLE_SECRET_ID);
		expect(r.ok).toBe(true);
		expect(secrets.items.has(GOOGLE_SECRET_ID)).toBe(false);
		expect(settings.current.providers).toMatchObject({
			ocr: PROVIDER_IDS.paddleocr,
			translation: [PROVIDER_IDS.bergamot, PROVIDER_IDS.small100],
		});
		expect(r.cloud.providers.every((p) => !p.selected)).toBe(true);
		expect(keyChanges).toEqual([GOOGLE_SECRET_ID]);
	});

	test("Test key: per-API results kept for the session, cleared when the key changes", async () => {
		const fake = new FakeFetch()
			.on("GET", LANGUAGES_V2_ENDPOINT, { json: { data: { languages: [] } } })
			.on("POST", VISION_ENDPOINT, {
				status: 403,
				json: {
					error: {
						code: 403,
						message: "Cloud Vision API has not been used in project 1 before or it is disabled.",
						status: "PERMISSION_DENIED",
						details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
					},
				},
			});
		const { cloud } = setup({ key: KEY, fetch: fake });
		const r = await cloud.testKey(GOOGLE_SECRET_ID);
		expect(r.cloud.keys[0]?.lastTest).toEqual({
			at: 1_000,
			ok: false,
			checks: [
				{ api: "translate", name: "Cloud Translation API", ok: true },
				{
					api: "vision",
					name: "Cloud Vision API",
					ok: false,
					problem: "api-disabled",
					message: expect.stringContaining("Cloud Vision API isn't enabled"),
				},
			],
		});
		for (const c of fake.calls) expect(c.headers["x-goog-api-key"]).toBe(KEY);
		const after = await cloud.saveKey(GOOGLE_SECRET_ID, KEY.replace("test", "next"));
		expect(after.cloud.keys[0]?.lastTest).toBeNull();
	});

	test("Test key without a saved key", async () => {
		const { cloud, fake } = setup();
		expect(await cloud.testKey(GOOGLE_SECRET_ID)).toMatchObject({ ok: false, message: "No key is saved." });
		expect(fake.calls).toHaveLength(0);
	});

	test("Live consent: shown from settings and reset", async () => {
		const { cloud, settings } = setup();
		await settings.update({ cloud: { liveConsent: [PROVIDER_IDS.googleTranslate] } });
		expect((await cloud.snapshot()).liveConsent).toEqual([PROVIDER_IDS.googleTranslate]);
		const r = await cloud.resetLiveConsent();
		expect(r.cloud.liveConsent).toEqual([]);
		expect(settings.current.cloud.liveConsent).toEqual([]);
	});

	test("links: only the fixed set opens", () => {
		const { cloud, opened } = setup();
		expect(cloud.openLink("console")).toEqual({ ok: true });
		expect(cloud.openLink("https://evil.example")).toMatchObject({ ok: false });
		expect(opened).toEqual([CLOUD_LINKS.console]);
	});

	test("open views hear about changes, including ones made elsewhere (Live remembering consent)", async () => {
		const { cloud, settings } = setup();
		const seen: string[][] = [];
		cloud.subscribe((s) => seen.push([...s.liveConsent]));
		await settings.update({ cloud: { liveConsent: [PROVIDER_IDS.googleTranslate] } });
		await Bun.sleep(5);
		expect(seen.at(-1)).toEqual([PROVIDER_IDS.googleTranslate]);
	});

	test("the Settings RPC handlers pass through and validate shapes", async () => {
		const { cloud } = setup();
		const h = createSettingsHandlers({ cloud } as unknown as SettingsDeps);
		expect((await h.saveApiKey(null)).ok).toBe(false);
		expect((await h.saveApiKey({ secretId: GOOGLE_SECRET_ID, key: KEY })).ok).toBe(true);
		expect((await h.getCloud()).keys[0]?.saved).toBe(true);
		expect((await h.setProvider("x")).ok).toBe(false);
		expect(h.openCloudLink({ link: "terms" })).toEqual({ ok: true });
	});
});
