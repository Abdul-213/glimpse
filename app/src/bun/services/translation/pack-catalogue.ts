// Loading the Bergamot pack catalogue into the pack source at startup (GLIM-101).
//
// The catalogue only says what can be downloaded; installed packs translate without it. So:
// the cached copy first, with no network, so download offers work offline at once; then one
// refresh from Remote Settings (which falls back to the cached copy). This is metadata only,
// at startup, never on the translate path.
import type { Logger } from "@glimpse/core";
import { loadBergamotCatalogue } from "../models/catalogue.ts";
import type { FetchLike } from "../models/download.ts";
import type { ModelManagerPackSource } from "./bergamot-packs.ts";

export type CatalogueSource = "network" | "cache" | "none";

/** Never rejects. Resolves with where the catalogue finally came from. */
export async function loadPackCatalogue(
	packs: Pick<ModelManagerPackSource, "setCatalogue">,
	cacheFile: string,
	options: { readonly refresh: boolean; readonly fetch?: FetchLike; readonly log?: Logger },
): Promise<CatalogueSource> {
	const cacheOnly: FetchLike = () => Promise.reject(new Error("cache only"));
	let source: CatalogueSource = "none";
	try {
		const cached = await loadBergamotCatalogue({ cacheFile, fetch: cacheOnly });
		packs.setCatalogue(cached.packs);
		source = "cache";
	} catch {
		// No cached copy yet.
	}
	if (!options.refresh) return source;
	try {
		const fresh = await loadBergamotCatalogue({ cacheFile, ...(options.fetch ? { fetch: options.fetch } : {}) });
		packs.setCatalogue(fresh.packs);
		options.log?.info("pack catalogue loaded", { source: fresh.source, packs: fresh.packs.length });
		return fresh.source;
	} catch (error) {
		options.log?.warn("pack catalogue unavailable", { error });
		return source;
	}
}
