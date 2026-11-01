// What the Bergamot provider needs to know about language packs and the runtime. The app
// implements it over the model download manager (GLIM-38); tests use `staticPackSource`.
// Synchronous on purpose: `pairSupport` is synchronous, so the source answers from state
// it already holds and calls `subscribe` listeners when something is installed or removed.
import type { LanguageCode } from "@glimpse/core";

/** A pack on disk: `dir` holds its files and `pack.json` (core `packDescriptor`). */
export interface InstalledPack {
	/** Model-manager id, `bergamot-ja-en`. */
	readonly id: string;
	readonly source: LanguageCode;
	readonly target: LanguageCode;
	readonly version: string;
	readonly dir: string;
}

/** A pack that can be downloaded (from the Remote Settings catalogue, maybe a cached copy). */
export interface DownloadablePack {
	readonly id: string;
	readonly source: LanguageCode;
	readonly target: LanguageCode;
	readonly version: string;
	/** Download size in bytes, for "Download Thai → English (31 MB)". */
	readonly bytes: number;
}

export interface BergamotRuntime {
	/** Folder holding `bergamot-translator.wasm` and `bergamot-translator.js`. */
	readonly dir: string;
	/** Runtime revision (manifest revision); part of every hop's model revision. */
	readonly revision: string;
}

export interface BergamotPackSource {
	/** The WASM runtime, or null when it isn't installed (it ships bundled, GLIM-37). */
	runtime(): BergamotRuntime | null;
	installed(): readonly InstalledPack[];
	/** Every pack that could be downloaded; empty when the catalogue is unknown (offline, never fetched). */
	downloadable(): readonly DownloadablePack[];
	/** Called after installed packs, the runtime or the catalogue changed. */
	subscribe(listener: () => void): () => void;
}

/** A fixed pack source, for tests and tools. `update()` replaces the lists and notifies. */
export function staticPackSource(initial: {
	runtime: BergamotRuntime | null;
	installed?: readonly InstalledPack[];
	downloadable?: readonly DownloadablePack[];
}): BergamotPackSource & { update(next: Partial<typeof initial>): void } {
	let state = {
		installed: [] as readonly InstalledPack[],
		downloadable: [] as readonly DownloadablePack[],
		...initial,
	};
	const listeners = new Set<() => void>();
	return {
		runtime: () => state.runtime,
		installed: () => state.installed,
		downloadable: () => state.downloadable,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		update(next) {
			state = { ...state, ...next };
			for (const listener of [...listeners]) listener();
		},
	};
}
