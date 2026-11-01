// Translation route planning: how to get from `source` to `target` with the language pairs a
// provider has (Bergamot packs are one direction each, mostly to and from English, so
// `ja -> de` runs as `ja -> en -> de`; GLIM-85).

import type { LanguageCode } from "./code.ts";
import { sameLanguage } from "./lookup.ts";

export interface LanguagePair {
	readonly source: LanguageCode;
	readonly target: LanguageCode;
}

/** A route over language-pack pairs inside one provider (not providers/routing.ts, which picks the provider). */
export type PairRoute =
	/** Source and target are the same language: show the original. */
	| { readonly kind: "identity" }
	| { readonly kind: "direct"; readonly hops: readonly [LanguagePair] }
	| { readonly kind: "pivot"; readonly pivot: LanguageCode; readonly hops: readonly [LanguagePair, LanguagePair] };

export interface RouteOptions {
	/** Pivot languages to try, in order. Default: English. */
	readonly pivots?: readonly LanguageCode[];
}

const ENGLISH = "en" as LanguageCode;

/**
 * Plan `source -> target` over `available` pairs. Codes match loosely (`pt-BR` uses a `pt`
 * pack, `zh-TW` a `zh-Hant` one); the returned hops carry the pairs' own codes, ready to hand
 * to the provider. Prefers a direct pair, then a pivot. Returns null when no route exists.
 */
export function planRoute(
	source: LanguageCode,
	target: LanguageCode,
	available: Iterable<LanguagePair>,
	options: RouteOptions = {},
): PairRoute | null {
	if (sameLanguage(source, target)) return { kind: "identity" };
	const pairs = [...available];
	const find = (from: LanguageCode, to: LanguageCode): LanguagePair | undefined =>
		pairs.find((p) => p.source === from && p.target === to) ??
		pairs.find((p) => sameLanguage(p.source, from) && sameLanguage(p.target, to));

	const direct = find(source, target);
	if (direct) return { kind: "direct", hops: [direct] };

	for (const pivot of options.pivots ?? [ENGLISH]) {
		if (sameLanguage(pivot, source) || sameLanguage(pivot, target)) continue;
		const first = find(source, pivot);
		const second = first && find(pivot, target);
		if (first && second) return { kind: "pivot", pivot, hops: [first, second] };
	}
	return null;
}

export interface DownloadPlan {
	readonly route: PairRoute;
	/** Hops of `route` that aren't installed yet, in route order. Empty when it works now. */
	readonly downloads: readonly LanguagePair[];
}

/**
 * Plan a route that may use pairs which can be downloaded. Picks the route needing the fewest
 * downloads (so an installed pivot beats downloading a direct pair: it works offline now),
 * then the fewest hops. Returns null when even the full catalogue has no route.
 */
export function planRouteWithDownloads(
	source: LanguageCode,
	target: LanguageCode,
	installed: Iterable<LanguagePair>,
	downloadable: Iterable<LanguagePair>,
	options: RouteOptions = {},
): DownloadPlan | null {
	const have = [...installed];
	const now = planRoute(source, target, have, options);
	if (now) return { route: now, downloads: [] };

	const isInstalled = (p: LanguagePair) =>
		have.some((h) => sameLanguage(h.source, p.source) && sameLanguage(h.target, p.target));
	const all = [...have, ...downloadable];
	const candidates: DownloadPlan[] = [];
	const direct = planRoute(source, target, all, { pivots: [] });
	if (direct) candidates.push(withDownloads(direct, isInstalled));
	// With a direct pair available planRoute won't return a pivot. That's fine: `now` was null,
	// so any pivot needs at least one download too, and the direct route then wins on hops.
	for (const pivot of options.pivots ?? [ENGLISH]) {
		const route = planRoute(source, target, all, { pivots: [pivot] });
		if (route?.kind === "pivot") candidates.push(withDownloads(route, isInstalled));
	}
	candidates.sort((a, b) => a.downloads.length - b.downloads.length || hopCount(a.route) - hopCount(b.route));
	return candidates[0] ?? null;
}

function withDownloads(route: PairRoute, isInstalled: (p: LanguagePair) => boolean): DownloadPlan {
	const hops = route.kind === "identity" ? [] : route.hops;
	return { route, downloads: hops.filter((h) => !isInstalled(h)) };
}

function hopCount(route: PairRoute): number {
	return route.kind === "identity" ? 0 : route.hops.length;
}
