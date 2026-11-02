// Pick the translation provider for one pair from the configured chain (GLIM-85: Bergamot
// first, SMaLL-100 for the long tail, Hy-MT2 first when Enhanced is on).

import type { LanguageCode } from "../language.ts";
import { type PairSupport, supportsLanguage, type TranslationProvider } from "./translation.ts";

export type TranslationRoute =
	/** Translate with this provider now. */
	| {
			readonly status: "ready";
			readonly provider: TranslationProvider;
			readonly support: PairSupport & { status: "ready" };
	  }
	/**
	 * Nothing ready, but this provider could serve it after a download. The UI offers it
	 * ("Download Thai → English (31 MB)") and never falls through to anything else.
	 */
	| {
			readonly status: "missing";
			readonly provider: TranslationProvider;
			readonly support: PairSupport & { status: "missing" };
	  }
	| { readonly status: "unsupported" };

/**
 * First provider in chain order that is ready for the pair; otherwise the first that only
 * lacks a download; otherwise unsupported. Providers that aren't `ready` are skipped.
 * Never reorders the chain, so a cloud provider is only used where the user put it.
 *
 * A `longTail` provider (SMaLL-100) is only considered when no earlier provider claims the
 * pair (GLIM-100): not one that is ready or only lacks a download for it, and not one that is
 * still starting (`idle` / `loading`) and lists both languages. So a missing Bergamot pack is
 * offered rather than the slower long-tail model, and app start never routes ja → en to it.
 */
export function routeTranslation(
	chain: readonly TranslationProvider[],
	from: LanguageCode,
	to: LanguageCode,
): TranslationRoute {
	let missing: TranslationRoute | null = null;
	let claimed = false;
	for (const provider of chain) {
		if (provider.capabilities.longTail && claimed) continue;
		const state = provider.status.state;
		if (state !== "ready") {
			if ((state === "idle" || state === "loading") && listsPair(provider, from, to)) claimed = true;
			continue;
		}
		const support = provider.pairSupport(from, to);
		if (support.status !== "unsupported") claimed = true;
		if (support.status === "ready") return { status: "ready", provider, support };
		if (support.status === "missing" && !missing) missing = { status: "missing", provider, support };
	}
	return missing ?? { status: "unsupported" };
}

function listsPair(provider: TranslationProvider, from: LanguageCode, to: LanguageCode): boolean {
	const { sources, targets } = provider.capabilities.languages;
	return supportsLanguage(sources, from) && supportsLanguage(targets, to);
}
