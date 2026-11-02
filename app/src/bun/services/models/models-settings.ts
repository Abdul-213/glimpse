// What Settings › Models shows and does (GLIM-69, GLIM-96): installed OCR recognisers,
// translation runtime and language packs with their sizes, downloads with progress, removal,
// and the storage folder (move, reset, size, free space).
//
// Network: nothing here goes online unless the user asks. The pack catalogue (Mozilla Remote
// Settings) is fetched only by `loadCatalogue`, from the "Find language packs" button; installs
// only start from an explicit Download / Add.
//
// No electrobun imports: the composition root passes the folder picker result in, so this is
// tested on Linux with a temp dir and a fake fetch.
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	type BergamotPack,
	displayName,
	downloadSize,
	type InstallState,
	isBusy,
	type LanguageCode,
	type LanguagePair,
	type ModelEntry,
	type ModelManifest,
	nativeName,
	type OcrRecognizer,
	packDownloadSize,
	planRouteWithDownloads,
	sourceLanguageFor,
} from "@glimpse/core";
import type { ActionResult, ModelRow, ModelRowState, ModelsSnapshot } from "../../../shared/settings-rpc.ts";
import type { ModelManagerPackSource } from "../translation/bergamot-packs.ts";
import { SMALL100_DETAIL, SMALL100_RESOURCE_NAME } from "../translation/small100-model.ts";
import { type BergamotCatalogue, manifestInstallable, packInstallable } from "./catalogue.ts";
import { type ModelManager, volumeFreeBytes } from "./model-manager.ts";

const RECOGNISER_NAMES: Record<OcrRecognizer, string> = {
	ch: "Chinese and Japanese",
	en: "English",
	latin: "Latin-script languages",
	korean: "Korean",
	eslav: "Russian, Ukrainian and Belarusian",
	cyrillic: "Other Cyrillic-script languages",
	arabic: "Arabic-script languages",
	devanagari: "Hindi, Marathi, Nepali (Devanagari)",
	th: "Thai",
	el: "Greek",
	ta: "Tamil",
	te: "Telugu",
};

export interface ModelsSettingsOptions {
	readonly manager: ModelManager;
	readonly manifest: ModelManifest | null;
	readonly packs: ModelManagerPackSource;
	/** Fetch the pack catalogue (network, falling back to the cached copy). */
	readonly loadCatalogue: () => Promise<BergamotCatalogue>;
	/** `<userData>/models`. */
	readonly defaultDirectory: string;
	/** Current target language (settings). */
	readonly target: () => LanguageCode;
	/** Persist the storage location (null = default). */
	readonly saveDirectory: (directory: string | null) => Promise<void>;
	readonly uiLocale?: string;
	readonly freeBytes?: (dir: string) => Promise<number>;
	readonly folderSize?: (dir: string) => Promise<number>;
	/** Can the app create and write files here? Default: mkdir + probe file. */
	readonly writable?: (dir: string) => Promise<boolean>;
}

type CatalogueState = ModelsSnapshot["catalogue"];

export interface LanguagePlanItem {
	readonly id: string;
	readonly bytes: number;
	readonly state: ModelRowState;
}

export interface LanguagePlan {
	readonly status: "same" | "unavailable" | "ready" | "needs-download";
	readonly items: readonly LanguagePlanItem[];
}

export class ModelsSettings {
	readonly #o: ModelsSettingsOptions;
	readonly #sizes = new Map<string, number>();
	readonly #listeners = new Set<(snapshot: ModelsSnapshot) => void>();
	#catalogue: CatalogueState = "idle";
	#moving = false;
	#pending: ReturnType<typeof setTimeout> | null = null;

	constructor(options: ModelsSettingsOptions) {
		this.#o = options;
		options.manager.subscribe(() => this.#changed());
	}

	subscribe(listener: (snapshot: ModelsSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async snapshot(): Promise<ModelsSnapshot> {
		const { manager } = this.#o;
		const rows: ModelRow[] = [];
		for (const m of this.#o.manifest?.models ?? []) rows.push(await this.#manifestRow(m));
		rows.push(...(await this.#packRows()));
		let usedBytes = 0;
		for (const r of rows) if (r.state.status === "installed" && !r.state.bundled) usedBytes += r.bytes;
		let freeBytes: number | null = null;
		try {
			freeBytes = await (this.#o.freeBytes ?? volumeFreeBytes)(manager.root);
		} catch {
			freeBytes = null;
		}
		return {
			directory: manager.root,
			isDefaultDirectory: resolve(manager.root) === resolve(this.#o.defaultDirectory),
			usedBytes,
			freeBytes,
			rows,
			addable: this.#addable(),
			// The app loads the cached catalogue at startup (GLIM-101), so packs are usually listed at once.
			catalogue: this.#catalogue === "idle" && this.#o.packs.downloadable().length > 0 ? "ready" : this.#catalogue,
			moving: this.#moving,
		};
	}

	/** Fetch the pack catalogue (the user pressed "Find language packs"). */
	async loadCatalogue(): Promise<ModelsSnapshot> {
		this.#catalogue = "loading";
		this.#changed();
		try {
			const c = await this.#o.loadCatalogue();
			this.#o.packs.setCatalogue(c.packs);
			this.#catalogue = c.source === "network" ? "ready" : "cached";
		} catch {
			this.#catalogue = "offline";
		}
		return this.snapshot();
	}

	/** Download one manifest model (an OCR recogniser). */
	download(id: string): ActionResult {
		const model = this.#o.manifest?.models.find((m) => m.id === id);
		const pack = model ? undefined : this.#o.packs.catalogueEntry(id);
		if (!model && !pack) return { ok: false, message: "That model isn't available to download." };
		if (this.#moving) return { ok: false, message: "Wait until the models have moved." };
		void this.#o.manager.install(model ? manifestInstallable(model) : packInstallable(pack as BergamotPack));
		return { ok: true };
	}

	/**
	 * Download what translating `language` into the current target needs: the shortest route
	 * over installed + catalogue packs (pivoting through English), plus the runtime if missing.
	 */
	addLanguage(language: string): ActionResult {
		const from = sourceLanguageFor(language);
		if (!from) return { ok: false, message: "Glimpse can't translate that language on this computer." };
		if (this.#moving) return { ok: false, message: "Wait until the models have moved." };
		const to = this.#o.target();
		const installed: LanguagePair[] = this.#o.packs.installed().map((p) => ({ source: p.source, target: p.target }));
		const catalogue = this.#catalogueEntries();
		const plan = planRouteWithDownloads(from, to, installed, catalogue);
		if (!plan) return { ok: false, message: `There's no language pack for ${this.#name(from)} yet.` };
		if (plan.route.kind === "identity") return { ok: false, message: `Results are already in ${this.#name(to)}.` };
		const runtime = this.#o.manifest?.models.find((m) => m.kind === "translation-runtime");
		if (runtime && this.#o.manager.state(runtime.id).status === "missing" && !this.#o.manager.modelDir(runtime.id)) {
			void this.#o.manager.install(manifestInstallable(runtime));
		}
		for (const hop of plan.downloads) {
			const entry = catalogue.find((p) => p.source === hop.source && p.target === hop.target);
			if (entry) void this.#o.manager.install(packInstallable(entry));
		}
		return { ok: true };
	}

	/**
	 * What reading `language` in the current target needs (onboarding's download step, GLIM-76):
	 * `same` (it is the target), `unavailable` (no pack route, or the catalogue isn't loaded),
	 * `ready`, or the downloads still missing (packs on the route, plus the translation engine)
	 * with their sizes and states.
	 */
	languagePlan(language: string): LanguagePlan {
		const from = sourceLanguageFor(language);
		if (!from) return { status: "unavailable", items: [] };
		const to = this.#o.target();
		const installed: LanguagePair[] = this.#o.packs.installed().map((p) => ({ source: p.source, target: p.target }));
		const catalogue = this.#catalogueEntries();
		const plan = planRouteWithDownloads(from, to, installed, catalogue);
		if (!plan) return { status: "unavailable", items: [] };
		if (plan.route.kind === "identity") return { status: "same", items: [] };
		const items: LanguagePlanItem[] = [];
		const runtime = this.#o.manifest?.models.find((m) => m.kind === "translation-runtime");
		if (runtime && !this.#o.manager.modelDir(runtime.id)) {
			const state = this.#o.manager.state(runtime.id);
			if (state.status !== "installed")
				items.push({ id: runtime.id, bytes: downloadSize(runtime), state: rowState(state) });
		}
		for (const hop of plan.downloads) {
			const entry = catalogue.find((p) => p.source === hop.source && p.target === hop.target);
			if (!entry) continue;
			const state = this.#o.manager.state(entry.id);
			if (state.status === "installed") continue;
			items.push({ id: entry.id, bytes: packDownloadSize(entry), state: rowState(state) });
		}
		return { status: items.length === 0 ? "ready" : "needs-download", items };
	}

	cancel(id: string): ActionResult {
		return this.#o.manager.cancel(id) ? { ok: true } : { ok: false, message: "Nothing is downloading." };
	}

	async remove(id: string): Promise<ActionResult> {
		const state = this.#o.manager.state(id);
		if (state.status === "installed" && state.bundled)
			return { ok: false, message: "Built-in models can't be removed." };
		if (this.#moving) return { ok: false, message: "Wait until the models have moved." };
		try {
			await this.#o.manager.remove(id);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: `Couldn't remove it: ${errorText(error)}` };
		}
	}

	/** Move downloaded models to `directory` and remember it (GLIM-96). */
	async moveTo(directory: string | null): Promise<ActionResult> {
		const { manager } = this.#o;
		const target = resolve(directory ?? this.#o.defaultDirectory);
		const from = resolve(manager.root);
		if (target === from) return { ok: true };
		if (this.#busyIds().length > 0) {
			return { ok: false, message: "A download is running. Wait for it to finish or cancel it, then move the models." };
		}
		if (target.startsWith(from + sep))
			return { ok: false, message: "Choose a folder outside the current models folder." };
		if (!(await (this.#o.writable ?? isWritable)(target))) {
			return { ok: false, message: "Glimpse can't write to that folder. Choose another one." };
		}
		this.#moving = true;
		this.#changed();
		try {
			await manager.relocate(target);
			await this.#o.saveDirectory(target === resolve(this.#o.defaultDirectory) ? null : target);
			this.#sizes.clear();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: `Couldn't move the models: ${errorText(error)}` };
		} finally {
			this.#moving = false;
			this.#changed();
		}
	}

	#busyIds(): string[] {
		const ids = [...(this.#o.manifest?.models.map((m) => m.id) ?? []), ...this.#knownPackIds()];
		return ids.filter((id) => isBusy(this.#o.manager.state(id)));
	}

	#knownPackIds(): string[] {
		const ids = new Set<string>(this.#o.packs.installed().map((p) => p.id));
		for (const p of this.#catalogueEntries()) ids.add(p.id);
		for (const id of this.#o.manager.installedIds()) if (id.startsWith("bergamot-")) ids.add(id);
		return [...ids].filter((id) => id !== "bergamot-runtime");
	}

	#catalogueEntries(): BergamotPack[] {
		return this.#o.packs
			.downloadable()
			.map((d) => this.#o.packs.catalogueEntry(d.id))
			.filter((p): p is BergamotPack => p !== undefined);
	}

	async #manifestRow(m: ModelEntry): Promise<ModelRow> {
		const state = this.#o.manager.state(m.id);
		const dir = this.#o.manager.modelDir(m.id);
		const kind = m.kind === "translation-runtime" ? "runtime" : m.kind === "translation-model" ? "model" : "ocr";
		const name =
			m.kind === "ocr-detector"
				? "Text finder"
				: m.kind === "translation-runtime"
					? "Translation engine"
					: m.kind === "translation-model"
						? SMALL100_RESOURCE_NAME
						: RECOGNISER_NAMES[m.recognizer ?? "latin"];
		const detail =
			m.kind === "ocr-detector"
				? "Finds lines of text in a region"
				: m.kind === "translation-runtime"
					? "Runs language packs on this computer"
					: m.kind === "translation-model"
						? SMALL100_DETAIL
						: undefined;
		const bytes = dir && state.status === "installed" ? await this.#size(dir) : downloadSize(m);
		return { id: m.id, kind, name, ...(detail ? { detail } : {}), bytes, state: rowState(state) };
	}

	async #packRows(): Promise<ModelRow[]> {
		const rows: ModelRow[] = [];
		const seen = new Set<string>();
		for (const p of this.#o.packs.installed()) {
			seen.add(p.id);
			const state = this.#o.manager.state(p.id);
			rows.push({
				id: p.id,
				kind: "pack",
				name: `${this.#name(p.source)} → ${this.#name(p.target)}`,
				bytes: await this.#size(p.dir),
				state: rowState(
					state.status === "missing" ? { status: "installed", version: p.version, bundled: false } : state,
				),
			});
		}
		// Packs being downloaded (or that failed) this session.
		for (const p of this.#catalogueEntries()) {
			if (seen.has(p.id)) continue;
			const state = this.#o.manager.state(p.id);
			if (state.status === "missing" || state.status === "installed") continue;
			rows.push({
				id: p.id,
				kind: "pack",
				name: `${this.#name(p.source)} → ${this.#name(p.target)}`,
				bytes: packDownloadSize(p),
				state: rowState(state),
			});
		}
		const collator = new Intl.Collator(this.#o.uiLocale ?? "en");
		return rows.sort((a, b) => collator.compare(a.name, b.name));
	}

	/** Source languages the catalogue can translate (directly or via English) that aren't the target. */
	#addable(): ModelsSnapshot["addable"] {
		const to = this.#o.target();
		const codes = new Map<string, LanguageCode>();
		for (const p of this.#catalogueEntries()) {
			for (const code of [p.source, p.target]) if (code !== to && !codes.has(code)) codes.set(code, code);
		}
		const collator = new Intl.Collator(this.#o.uiLocale ?? "en");
		return [...codes.values()]
			.map((code) => ({ code, name: this.#name(code), nativeName: nativeName(code, { style: "standard" }) }))
			.sort((a, b) => collator.compare(a.name, b.name));
	}

	#name(code: LanguageCode): string {
		return displayName(code, this.#o.uiLocale ?? "en", { style: "standard" });
	}

	async #size(dir: string): Promise<number> {
		const cached = this.#sizes.get(dir);
		if (cached !== undefined) return cached;
		const bytes = await (this.#o.folderSize ?? folderSize)(dir);
		this.#sizes.set(dir, bytes);
		return bytes;
	}

	/** Coalesce bursts of progress events into at most one push per 150 ms. */
	#changed(): void {
		if (this.#pending || this.#listeners.size === 0) return;
		this.#pending = setTimeout(async () => {
			this.#pending = null;
			this.#sizes.clear();
			const snap = await this.snapshot();
			for (const l of [...this.#listeners]) l(snap);
		}, 150);
	}
}

function rowState(state: InstallState): ModelRowState {
	switch (state.status) {
		case "installed":
			return { status: "installed", bundled: state.bundled };
		case "missing":
			return { status: "missing" };
		case "queued":
			return { status: "queued" };
		case "downloading":
			return { status: "downloading", done: state.receivedBytes, total: state.totalBytes };
		case "verifying":
		case "installing":
			return { status: "verifying" };
		case "failed":
			return { status: "failed", error: state.error.kind, message: failureText(state.error.kind) };
	}
}

function failureText(kind: string): string {
	switch (kind) {
		case "network":
			return "Couldn't connect. Check your connection and try again.";
		case "disk-full":
			return "Not enough free space in the models folder.";
		case "checksum":
			return "The download was damaged. Try again.";
		case "http":
			return "The download server didn't answer. Try again later.";
		default:
			return "The download failed. Try again.";
	}
}

/** Total size of the files under `dir`, in bytes. Missing folders count as 0. */
export async function folderSize(dir: string): Promise<number> {
	let total = 0;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const path = join(dir, e.name);
		if (e.isDirectory()) total += await folderSize(path);
		else if (e.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
	}
	return total;
}

async function isWritable(dir: string): Promise<boolean> {
	const { mkdir, rm, writeFile } = await import("node:fs/promises");
	const probe = join(dir, `.glimpse-write-test-${process.pid}`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(probe, "");
		await rm(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
