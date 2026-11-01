// The Bergamot (Firefox Translations) runtime: Firefox's own bergamot-translator.wasm plus
// its matching emscripten JS glue (MPL-2.0), running Marian int8 models with the WASM's
// built-in fallback gemm (there is no `WebAssembly.mozIntGemm` outside Firefox). Runs inside
// the inference Worker only (worker.ts); the call is synchronous and ~50 ms per sentence.
// Adapted from spikes/inference/src/bergamot.ts (GLIM-17).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";

/** Byte alignment Bergamot requires for each file role (same as Firefox). */
export const ALIGNMENT: Readonly<Record<string, number>> = {
	model: 256,
	lex: 64,
	vocab: 64,
	srcvocab: 64,
	trgvocab: 64,
};

/**
 * Marian options as Firefox passes them: greedy, int8 shifted gemm, 128-token sentence
 * breaks. Part of the provider's options hash (`MODEL_CONFIG_VERSION`), so changing it
 * invalidates cached translations.
 */
export const MODEL_CONFIG = `
beam-size: 1
normalize: 1.0
word-penalty: 0
max-length-break: 128
mini-batch-words: 1024
workspace: 128
max-length-factor: 2.0
skip-cost: true
cpu-threads: 0
quiet: true
quiet-translation: true
gemm-precision: int8shiftAlphaAll
alignment: soft
`;
export const MODEL_CONFIG_VERSION = "firefox-2026-11";

// Minimal shapes of the embind objects we touch. The glue is untyped emscripten output.
interface Deletable {
	delete(): void;
}
interface AlignedMemory extends Deletable {
	getByteArrayView(): Uint8Array;
}
interface Vec<T> extends Deletable {
	push_back(v: T): void;
	size(): number;
	get(i: number): T;
}
interface Response extends Deletable {
	getTranslatedText(): string;
}
export interface TranslationModel extends Deletable {
	readonly __brand?: "model";
}
interface BlockingService extends Deletable {
	translate(m: TranslationModel, t: Vec<string>, o: Vec<ResponseOptions>): Vec<Response>;
	translateViaPivoting(
		a: TranslationModel,
		b: TranslationModel,
		t: Vec<string>,
		o: Vec<ResponseOptions>,
	): Vec<Response>;
}
interface ResponseOptions {
	qualityScores: boolean;
	alignment: boolean;
	html: boolean;
}
export interface BergamotModule {
	AlignedMemory: new (size: number, align: number) => AlignedMemory;
	AlignedMemoryList: new () => Vec<AlignedMemory>;
	VectorString: new () => Vec<string>;
	VectorResponseOptions: new () => Vec<ResponseOptions>;
	TranslationModel: new (
		from: string,
		to: string,
		cfg: string,
		model: AlignedMemory,
		lex: AlignedMemory,
		vocabs: Vec<AlignedMemory>,
		qe: null,
	) => TranslationModel;
	BlockingService: new (o: { cacheSize: number }) => BlockingService;
	HEAP8?: Int8Array;
}

/** `pack.json` as the model manager writes it (core `packDescriptor`). */
export interface PackDescriptor {
	readonly src: string;
	readonly tgt: string;
	readonly version: string;
	readonly architecture?: string;
	readonly files: Readonly<Record<string, string>>;
}

export const RUNTIME_FILES = { wasm: "bergamot-translator.wasm", glue: "bergamot-translator.js" } as const;

/** Initial WASM memory, as Firefox sets it (~223 MB; it grows with loaded packs). */
const INITIAL_MEMORY = 234_291_200;

/** Instantiate the WASM from a runtime folder. The glue chooses its gemm path and logs it. */
export async function loadRuntime(dir: string): Promise<BergamotModule> {
	const glue = readFileSync(join(dir, RUNTIME_FILES.glue), "utf8");
	const loadBergamot = runInThisContext(`(function(){\n${glue}\nreturn loadBergamot;})()`, {
		filename: RUNTIME_FILES.glue,
	}) as (m: object) => void;
	const wasmBinary = readFileSync(join(dir, RUNTIME_FILES.wasm));
	// The glue prints its gemm choice with console.log; keep it out of the app's log.
	const log = console.log;
	console.log = () => undefined;
	try {
		return await new Promise<BergamotModule>((resolve, reject) => {
			const m: Record<string, unknown> = {
				INITIAL_MEMORY,
				wasmBinary,
				print: () => undefined,
				printErr: () => undefined,
				onAbort: (reason: unknown) => reject(new Error(`bergamot aborted: ${String(reason)}`)),
				onRuntimeInitialized: () => resolve(m as unknown as BergamotModule),
			};
			loadBergamot(m);
		});
	} finally {
		console.log = log;
	}
}

function aligned(mod: BergamotModule, role: string, path: string): AlignedMemory {
	const bytes = readFileSync(path);
	const mem = new mod.AlignedMemory(bytes.byteLength, ALIGNMENT[role] ?? 64);
	mem.getByteArrayView().set(bytes);
	return mem;
}

export function readPackDescriptor(packDir: string): PackDescriptor {
	const json = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as Partial<PackDescriptor>;
	if (typeof json.src !== "string" || typeof json.tgt !== "string" || typeof json.files !== "object" || !json.files) {
		throw new Error(`${packDir}/pack.json is not a Bergamot pack descriptor`);
	}
	return json as PackDescriptor;
}

/** Load one pack's model, lexical shortlist and vocabularies into the runtime. */
export function loadPack(mod: BergamotModule, packDir: string): TranslationModel {
	const pack = readPackDescriptor(packDir);
	const file = (role: string): string => {
		const name = pack.files[role];
		if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
			throw new Error(`pack ${packDir} has no usable ${role} file`);
		}
		return join(packDir, name);
	};
	const vocabs = new mod.AlignedMemoryList();
	if (pack.files["vocab"]) vocabs.push_back(aligned(mod, "vocab", file("vocab")));
	else {
		vocabs.push_back(aligned(mod, "srcvocab", file("srcvocab")));
		vocabs.push_back(aligned(mod, "trgvocab", file("trgvocab")));
	}
	return new mod.TranslationModel(
		pack.src,
		pack.tgt,
		MODEL_CONFIG,
		aligned(mod, "model", file("model")),
		aligned(mod, "lex", file("lex")),
		vocabs,
		null,
	);
}

export class Translator {
	readonly #mod: BergamotModule;
	readonly #service: BlockingService;

	constructor(mod: BergamotModule) {
		this.#mod = mod;
		// Bergamot's own cache is off: Glimpse caches per sentence and hop (GLIM-20).
		this.#service = new mod.BlockingService({ cacheSize: 0 });
	}

	/** Translate with one model, or two (pivot through English) when `second` is given. */
	translate(texts: readonly string[], first: TranslationModel, second?: TranslationModel): string[] {
		const v = new this.#mod.VectorString();
		const o = new this.#mod.VectorResponseOptions();
		let r: Vec<Response> | null = null;
		try {
			for (const t of texts) {
				v.push_back(t);
				o.push_back({ qualityScores: false, alignment: false, html: false });
			}
			r = second ? this.#service.translateViaPivoting(first, second, v, o) : this.#service.translate(first, v, o);
			const out: string[] = [];
			for (let i = 0; i < texts.length; i++) out.push(r.get(i).getTranslatedText());
			return out;
		} finally {
			v.delete();
			o.delete();
			r?.delete();
		}
	}

	dispose(): void {
		this.#service.delete();
	}
}
