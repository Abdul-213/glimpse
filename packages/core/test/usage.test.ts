// GLIM-120: the cloud spend guard's pure rules (counters, months, pause, estimates).
import { describe, expect, test } from "bun:test";
import {
	addUsage,
	billedCharacters,
	type CloudUsageState,
	emptyUsage,
	estimatedUsd,
	isPaused,
	METERED_APIS,
	meteredApi,
	PROVIDER_IDS,
	parseCloudUsageState,
	rollMonth,
	spendCapError,
	usageMonth,
	usageSummary,
} from "@glimpse/core";

const VISION = PROVIDER_IDS.googleVision;
const TRANSLATE = PROVIDER_IDS.googleTranslate;
const NOV = "2026-11";

describe("usageMonth", () => {
	test("Google bills in Pacific time: the month turns at midnight in Los Angeles", () => {
		// 2026-12-01 07:59 UTC is still 23:59 on Nov 30 in Los Angeles (PST, UTC-8).
		expect(usageMonth(Date.UTC(2026, 11, 1, 7, 59))).toBe("2026-11");
		expect(usageMonth(Date.UTC(2026, 11, 1, 8, 0))).toBe("2026-12");
		expect(usageMonth(Date.UTC(2026, 0, 15))).toBe("2026-01");
	});
});

describe("billedCharacters", () => {
	test("counts code points, whitespace included (what Translation bills)", () => {
		expect(billedCharacters(["Hi there", "猫"])).toBe(9);
		// One emoji outside the BMP is one character, not two UTF-16 units.
		expect(billedCharacters(["😀 ok"])).toBe(4);
		expect(billedCharacters([])).toBe(0);
	});
});

describe("counters", () => {
	test("addUsage counts metered APIs only, rounds up, ignores non-positive units", () => {
		let s = emptyUsage(NOV);
		s = addUsage(s, VISION, 1, NOV);
		s = addUsage(s, VISION, 1, NOV);
		s = addUsage(s, TRANSLATE, 10.2, NOV);
		s = addUsage(s, PROVIDER_IDS.bergamot, 50, NOV);
		s = addUsage(s, TRANSLATE, 0, NOV);
		s = addUsage(s, TRANSLATE, -5, NOV);
		expect(s.counts).toEqual({ [VISION]: 2, [TRANSLATE]: 11 });
	});

	test("a new month starts from zero and drops Continue this month", () => {
		const old: CloudUsageState = { month: "2026-10", counts: { [VISION]: 900 }, continued: "2026-10" };
		expect(rollMonth(old, NOV)).toEqual(emptyUsage(NOV));
		expect(addUsage(old, VISION, 1, NOV)).toEqual({ month: NOV, counts: { [VISION]: 1 }, continued: null });
		expect(rollMonth(old, "2026-10")).toBe(old);
	});

	test("parse never throws and keeps only valid numbers for known APIs", () => {
		expect(parseCloudUsageState(null, NOV)).toEqual(emptyUsage(NOV));
		expect(parseCloudUsageState("nope", NOV)).toEqual(emptyUsage(NOV));
		expect(
			parseCloudUsageState(
				{
					month: NOV,
					counts: { [VISION]: 12.7, [TRANSLATE]: -3, other: 5, [PROVIDER_IDS.bergamot]: 9 },
					continued: NOV,
				},
				NOV,
			),
		).toEqual({ month: NOV, counts: { [VISION]: 12 }, continued: NOV });
		expect(parseCloudUsageState({ month: "bad", counts: { [VISION]: Number.NaN }, continued: 4 }, NOV)).toEqual(
			emptyUsage(NOV),
		);
		// Last month's file reads as an empty month.
		expect(parseCloudUsageState({ month: "2026-10", counts: { [VISION]: 5 }, continued: null }, NOV)).toEqual(
			emptyUsage(NOV),
		);
	});
});

describe("the pause", () => {
	const vision = meteredApi(VISION);
	if (!vision) throw new Error("Vision is metered");
	const atTier: CloudUsageState = { month: NOV, counts: { [VISION]: vision.freeTier }, continued: null };

	test("pauses an API once its free tier is used up, only with the cap on", () => {
		const under = { ...atTier, counts: { [VISION]: vision.freeTier - 1 } };
		expect(isPaused(under, VISION, "freeTier", NOV)).toBe(false);
		expect(isPaused(atTier, VISION, "freeTier", NOV)).toBe(true);
		expect(isPaused(atTier, VISION, "off", NOV)).toBe(false);
		// Each API has its own free tier: Vision used up doesn't pause Translation.
		expect(isPaused(atTier, TRANSLATE, "freeTier", NOV)).toBe(false);
		expect(isPaused(atTier, PROVIDER_IDS.bergamot, "freeTier", NOV)).toBe(false);
	});

	test("Continue this month lifts it until the month ends", () => {
		const continued = { ...atTier, continued: NOV };
		expect(isPaused(continued, VISION, "freeTier", NOV)).toBe(false);
		// Next month: counts reset, so nothing is paused either; a new month needs a new choice.
		const dec = addUsage(continued, VISION, vision.freeTier, "2026-12");
		expect(dec.continued).toBeNull();
		expect(isPaused(dec, VISION, "freeTier", "2026-12")).toBe(true);
	});

	test("spendCapError is a non-retryable spend-cap ProviderError naming the provider", () => {
		const e = spendCapError(VISION);
		expect(e.code).toBe("spend-cap");
		expect(e.retryable).toBe(false);
		expect(e.providerId).toBe(VISION);
	});
});

describe("estimates and the summary", () => {
	test("list price after the free tier, zero inside it", () => {
		const [vision, translate] = METERED_APIS;
		if (!vision || !translate) throw new Error("two metered APIs");
		expect(estimatedUsd(vision, 999)).toBe(0);
		expect(estimatedUsd(vision, 3_000)).toBeCloseTo(3, 6); // 2,000 images at $1.50 / 1,000
		expect(estimatedUsd(translate, 1_500_000)).toBeCloseTo(20, 6); // 1M characters at $20 / 1M
	});

	test("usageSummary lists both APIs with counts, free tiers, estimates and pause state", () => {
		const s: CloudUsageState = { month: NOV, counts: { [TRANSLATE]: 600_000 }, continued: null };
		const sum = usageSummary(s, "freeTier", NOV);
		expect(sum).toMatchObject({ month: NOV, cap: "freeTier", continued: false });
		expect(sum.apis).toEqual([
			{ providerId: VISION, unit: "images", used: 0, freeTier: 1_000, estimatedUsd: 0, paused: false },
			{
				providerId: TRANSLATE,
				unit: "characters",
				used: 600_000,
				freeTier: 500_000,
				estimatedUsd: expect.closeTo(2, 6),
				paused: true,
			},
		]);
		expect(usageSummary(s, "off", NOV).apis.every((a) => !a.paused)).toBe(true);
		expect(usageSummary({ ...s, continued: NOV }, "freeTier", NOV).continued).toBe(true);
	});
});
