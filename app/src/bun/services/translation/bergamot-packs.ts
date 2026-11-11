// The Bergamot provider's view of installed packs and the runtime, over the model download
// manager (GLIM-38), plus the downloadable catalogue from Remote Settings (cached on disk).
//
// Reads only local state: the runtime folder, install records and each pack's pack.json.
// Nothing here touches the network; the catalogue is handed in by whoever loaded it
// (`setCatalogue`), so an installed pack translates with no connection at all (GLIM-57).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BergamotPack, fromBergamot, packDownloadSize } from "@glimpse/core";
import type {
	BergamotPackSource,
	BergamotRuntime,
	DownloadablePack,
	InstalledPack,
} from "@glimpse/providers/translation/bergamot";
import type { ModelManager } from "../models/model-manager.ts";

export const RUNTIME_MODEL_ID = "bergamot-runtime";
const PACK_PREFIX = "bergamot-";

export class ModelManagerPackSource implements BergamotPackSource {
	readonly #manager: ModelManager;
	readonly #listeners = new Set<() => void>();
	/** pack.json reads, keyed by `dir@version`. */
	readonly #descriptors = new Map<string, InstalledPack | null>();
	#catalogue: readonly BergamotPack[] = [];
	#downloadable: readonly DownloadablePack[] = [];
	#installed: readonly InstalledPack[] | null = null;
	readonly #unsubscribe: () => void;

	constructor(manager: ModelManager) {
		this.#manager = manager;
		this.#unsubscribe = manager.subscribe((id, state) => {
			if (!id.startsWith(PACK_PREFIX)) return;
			// Only installs and removals change what the provider can use.
			if (state.status === "installed" || state.status === "missing") this.#changed();
		});
	}

	/** The packs Remote Settings offers (fresh or cached). Empty until the app loads it. */
	setCatalogue(packs: readonly BergamotPack[]): void {
		this.#catalogue = packs;
		this.#downloadable = packs.map((p) => ({
			id: p.id,
			source: p.source,
			target: p.target,
			version: p.version,
			bytes: packDownloadSize(p),
		}));
		this.#changed();
	}

	/** Catalogue entry for a pack id, for installing it. */
	catalogueEntry(id: string): BergamotPack | undefined {
		return this.#catalogue.find((p) => p.id === id);
	}

	runtime(): BergamotRuntime | null {
		const dir = this.#manager.modelDir(RUNTIME_MODEL_ID);
		const revision = this.#manager.installedVersion(RUNTIME_MODEL_ID);
		return dir && revision ? { dir, revision } : null;
	}

	installed(): readonly InstalledPack[] {
		if (!this.#installed) {
			const packs: InstalledPack[] = [];
			for (const id of this.#manager.installedIds()) {
				if (!id.startsWith(PACK_PREFIX) || id === RUNTIME_MODEL_ID) continue;
				const dir = this.#manager.modelDir(id);
				const version = this.#manager.installedVersion(id);
				if (!dir || !version) continue;
				const key = `${dir}@${version}`;
				let pack = this.#descriptors.get(key);
				if (pack === undefined) {
					pack = readInstalledPack(id, dir, version);
					this.#descriptors.set(key, pack);
				}
				if (pack) packs.push(pack);
			}
			this.#installed = packs;
		}
		return this.#installed;
	}

	downloadable(): readonly DownloadablePack[] {
		return this.#downloadable;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#unsubscribe();
		this.#listeners.clear();
	}

	#changed(): void {
		this.#installed = null;
		for (const listener of [...this.#listeners]) listener();
	}
}

/** Read `pack.json`; a pack whose descriptor is missing or unmappable is ignored. */
function readInstalledPack(id: string, dir: string, version: string): InstalledPack | null {
	try {
		const json = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as { src?: unknown; tgt?: unknown };
		if (typeof json.src !== "string" || typeof json.tgt !== "string") return null;
		const source = fromBergamot(json.src);
		const target = fromBergamot(json.tgt);
		return source && target ? { id, source, target, version, dir } : null;
	} catch {
		return null;
	}
}
