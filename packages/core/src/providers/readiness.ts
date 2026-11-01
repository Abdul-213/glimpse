// GLIM-57: offline behaviour and model-missing states, as data the popups render.
//
// Glimpse is offline by default (PRODUCT.md): translation runs on installed packs, a
// missing pack is never fetched silently and never falls through to a cloud provider
// (GLIM-85, GLIM-22). The pipeline asks three questions per language pair:
//
//   1. Which provider serves it? `routeTranslation` (ready beats needs-download).
//   2. If it needs a download, what is the state of that download? (model manager
//      `Availability`: needs-download / downloading / offline / failed).
//   3. What does the popup show? One pack row per missing source language (snip-popup.md
//      §2.2 "pack row", live-popup.md L12) and, when nothing at all can be translated, the
//      E2 error body.
//
// All pure: the app feeds in the provider chain and the model manager's availability.

import type { LanguageCode } from "../language/code.ts";
import type { Availability, InstallError } from "../models/install-state.ts";
import type { ProviderErrorCode, ProviderErrorInfo } from "./errors.ts";
import type { ModelResource } from "./lifecycle.ts";
import type { ProviderId } from "./provenance.ts";
import { routeTranslation } from "./routing.ts";
import type { TranslationProvider } from "./translation.ts";

/** Can `from → to` be translated right now, and if not, what would fix it? */
export type TranslationReadiness =
	| { readonly state: "ready"; readonly providerId: ProviderId }
	/** Missing packs that can be downloaded now ("Download Thai (31 MB)"). */
	| {
			readonly state: "needs-download";
			readonly providerId: ProviderId;
			readonly missing: readonly ModelResource[];
			readonly bytes: number;
	  }
	| {
			readonly state: "downloading";
			readonly providerId: ProviderId;
			readonly missing: readonly ModelResource[];
			/** 0..1 */
			readonly progress: number;
	  }
	/** Missing and there's no network: say "not downloaded", offer nothing that needs a connection. */
	| { readonly state: "offline"; readonly providerId: ProviderId; readonly missing: readonly ModelResource[] }
	| {
			readonly state: "download-failed";
			readonly providerId: ProviderId;
			readonly missing: readonly ModelResource[];
			readonly error: InstallError;
	  }
	/** No provider in the chain can ever serve this pair. */
	| { readonly state: "unsupported" };

/** How the model manager sees a set of resources (`ModelManager.availability`). */
export type AvailabilityOf = (missing: readonly ModelResource[]) => Availability;

/**
 * Combine provider routing with download state. A provider that is ready for the pair
 * always wins, so an installed pivot route beats a direct pack that would need a download,
 * and a ready long-tail provider beats a missing Bergamot pack.
 */
export function translationReadiness(
	chain: readonly TranslationProvider[],
	from: LanguageCode,
	to: LanguageCode,
	availabilityOf: AvailabilityOf,
): TranslationReadiness {
	const route = routeTranslation(chain, from, to);
	if (route.status === "unsupported") return { state: "unsupported" };
	const providerId = route.provider.info.id;
	if (route.status === "ready") return { state: "ready", providerId };
	const { missing } = route.support;
	const availability = availabilityOf(missing);
	switch (availability.kind) {
		// The download finished but the provider hasn't picked the pack up yet. A download prompt
		// would be wrong, so report downloading at 100% until routing catches up.
		case "ready":
			return { state: "downloading", providerId, missing, progress: 1 };
		case "downloading":
			return { state: "downloading", providerId, missing, progress: availability.progress };
		case "needs-download":
			return {
				state: "needs-download",
				providerId,
				missing,
				bytes: availability.bytes || missing.reduce((n, m) => n + (m.bytes ?? 0), 0),
			};
		case "offline":
			return { state: "offline", providerId, missing };
		case "failed":
			return { state: "download-failed", providerId, missing, error: availability.error };
	}
}

/** One row per source language whose pack is missing (snip-popup.md §2.2, `snip.pack.*`). */
export interface PackRow {
	readonly lang: LanguageCode;
	readonly state: "missing" | "downloading" | "offline" | "failed";
	/** Resources to download for this language (the model manager ids). */
	readonly resourceIds: readonly string[];
	/** Download size for "Download ({size})"; 0 when unknown. */
	readonly bytes: number;
	/** 0..1 while downloading. */
	readonly progress: number | null;
	/** Ids of the segments/blocks waiting on this row; they translate in place when it's done. */
	readonly segmentIds: readonly string[];
}

/**
 * Pack rows for a request: segments grouped by source language, only for pairs that need a
 * download. Rows come in first-seen order so the popup doesn't reshuffle them.
 */
export function packRows(
	segments: readonly { readonly id: string; readonly from: LanguageCode }[],
	readinessOf: (from: LanguageCode) => TranslationReadiness,
): PackRow[] {
	const rows = new Map<string, PackRow>();
	for (const segment of segments) {
		const existing = rows.get(segment.from);
		if (existing) {
			rows.set(segment.from, { ...existing, segmentIds: [...existing.segmentIds, segment.id] });
			continue;
		}
		const r = readinessOf(segment.from);
		if (r.state === "ready" || r.state === "unsupported") continue;
		const resourceIds = r.missing.map((m) => m.id);
		const bytes = r.state === "needs-download" ? r.bytes : r.missing.reduce((n, m) => n + (m.bytes ?? 0), 0);
		const state =
			r.state === "needs-download"
				? "missing"
				: r.state === "download-failed"
					? "failed"
					: r.state === "downloading"
						? "downloading"
						: "offline";
		rows.set(segment.from, {
			lang: segment.from,
			state,
			resourceIds,
			bytes,
			progress: r.state === "downloading" ? r.progress : null,
			segmentIds: [segment.id],
		});
	}
	return [...rows.values()];
}

/**
 * What a failed segment shows, by error code. Kinds match the popup specs' error kinds
 * (snip-popup.md §13.2 `error.kind`, live-popup.md L13/L14); copy is chosen by the view.
 */
export type SegmentFailureKind =
	| "packMissing"
	| "offline"
	| "providerKey"
	| "providerQuota"
	| "providerTimeout"
	| "unsupported"
	| "failed";

const FAILURE_KINDS: Partial<Record<ProviderErrorCode, SegmentFailureKind>> = {
	"model-missing": "packMissing",
	offline: "offline",
	"needs-key": "providerKey",
	"invalid-key": "providerKey",
	"quota-exceeded": "providerQuota",
	"rate-limited": "providerQuota",
	timeout: "providerTimeout",
	network: "providerTimeout",
	"unsupported-language": "unsupported",
};

export const segmentFailureKind = (error: Pick<ProviderErrorInfo, "code">): SegmentFailureKind =>
	FAILURE_KINDS[error.code] ?? "failed";

/**
 * The E2 state (snip-popup.md §4): every translate-class block waits on a pack. Returns
 * null when at least one block can be translated (then the pack rows sit above the list
 * instead). `canDownload` is false offline or after a failed download, so the view shows
 * "isn't downloaded yet" without a Download button that can't work.
 */
export interface PackMissingSummary {
	readonly kind: "packMissing";
	readonly languages: readonly LanguageCode[];
	readonly bytes: number;
	readonly canDownload: boolean;
	readonly offline: boolean;
}

export function packMissingSummary(rows: readonly PackRow[], translatableSegments: number): PackMissingSummary | null {
	const waiting = rows.reduce((n, r) => n + r.segmentIds.length, 0);
	if (rows.length === 0 || waiting < translatableSegments) return null;
	return {
		kind: "packMissing",
		languages: rows.map((r) => r.lang),
		bytes: rows.reduce((n, r) => n + r.bytes, 0),
		canDownload: rows.some((r) => r.state === "missing"),
		offline: rows.every((r) => r.state === "offline"),
	};
}
