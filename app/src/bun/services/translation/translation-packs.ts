// GLIM-57: offline behaviour and model-missing states, app side.
//
// - `readiness` / `rows`: what the popups show for a request's source languages (core
//   `translationReadiness`, `packRows`), using the model manager's download state.
// - `download`: the only way a pack gets fetched, called from the popup's `downloadPack`
//   intent (the user's consent). Never called by routing or translation.
// - `subscribe`: fires when a pack's install state changes, so the popup can update its row
//   and re-translate the blocks that were waiting when the pack lands.
import {
	type InstallState,
	type LanguageCode,
	languageName,
	type ModelResource,
	type PackRow,
	packRows,
	type TranslationProvider,
	type TranslationReadiness,
	translationReadiness,
} from "@glimpse/core";
import type { PackChangedMessage } from "../../../shared/translation-packs.ts";
import { packInstallable } from "../models/catalogue.ts";
import type { ModelManager } from "../models/model-manager.ts";
import type { ModelManagerPackSource } from "./bergamot-packs.ts";

export interface TranslationPacksOptions {
	readonly manager: ModelManager;
	readonly packs: ModelManagerPackSource;
	/** The translation chain in settings order (GLIM-43). */
	readonly chain: () => readonly TranslationProvider[];
}

export class TranslationPacks {
	readonly #opts: TranslationPacksOptions;

	constructor(options: TranslationPacksOptions) {
		this.#opts = options;
	}

	readiness(from: LanguageCode, to: LanguageCode): TranslationReadiness {
		const { manager } = this.#opts;
		return translationReadiness(this.#opts.chain(), from, to, (missing: readonly ModelResource[]) =>
			manager.availability(missing.map((m) => ({ id: m.id, downloadBytes: m.bytes ?? 0 }))),
		);
	}

	rows(segments: readonly { readonly id: string; readonly from: LanguageCode }[], to: LanguageCode): PackRow[] {
		return packRows(segments, (from) => this.readiness(from, to));
	}

	/**
	 * Install packs the user agreed to download. Only catalogue packs are accepted; resolves
	 * with each pack's final install state (failed installs resolve, they don't throw).
	 */
	async download(resourceIds: readonly string[]): Promise<InstallState[]> {
		const items = resourceIds.map((id) => {
			const pack = this.#opts.packs.catalogueEntry(id);
			if (!pack) throw new Error(`not a downloadable pack: ${id}`);
			return packInstallable(pack);
		});
		return Promise.all(items.map((item) => this.#opts.manager.install(item)));
	}

	cancel(resourceIds: readonly string[]): void {
		for (const id of resourceIds) this.#opts.manager.cancel(id);
	}

	/** Install-state changes for language packs. */
	subscribe(listener: (id: string, state: InstallState) => void): () => void {
		return this.#opts.manager.subscribe((id, state) => {
			if (id.startsWith("bergamot-") && id !== "bergamot-runtime") listener(id, state);
		});
	}
}

/**
 * The `packChanged` push for one row. `done` rows are sent once when a row disappears (its
 * pack installed) so the view can drop it and show the blocks translating in place.
 */
export function packChangedMessage(
	requestId: string,
	row: PackRow | { readonly lang: LanguageCode; readonly state: "done"; readonly segmentIds: readonly string[] },
	uiLanguage: string,
	states: (id: string) => InstallState = () => ({ status: "missing" }),
): PackChangedMessage {
	const base = { requestId, lang: row.lang, langName: languageName(row.lang, uiLanguage), blockIds: row.segmentIds };
	if (row.state === "done") return { ...base, state: "done", bytes: 0 };
	const message: PackChangedMessage = { ...base, state: row.state, bytes: row.bytes };
	if (row.state === "downloading") {
		let done = 0;
		let total = 0;
		for (const id of row.resourceIds) {
			const s = states(id);
			if (s.status === "downloading") {
				done += s.receivedBytes;
				total += s.totalBytes;
			}
		}
		return total > 0 ? { ...message, done, total } : message;
	}
	if (row.state === "failed") {
		const failed = row.resourceIds.map(states).find((s) => s.status === "failed");
		return failed?.status === "failed" ? { ...message, error: failed.error.kind } : message;
	}
	return message;
}
