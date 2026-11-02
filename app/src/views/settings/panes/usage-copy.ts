// Settings › Providers › "Cloud use this month" copy (GLIM-120). Pure: unit-tested without a DOM.
import type { CloudUsageSummary, MeteredApiUsage } from "@glimpse/core";

const API_NAMES: Readonly<Record<string, string>> = {
	"cloud:google-vision": "Cloud Vision",
	"cloud:google-translate-v2": "Cloud Translation",
};

export const usageApiName = (providerId: string): string => API_NAMES[providerId] ?? providerId;

const count = (n: number) => n.toLocaleString("en-US");

/** "$0.00", "$1.24". Under a cent but above zero reads "less than $0.01". */
export function usd(amount: number): string {
	if (amount > 0 && amount < 0.005) return "less than $0.01";
	return `$${amount.toFixed(2)}`;
}

/** "214 of 1,000 free images", "503,870 of 500,000 free characters". */
export function usageLine(u: Pick<MeteredApiUsage, "used" | "freeTier" | "unit">): string {
	return `${count(u.used)} of ${count(u.freeTier)} free ${u.unit}`;
}

/** The row's description: the count against the free tier, then the estimate (and the pause). */
export function usageDescription(u: MeteredApiUsage): string {
	if (u.used < u.freeTier) return `${usageLine(u)}. Estimated cost $0.00.`;
	const paused = u.paused ? " Paused until you continue or the month ends." : "";
	return `${usageLine(u)}: free tier used up. Estimated cost ${usd(u.estimatedUsd)} at list prices.${paused}`;
}

/** "November 2026" for "2026-11". */
export function monthName(month: string): string {
	const [y, m] = month.split("-").map(Number);
	if (!y || !m) return month;
	return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "December 1" for "2026-11": when the free tier resets and a "Continue this month" ends. */
export function nextMonthStart(month: string): string {
	const [y, m] = month.split("-").map(Number);
	if (!y || !m) return "the 1st";
	return new Date(Date.UTC(y, m, 1)).toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The pause row under the counters, or null when nothing is paused and nothing was continued. */
export function pauseState(s: CloudUsageSummary): { readonly label: string; readonly description: string } | null {
	const paused = s.apis.filter((a) => a.paused).map((a) => usageApiName(a.providerId));
	if (paused.length > 0) {
		return {
			label: "Cloud use is paused",
			description: `${paused.join(" and ")} reached the free tier, so Glimpse stopped sending to it. Continuing may cost money.`,
		};
	}
	if (s.continued && s.cap === "freeTier") {
		return {
			label: "Continuing this month",
			description: `You chose to keep using Google Cloud past the free tier. The pause is back on ${nextMonthStart(s.month)}.`,
		};
	}
	return null;
}
