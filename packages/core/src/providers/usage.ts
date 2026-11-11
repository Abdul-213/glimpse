// GLIM-120: the cloud spend guard. Google Cloud budgets only alert; nothing at Google stops
// spend by default (GLIM-22 "Surprise bills"). So Glimpse keeps its own monthly counters of
// what it sent to each metered API, shows them next to Google's free tier, and (optional,
// on by default) pauses cloud use once the free tier is used up, until the user chooses
// "Continue this month" or the month ends.
//
// Privacy (GLIM-22 rule 5): the counters stay on this computer. They are numbers only (no
// text, no images, no timestamps per request) and are never sent anywhere.
//
// Pure: the app keeps the state in a file and supplies the clock.

import { ProviderError } from "./errors.ts";
import type { ProviderId } from "./provenance.ts";
import { PROVIDER_IDS } from "./registry.ts";

/** What a metered API bills by. */
export type CloudUsageUnit = "images" | "characters";

/** Settings › Providers › "Pause cloud use": off, or once an API's free tier is used up. */
export type SpendCap = "off" | "freeTier";
export const SPEND_CAPS: readonly SpendCap[] = ["off", "freeTier"];

export interface MeteredApi {
	readonly providerId: ProviderId;
	readonly unit: CloudUsageUnit;
	/** Units free each month. */
	readonly freeTier: number;
	/** List price per unit after the free tier, USD. */
	readonly usdPerUnit: number;
}

/**
 * Google's list prices and free tiers (GLIM-22 "Cost estimate", read 2026-10-30, before tax):
 * Vision 1,000 units/month free then $1.50 per 1,000 images (one unit per image: Glimpse asks
 * for one feature); Translation v2 500,000 characters/month free (as a $10 credit) then $20
 * per million. Restate before each release (GLIM-22 "Pricing and terms drift").
 */
export const METERED_APIS: readonly MeteredApi[] = [
	{ providerId: PROVIDER_IDS.googleVision, unit: "images", freeTier: 1_000, usdPerUnit: 1.5 / 1_000 },
	{ providerId: PROVIDER_IDS.googleTranslate, unit: "characters", freeTier: 500_000, usdPerUnit: 20 / 1_000_000 },
];
export const USAGE_PRICES_AS_OF = "2026-10-30";

export const meteredApi = (providerId: ProviderId): MeteredApi | undefined =>
	METERED_APIS.find((a) => a.providerId === providerId);

/** What Google bills as one character: a Unicode code point, whitespace included. */
export function billedCharacters(texts: readonly string[]): number {
	let n = 0;
	for (const t of texts) for (const _ of t) n++;
	return n;
}

/**
 * The billing month for an instant, `YYYY-MM`. Google Cloud bills by calendar month in
 * Pacific time, so the free tier resets at midnight on the 1st in Los Angeles, not locally.
 */
export function usageMonth(epochMs: number): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: "America/Los_Angeles",
			year: "numeric",
			month: "2-digit",
		}).formatToParts(new Date(epochMs));
		const year = parts.find((p) => p.type === "year")?.value;
		const month = parts.find((p) => p.type === "month")?.value;
		if (year && month) return `${year}-${month}`;
	} catch {
		// No time zone data: fall back to UTC below.
	}
	return new Date(epochMs).toISOString().slice(0, 7);
}

/** The file contents (`<userData>/cloud-usage.json`). */
export interface CloudUsageState {
	/** `YYYY-MM` the counts belong to. */
	readonly month: string;
	/** Units sent this month, by provider id. */
	readonly counts: Readonly<Record<string, number>>;
	/** The month the user chose "Continue this month" in, or null. */
	readonly continued: string | null;
}

export const emptyUsage = (month: string): CloudUsageState => ({ month, counts: {}, continued: null });

const MONTH = /^\d{4}-\d{2}$/;

/** Any JSON -> a valid state (unknown providers and bad numbers dropped). Never throws. */
export function parseCloudUsageState(json: unknown, month: string): CloudUsageState {
	if (typeof json !== "object" || json === null) return emptyUsage(month);
	const o = json as Record<string, unknown>;
	const m = typeof o["month"] === "string" && MONTH.test(o["month"]) ? o["month"] : month;
	const counts: Record<string, number> = {};
	const raw = o["counts"];
	if (typeof raw === "object" && raw !== null) {
		for (const api of METERED_APIS) {
			const v = (raw as Record<string, unknown>)[api.providerId];
			if (typeof v === "number" && Number.isFinite(v) && v > 0) counts[api.providerId] = Math.floor(v);
		}
	}
	const continued = typeof o["continued"] === "string" && MONTH.test(o["continued"]) ? o["continued"] : null;
	return rollMonth({ month: m, counts, continued }, month);
}

/** A new month starts from zero, and "Continue this month" expires with the old one. */
export function rollMonth(state: CloudUsageState, month: string): CloudUsageState {
	return state.month === month ? state : emptyUsage(month);
}

export function addUsage(
	state: CloudUsageState,
	providerId: ProviderId,
	units: number,
	month: string,
): CloudUsageState {
	const s = rollMonth(state, month);
	if (!meteredApi(providerId) || !(units > 0)) return s;
	return { ...s, counts: { ...s.counts, [providerId]: (s.counts[providerId] ?? 0) + Math.ceil(units) } };
}

/** List-price estimate of this month's bill for one API, USD (0 inside the free tier). */
export const estimatedUsd = (api: MeteredApi, used: number): number =>
	Math.max(0, used - api.freeTier) * api.usdPerUnit;

/** True when the cap stops new requests to this API this month. */
export function isPaused(state: CloudUsageState, providerId: ProviderId, cap: SpendCap, month: string): boolean {
	if (cap === "off") return false;
	const s = rollMonth(state, month);
	if (s.continued === month) return false;
	const api = meteredApi(providerId);
	return api !== undefined && (s.counts[providerId] ?? 0) >= api.freeTier;
}

export interface MeteredApiUsage {
	readonly providerId: ProviderId;
	readonly unit: CloudUsageUnit;
	readonly used: number;
	readonly freeTier: number;
	readonly estimatedUsd: number;
	readonly paused: boolean;
}

export interface CloudUsageSummary {
	readonly month: string;
	readonly cap: SpendCap;
	/** "Continue this month" was chosen for this month. */
	readonly continued: boolean;
	readonly apis: readonly MeteredApiUsage[];
	readonly pricesAsOf: string;
}

export function usageSummary(state: CloudUsageState, cap: SpendCap, month: string): CloudUsageSummary {
	const s = rollMonth(state, month);
	return {
		month,
		cap,
		continued: s.continued === month,
		apis: METERED_APIS.map((api) => {
			const used = s.counts[api.providerId] ?? 0;
			return {
				providerId: api.providerId,
				unit: api.unit,
				used,
				freeTier: api.freeTier,
				estimatedUsd: estimatedUsd(api, used),
				paused: isPaused(s, api.providerId, cap, month),
			};
		}),
		pricesAsOf: USAGE_PRICES_AS_OF,
	};
}

/**
 * What cloud providers call around each request (through their context). `admit` before
 * sending: throws `ProviderError("spend-cap")` when the guard has paused this API. `record`
 * after the service answered (failed requests aren't billed).
 */
export interface CloudUsageGate {
	admit(providerId: ProviderId): void;
	record(providerId: ProviderId, units: number): void;
}

export const spendCapError = (providerId: ProviderId): ProviderError =>
	new ProviderError("spend-cap", "paused by the monthly spend guard", { providerId, retryable: false });
