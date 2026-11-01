// GLIM-43: the provider registry and the provider part of the settings schema.
//
// Implementations register a factory: static info + capabilities (so Settings can list
// providers without loading models), an options schema with defaults, and `create`.
// Config chooses one OCR provider and an ordered translation chain (first provider that
// can serve a pair wins, see `routeTranslation`), and keeps each provider's options.
//
// Privacy rules enforced here (GLIM-22, PRODUCT.md "private by default"):
// - Cloud providers are never part of the default selection (`defaultRank: null`).
// - A cloud provider can't follow a local one in the translation chain: that would be a
//   silent fall-through to the cloud when a local pack is missing.

import {
	array,
	childPath,
	type Issue,
	type JsonObject,
	jsonObject,
	nullable,
	object,
	parseOrDefault,
	record,
	type Schema,
	string,
	withDefault,
} from "../schema/index.ts";
import type { OcrCapabilities, OcrProvider } from "./ocr.ts";
import { isProviderId, type ProviderId, type ProviderInfo, type ProviderTask } from "./provenance.ts";
import type { TranslationCapabilities, TranslationProvider } from "./translation.ts";

/** Ids of the providers Glimpse plans to ship (GLIM-85, GLIM-22). Implementations use these. */
export const PROVIDER_IDS = {
	paddleocr: "paddleocr",
	bergamot: "bergamot",
	small100: "small100",
	hymt2: "hymt2",
	nllb: "nllb",
	googleVision: "cloud:google-vision",
	googleTranslate: "cloud:google-translate-v2",
} as const;

interface FactoryBase<Ctx, O> {
	/** Order in the default selection: lower first. `null` = opt-in only (all cloud providers). */
	readonly defaultRank: number | null;
	/** Options schema. Must produce a value from `{}` (every field defaulted). */
	readonly options: Schema<O>;
	// Method syntax on purpose: parameters are then checked bivariantly, so a factory with
	// specific options is assignable to `AnyProviderFactory<Ctx>`.
	create(options: O, ctx: Ctx): unknown;
}

export interface OcrProviderFactory<Ctx, O = JsonObject> extends FactoryBase<Ctx, O> {
	readonly info: ProviderInfo & { readonly task: "ocr" };
	readonly capabilities: OcrCapabilities;
	create(options: O, ctx: Ctx): OcrProvider;
}

export interface TranslationProviderFactory<Ctx, O = JsonObject> extends FactoryBase<Ctx, O> {
	readonly info: ProviderInfo & { readonly task: "translation" };
	readonly capabilities: TranslationCapabilities;
	create(options: O, ctx: Ctx): TranslationProvider;
}

// biome-ignore lint/suspicious/noExplicitAny: option types are erased in the registry; each factory validates its own.
export type AnyProviderFactory<Ctx> = OcrProviderFactory<Ctx, any> | TranslationProviderFactory<Ctx, any>;

/** The provider section of settings. Plain JSON. */
export interface ProvidersConfig {
	/** Selected OCR provider; null when none is installed (dev builds, tests). */
	readonly ocr: ProviderId | null;
	/** Translation providers in priority order. */
	readonly translation: readonly ProviderId[];
	/** Options per provider id, kept when a provider is deselected so switching back restores them. */
	readonly options: Readonly<Record<ProviderId, JsonObject>>;
}

/** What Settings shows for each provider (plain data for RPC). */
export interface ProviderDescriptor {
	readonly info: ProviderInfo;
	readonly capabilities: OcrCapabilities | TranslationCapabilities;
	readonly isDefault: boolean;
}

export interface ResolvedProvider<F> {
	readonly factory: F;
	readonly options: unknown;
}

export interface ResolvedSelection<Ctx> {
	readonly ocr: ResolvedProvider<OcrProviderFactory<Ctx, unknown>> | null;
	readonly translation: readonly ResolvedProvider<TranslationProviderFactory<Ctx, unknown>>[];
	/** Why the effective selection differs from the config (unknown ids, bad options). */
	readonly issues: readonly Issue[];
}

const providerIdSchema = (): Schema<ProviderId> => string({ maxLength: 64, pattern: /^[a-z0-9][a-z0-9:-]*$/ });

export class ProviderRegistry<Ctx> {
	readonly #factories = new Map<ProviderId, AnyProviderFactory<Ctx>>();

	register(factory: AnyProviderFactory<Ctx>): this {
		const { info, capabilities } = factory;
		if (!isProviderId(info.id)) throw new RangeError(`invalid provider id ${JSON.stringify(info.id)}`);
		if (this.#factories.has(info.id)) throw new Error(`provider ${info.id} is already registered`);
		if (info.kind !== capabilities.kind) throw new Error(`${info.id}: info.kind and capabilities.kind differ`);
		if (info.kind === "cloud" && factory.defaultRank !== null) {
			throw new Error(`${info.id}: cloud providers can't be selected by default`);
		}
		parseOrDefault(factory.options, {}); // throws if the options schema has no defaults
		this.#factories.set(info.id, factory);
		return this;
	}

	has(id: ProviderId): boolean {
		return this.#factories.has(id);
	}

	get(id: ProviderId): AnyProviderFactory<Ctx> | undefined {
		return this.#factories.get(id);
	}

	/** Factories for a task: defaults first by rank, then the rest by name. */
	list(task?: ProviderTask): AnyProviderFactory<Ctx>[] {
		return [...this.#factories.values()]
			.filter((f) => task === undefined || f.info.task === task)
			.sort(
				(a, b) =>
					(a.defaultRank ?? Number.POSITIVE_INFINITY) - (b.defaultRank ?? Number.POSITIVE_INFINITY) ||
					a.info.name.localeCompare(b.info.name),
			);
	}

	descriptors(task?: ProviderTask): ProviderDescriptor[] {
		const defaults = this.defaultConfig();
		return this.list(task).map((f) => ({
			info: f.info,
			capabilities: f.capabilities,
			isDefault: f.info.id === defaults.ocr || defaults.translation.includes(f.info.id),
		}));
	}

	#ofTask(task: ProviderTask): AnyProviderFactory<Ctx>[] {
		return this.list(task);
	}

	/** Default selection: the best-ranked local OCR provider and every ranked local translator. */
	defaultConfig(): ProvidersConfig {
		const ranked = (task: ProviderTask) => this.#ofTask(task).filter((f) => f.defaultRank !== null);
		return {
			ocr: ranked("ocr")[0]?.info.id ?? null,
			translation: ranked("translation").map((f) => f.info.id),
			options: {},
		};
	}

	/**
	 * Schema for `ProvidersConfig` in settings. Lenient: bad entries are dropped or reset
	 * with an issue. Ids that are well-formed but not registered are **kept**, so a build
	 * without a provider doesn't erase the user's choice; `resolve` skips them at runtime.
	 */
	configSchema(): Schema<ProvidersConfig> {
		const defaults = () => this.defaultConfig();
		const known = (id: ProviderId) => this.#factories.get(id);
		const base = object({
			ocr: withDefault(nullable(providerIdSchema()), () => defaults().ocr),
			translation: withDefault(
				array(providerIdSchema(), { maxLength: 16, uniqueBy: (id) => id }),
				() => defaults().translation,
			),
			options: withDefault(record(jsonObject()), {}),
		});
		return {
			parse: (input, ctx) => {
				const r = base.parse(input, ctx);
				if (!r.ok) return r;
				let { ocr, translation } = r.value;
				const issue = (key: string, message: string) => ctx.issues.push({ path: childPath(ctx.path, key), message });

				if (ocr !== null && known(ocr) && known(ocr)?.info.task !== "ocr") {
					issue("ocr", `${ocr} is not an OCR provider; using the default`);
					ocr = defaults().ocr;
				}
				const chain: ProviderId[] = [];
				let sawLocal = false;
				for (const id of translation) {
					const f = known(id);
					if (f && f.info.task !== "translation") {
						issue("translation", `${id} is not a translation provider; removed`);
						continue;
					}
					if (f?.info.kind === "cloud" && sawLocal) {
						issue("translation", `${id} is a cloud provider after a local one (silent cloud fallback); removed`);
						continue;
					}
					if (f?.info.kind === "local") sawLocal = true;
					chain.push(id);
				}
				translation = chain.length > 0 ? chain : defaults().translation;

				const options: Record<ProviderId, JsonObject> = {};
				for (const [id, raw] of Object.entries(r.value.options)) {
					const f = known(id);
					if (!f) {
						options[id] = raw; // unknown provider: keep verbatim
						continue;
					}
					const parsed = f.options.parse(raw, {
						path: childPath(childPath(ctx.path, "options"), id),
						issues: ctx.issues,
					});
					if (parsed.ok) options[id] = parsed.value as JsonObject;
					else issue(`options.${id}`, `${parsed.message}; using the defaults`);
				}
				return { ok: true, value: { ocr, translation, options } };
			},
		};
	}

	/** The effective selection: unknown ids replaced or skipped, options parsed with defaults. */
	resolve(config: ProvidersConfig): ResolvedSelection<Ctx> {
		const issues: Issue[] = [];
		const optionsFor = (factory: AnyProviderFactory<Ctx>) => {
			const id = factory.info.id;
			const { value, issues: found } = parseOrDefault(factory.options, config.options[id] ?? {});
			for (const i of found) issues.push({ path: childPath(`options.${id}`, i.path), message: i.message });
			return value;
		};

		let ocrFactory: AnyProviderFactory<Ctx> | undefined;
		if (config.ocr !== null) {
			ocrFactory = this.#factories.get(config.ocr);
			if (ocrFactory?.info.task !== "ocr") {
				issues.push({ path: "ocr", message: `${config.ocr} is not installed; using the default` });
				ocrFactory = undefined;
			}
		}
		if (!ocrFactory) {
			const fallback = this.defaultConfig().ocr;
			ocrFactory = fallback === null ? undefined : this.#factories.get(fallback);
		}

		const translation: ResolvedProvider<TranslationProviderFactory<Ctx, unknown>>[] = [];
		for (const id of config.translation) {
			const f = this.#factories.get(id);
			if (f?.info.task !== "translation") {
				issues.push({ path: "translation", message: `${id} is not installed; skipped` });
				continue;
			}
			translation.push({ factory: f as TranslationProviderFactory<Ctx, unknown>, options: optionsFor(f) });
		}
		if (translation.length === 0) {
			for (const id of this.defaultConfig().translation) {
				const f = this.#factories.get(id) as TranslationProviderFactory<Ctx, unknown>;
				translation.push({ factory: f, options: optionsFor(f) });
			}
		}

		return {
			ocr:
				ocrFactory?.info.task === "ocr"
					? { factory: ocrFactory as OcrProviderFactory<Ctx, unknown>, options: optionsFor(ocrFactory) }
					: null,
			translation,
			issues,
		};
	}

	/** Build the providers for a config (not initialised; call `init()`). */
	create(
		config: ProvidersConfig,
		ctx: Ctx,
	): {
		ocr: OcrProvider | null;
		translation: TranslationProvider[];
		issues: readonly Issue[];
	} {
		const selection = this.resolve(config);
		return {
			ocr: selection.ocr ? selection.ocr.factory.create(selection.ocr.options, ctx) : null,
			translation: selection.translation.map((t) => t.factory.create(t.options, ctx)),
			issues: selection.issues,
		};
	}
}
