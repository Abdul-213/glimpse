// GLIM-120: the cloud spend guard, app side: the counters file, CloudSettings' usage actions,
// and the copy that shows it (Settings › Providers, the Snip and Live popups).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CloudUsageState,
	DEFAULT_HOTKEYS,
	defaultSettings,
	isProviderError,
	languageCode,
	nullLogger,
	PROVIDER_IDS,
	ProviderRegistry,
	type SettingsEnv,
	type SpendCap,
	usageSummary,
} from "@glimpse/core";
import { MemorySecretStore, MemorySettingsStore } from "@glimpse/core/testing";
import { AppSettings } from "../src/bun/services/app-settings.ts";
import { CLOUD_LINKS, CloudSettings } from "../src/bun/services/cloud-settings.ts";
import {
	CLOUD_USAGE_FILE,
	CloudUsage,
	type CloudUsageStore,
	fileCloudUsageStore,
} from "../src/bun/services/cloud-usage.ts";
import { type AppProviderContext, registerProviders } from "../src/bun/services/providers.ts";
import {
	monthName,
	nextMonthStart,
	pauseState,
	usageApiName,
	usageDescription,
	usd,
} from "../src/views/settings/panes/usage-copy.ts";

const VISION = PROVIDER_IDS.googleVision;
const TRANSLATE = PROVIDER_IDS.googleTranslate;
const NOV_15 = Date.UTC(2026, 10, 15, 12);
const DEC_2 = Date.UTC(2026, 11, 2, 12);

function memoryStore(initial: unknown = null) {
	const saved: CloudUsageState[] = [];
	let fail = false;
	const store: CloudUsageStore = {
		load: async () => initial,
		save: async (s) => {
			if (fail) throw new Error("disk full");
			saved.push(s);
		},
	};
	return { store, saved, failNext: () => (fail = true) };
}

function usage(opts: { initial?: unknown; cap?: SpendCap; now?: () => number } = {}) {
	const mem = memoryStore(opts.initial ?? null);
	let cap: SpendCap = opts.cap ?? "freeTier";
	let now = opts.now ?? (() => NOV_15);
	const u = new CloudUsage({
		store: mem.store,
		cap: () => cap,
		now: () => now(),
		log: nullLogger,
		saveDelayMs: 5,
	});
	return {
		u,
		...mem,
		setCap: (c: SpendCap) => (cap = c),
		setNow: (n: number) => (now = () => n),
	};
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CloudUsage (GLIM-120)", () => {
	test("counts per API and pauses at the free tier when the cap is on", () => {
		const { u } = usage();
		for (let i = 0; i < 999; i++) u.record(VISION, 1);
		expect(() => u.admit(VISION)).not.toThrow();
		u.record(VISION, 1);
		const error = (() => {
			try {
				u.admit(VISION);
			} catch (e) {
				return e;
			}
			return null;
		})();
		expect(isProviderError(error, "spend-cap")).toBe(true);
		// Translation has its own free tier.
		expect(() => u.admit(TRANSLATE)).not.toThrow();
		expect(u.summary.apis.find((a) => a.providerId === VISION)).toMatchObject({ used: 1000, paused: true });
	});

	test("cap off: only counts", () => {
		const { u } = usage({ cap: "off" });
		u.record(TRANSLATE, 600_000);
		expect(() => u.admit(TRANSLATE)).not.toThrow();
		expect(u.summary.apis.find((a) => a.providerId === TRANSLATE)?.estimatedUsd).toBeCloseTo(2, 6);
	});

	test("Continue this month lifts the pause, is saved at once, and ends with the month", async () => {
		const { u, saved, setNow } = usage({ initial: { month: "2026-11", counts: { [VISION]: 1000 }, continued: null } });
		await u.load();
		expect(() => u.admit(VISION)).toThrow();
		const summary = await u.continueThisMonth();
		expect(summary.continued).toBe(true);
		expect(saved.at(-1)).toEqual({ month: "2026-11", counts: { [VISION]: 1000 }, continued: "2026-11" });
		expect(() => u.admit(VISION)).not.toThrow();
		// December: counts reset and the choice expired.
		setNow(DEC_2);
		expect(u.summary).toMatchObject({ month: "2026-12", continued: false });
		expect(u.summary.apis.every((a) => a.used === 0)).toBe(true);
	});

	test("load keeps counts recorded before the file was read", async () => {
		const { u } = usage({ initial: { month: "2026-11", counts: { [TRANSLATE]: 100 }, continued: "2026-11" } });
		u.record(TRANSLATE, 20);
		u.record(VISION, 1);
		await u.load();
		expect(u.summary.continued).toBe(true);
		expect(u.summary.apis.map((a) => a.used)).toEqual([1, 120]);
	});

	test("writes are coalesced, and listeners hear about each write", async () => {
		const { u, saved } = usage();
		const heard: number[] = [];
		const off = u.subscribe((s) => heard.push(s.apis[1]?.used ?? -1));
		u.record(TRANSLATE, 5);
		u.record(TRANSLATE, 5);
		u.record(TRANSLATE, 5);
		expect(saved).toHaveLength(0);
		await tick(30);
		expect(saved).toEqual([{ month: "2026-11", counts: { [TRANSLATE]: 15 }, continued: null }]);
		expect(heard).toEqual([15]);
		off();
		await u.flush();
		expect(heard).toEqual([15]);
	});

	test("a failed write is logged, not thrown", async () => {
		const { u, saved, failNext } = usage();
		failNext();
		u.record(VISION, 1);
		await u.flush();
		expect(saved).toHaveLength(0);
	});

	test("the file store round-trips and treats a missing or broken file as empty", async () => {
		const dir = await mkdtemp(join(tmpdir(), "glim-usage-"));
		try {
			const store = fileCloudUsageStore(join(dir, "nested"));
			expect(await store.load()).toBeNull();
			const state: CloudUsageState = { month: "2026-11", counts: { [VISION]: 3 }, continued: null };
			await store.save(state);
			expect(await store.load()).toEqual(state);
			// Numbers only: no text, no per-request records.
			expect(await readFile(join(dir, "nested", CLOUD_USAGE_FILE), "utf8")).toBe(`${JSON.stringify(state)}\n`);
			await writeFile(join(dir, "nested", CLOUD_USAGE_FILE), "{not json");
			expect(await store.load()).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("CloudSettings usage actions (GLIM-120)", () => {
	function setup(withUsage = true) {
		const registry = new ProviderRegistry<AppProviderContext>();
		registerProviders(registry);
		const env: SettingsEnv = {
			hotkeys: DEFAULT_HOTKEYS.windows,
			providers: registry.configSchema(),
			targetLanguage: languageCode("en"),
		};
		const settings = new AppSettings(defaultSettings(env), new MemorySettingsStore(), env);
		const u = new CloudUsage({
			store: memoryStore().store,
			cap: () => settings.current.cloud.spendCap,
			now: () => NOV_15,
			log: nullLogger,
		});
		const cloud = new CloudSettings({
			registry,
			secrets: new MemorySecretStore({}),
			settings,
			openUrl: () => true,
			now: () => NOV_15,
			...(withUsage ? { usage: u } : {}),
		});
		return { cloud, settings, u };
	}

	test("the pause is on by default; the snapshot carries this month's counts", async () => {
		const { cloud, settings, u } = setup();
		expect(settings.current.cloud.spendCap).toBe("freeTier");
		u.record(TRANSLATE, 500_000);
		const s = await cloud.snapshot();
		expect(s.usage).toMatchObject({ month: "2026-11", cap: "freeTier", continued: false });
		expect(s.usage.apis.find((a) => a.providerId === TRANSLATE)).toMatchObject({ used: 500_000, paused: true });
	});

	test("setSpendCap saves a known value and rejects anything else", async () => {
		const { cloud, settings } = setup();
		const off = await cloud.setSpendCap({ cap: "off" });
		expect(off.ok).toBe(true);
		expect(settings.current.cloud.spendCap).toBe("off");
		expect(off.cloud.usage.cap).toBe("off");
		const bad = await cloud.setSpendCap({ cap: "always" });
		expect(bad).toMatchObject({ ok: false, message: "Unknown setting." });
		expect(settings.current.cloud.spendCap).toBe("off");
	});

	test("continueCloud lifts the pause", async () => {
		const { cloud, u } = setup();
		u.record(VISION, 1000);
		const r = await cloud.continueCloud();
		expect(r.ok).toBe(true);
		expect(r.cloud.usage.continued).toBe(true);
		expect(r.cloud.usage.apis.every((a) => !a.paused)).toBe(true);
	});

	test("without the guard, Settings shows an empty month", async () => {
		const { cloud } = setup(false);
		const s = await cloud.snapshot();
		expect(s.usage.month).toBe("2026-11");
		expect(s.usage.apis.every((a) => a.used === 0)).toBe(true);
	});

	test("pricing and quota links are fixed Google pages", () => {
		expect(CLOUD_LINKS.visionPricing).toBe("https://cloud.google.com/vision/pricing");
		expect(CLOUD_LINKS.quotas).toStartWith("https://console.cloud.google.com/");
	});
});

describe("usage copy (GLIM-120)", () => {
	const nov = (counts: Record<string, number>, cap: SpendCap = "freeTier", continued: string | null = null) =>
		usageSummary({ month: "2026-11", counts, continued }, cap, "2026-11");

	test("names, money and months", () => {
		expect(usageApiName(VISION)).toBe("Cloud Vision");
		expect(usageApiName(TRANSLATE)).toBe("Cloud Translation");
		expect(usd(0)).toBe("$0.00");
		expect(usd(0.0015)).toBe("less than $0.01");
		expect(usd(1.239)).toBe("$1.24");
		expect(monthName("2026-11")).toBe("November 2026");
		expect(nextMonthStart("2026-11")).toBe("December 1");
		expect(nextMonthStart("2026-12")).toBe("January 1");
	});

	test("row descriptions: inside the free tier, past it, paused", () => {
		const [vision, translate] = nov({ [VISION]: 214, [TRANSLATE]: 503_870 }).apis;
		if (!vision || !translate) throw new Error("two APIs");
		expect(usageDescription(vision)).toBe("214 of 1,000 free images. Estimated cost $0.00.");
		expect(usageDescription(translate)).toBe(
			"503,870 of 500,000 free characters: free tier used up. Estimated cost $0.08 at list prices. Paused until you continue or the month ends.",
		);
		const [, notPaused] = nov({ [TRANSLATE]: 503_870 }, "off").apis;
		if (!notPaused) throw new Error("two APIs");
		expect(usageDescription(notPaused)).not.toContain("Paused");
	});

	test("the pause row: paused, continued, or nothing", () => {
		expect(pauseState(nov({ [VISION]: 1000 }))).toEqual({
			label: "Cloud use is paused",
			description: "Cloud Vision reached the free tier, so Glimpse stopped sending to it. Continuing may cost money.",
		});
		expect(pauseState(nov({ [VISION]: 1000 }, "freeTier", "2026-11"))?.label).toBe("Continuing this month");
		expect(pauseState(nov({ [VISION]: 1000 }, "off"))).toBeNull();
		expect(pauseState(nov({}))).toBeNull();
	});
});
