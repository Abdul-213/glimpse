// Pick the translation provider for one pair from the configured chain (GLIM-85: Bergamot
// first, SMaLL-100 for the long tail, Hy-MT2 first when Enhanced is on).

import type { LanguageCode } from "../language.ts";
import type { PairSupport, TranslationProvider } from "./translation.ts";

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
 */
export function routeTranslation(
	chain: readonly TranslationProvider[],
	from: LanguageCode,
	to: LanguageCode,
): TranslationRoute {
	let missing: TranslationRoute | null = null;
	for (const provider of chain) {
		if (provider.status.state !== "ready") continue;
		const support = provider.pairSupport(from, to);
		if (support.status === "ready") return { status: "ready", provider, support };
		if (support.status === "missing" && !missing) missing = { status: "missing", provider, support };
	}
	return missing ?? { status: "unsupported" };
}
