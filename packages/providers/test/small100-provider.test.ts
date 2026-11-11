// SMaLL-100 provider, engine and decode loop without onnxruntime or the model (GLIM-100):
// contract checks over the fake Worker, missing-model reporting, lazy loading, streaming,
// idle shutdown, cancellation, crashes, and the greedy loop over a scripted fake session.
// The real model: small100-real.test.ts (env-gated).
import { describe, expect, test } from "bun:test";
import {
	collectTranslations,
	isProviderError,
	languageCode,
	parseOrDefault,
	type TranslationEvent,
	type TranslationRequest,
} from "@glimpse/core";
import { translationProviderContract } from "@glimpse/core/testing";
import {
	argmaxLast,
	bannedNext,
	encoderIds,
	greedyDecode,
	greedyDecodeLong,
	MAX_SOURCE_TOKENS,
	maxNewTokens,
	type Seq2SeqSession,
	type Seq2SeqTensor,
	SMALL100_CAPABILITIES,
	SMALL100_CONFIG,
	SMALL100_MODEL_ID,
	type Small100ProviderOptions,
	Small100TranslationProvider,
	small100Code,
	small100Factory,
	small100OptionsSchema,
	staticSmall100Source,
	type TensorKit,
} from "../src/index.ts";
import { fakeSmall100Worker } from "../src/testing.ts";

const L = languageCode;
const MODEL = { dir: "/models/small100", revision: "small100-int8 2026-11-02" };

function make(
	over: Partial<Small100ProviderOptions> & { sentenceMs?: number; crashOn?: string; failInit?: string } = {},
) {
	const fake = fakeSmall100Worker({
		...(over.sentenceMs === undefined ? {} : { sentenceMs: over.sentenceMs }),
		...(over.crashOn === undefined ? {} : { crashOn: over.crashOn }),
		...(over.failInit === undefined ? {} : { failInit: over.failInit }),
	});
	const model = over.model ?? staticSmall100Source(MODEL);
	const provider = new Small100TranslationProvider({ spawn: fake.spawn, idleMs: 0, ...over, model });
	return { provider, fake };
}

const req = (to: string, ...segments: [string, string][]): TranslationRequest => ({
	to: L(to),
	segments: segments.map(([from, text], i) => ({ id: `s${i}`, text, from: L(from) })),
});

async function drain(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
	const out: TranslationEvent[] = [];
	for await (const e of iterable) out.push(e);
	return out;
}

describe("contract (fake worker)", () => {
	for (const c of translationProviderContract(() => make().provider, {
		pair: { from: L("sw"), to: L("en") },
		texts: ["Habari.", "Habari za asubuhi. Unaendeleaje?"],
		unsupportedPair: { from: L("en"), to: L("zh-Hant") },
	})) {
		test(c.name, c.run);
	}
});

describe("Small100TranslationProvider", () => {
	test("ready without loading anything; the Worker starts on the first request", async () => {
		const { provider, fake } = make();
		expect((await provider.init()).state).toBe("ready");
		await provider.warmup();
		expect(fake.log.spawned).toBe(0);
		const out = await collectTranslations(provider, req("en", ["sw", "Habari."]));
		expect(out.get("s0")).toMatchObject({ ok: true, translation: { text: "Habari. [sw>en]", via: [] } });
		expect(fake.log.spawned).toBe(1);
		expect(fake.log.inits).toEqual([MODEL.dir]);
		await provider.dispose();
	});

	test("warmOnStart loads the model in warmup()", async () => {
		const { provider, fake } = make({ warmOnStart: true });
		await provider.init();
		await provider.warmup();
		expect(fake.log.spawned).toBe(1);
		expect(fake.log.messages.map((m) => m.type)).toEqual(["init", "warmup"]);
		await provider.dispose();
	});

	test("not installed: pairs are missing with the download size, translate says model-missing, nothing spawns", async () => {
		const { provider, fake } = make({
			model: staticSmall100Source(null, { bytes: 610_519_252, revision: "r1" }),
		});
		await provider.init();
		const support = provider.pairSupport(L("sw"), L("en"));
		expect(support).toMatchObject({
			status: "missing",
			missing: [{ id: SMALL100_MODEL_ID, bytes: 610_519_252 }],
			hops: [{ from: "sw", to: "en", fingerprint: { providerId: "small100", modelRevision: "small100@r1" } }],
		});
		const events = await drain(provider.translate(req("en", ["sw", "Habari."])));
		expect(events).toMatchObject([{ type: "error", id: "s0", error: { code: "model-missing" } }]);
		expect(fake.log.spawned).toBe(0);
		await provider.dispose();
	});

	test("a model that lands later is picked up without re-init", async () => {
		let installed: typeof MODEL | null = null;
		const listeners: (() => void)[] = [];
		const { provider } = make({
			model: {
				installed: () => installed,
				download: { id: SMALL100_MODEL_ID, bytes: 1, revision: "r" },
				subscribe: (l) => {
					listeners.push(l);
					return () => {};
				},
			},
		});
		await provider.init();
		expect(provider.pairSupport(L("sw"), L("en")).status).toBe("missing");
		installed = MODEL;
		for (const l of listeners) l();
		expect(provider.pairSupport(L("sw"), L("en")).status).toBe("ready");
		await provider.dispose();
	});

	test("languages: M2M-100 codes; zh-Hant is a source but not a target; identity is unsupported", async () => {
		const { provider } = make();
		await provider.init();
		expect(small100Code(L("nb"), "source")).toBe("no");
		expect(small100Code(L("zh-Hant"), "source")).toBe("zh");
		expect(small100Code(L("zh-Hant"), "target")).toBeNull();
		expect(provider.pairSupport(L("zh-Hant"), L("en")).status).toBe("ready");
		expect(provider.pairSupport(L("en"), L("zh-Hant")).status).toBe("unsupported");
		expect(provider.pairSupport(L("en"), L("en")).status).toBe("unsupported");
		expect(provider.pairSupport(L("zh-Hans"), L("zh-Hant")).status).toBe("unsupported");
		expect(SMALL100_CAPABILITIES.languages.sources).toContain(L("sw"));
		expect(SMALL100_CAPABILITIES.longTail).toBe(true);
		await provider.dispose();
	});

	test("one hop, direct any-to-any; segments split into sentences stream partials, then done", async () => {
		const { provider } = make();
		await provider.init();
		expect(provider.pairSupport(L("sw"), L("ja"))).toMatchObject({ status: "ready", hops: [{ from: "sw", to: "ja" }] });
		const events = await drain(provider.translate(req("en", ["sw", "Habari za asubuhi. Unaendeleaje?"])));
		expect(events.map((e) => e.type)).toEqual(["partial", "done"]);
		const done = events.at(-1);
		expect(done?.type === "done" && done.translation.text).toBe("Habari za asubuhi. [sw>en] Unaendeleaje? [sw>en]");
		await provider.dispose();
	});

	test("one Worker call per source language; results keep their ids", async () => {
		const { provider, fake } = make();
		await provider.init();
		const out = await collectTranslations(
			provider,
			req("en", ["sw", "Habari."], ["am", "ሰላም።"], ["sw", "Asante."], ["ja", "  "]),
		);
		expect(out.get("s2")).toMatchObject({ ok: true, translation: { text: "Asante. [sw>en]" } });
		expect(out.get("s1")).toMatchObject({ ok: true, translation: { text: "ሰላም። [am>en]" } });
		expect(out.get("s3")).toMatchObject({ ok: true, translation: { text: "" } });
		const translates = fake.log.messages.filter((m) => m.type === "translate");
		expect(translates).toHaveLength(2);
		await provider.dispose();
	});

	test("the Worker exits when idle and comes back on the next request", async () => {
		const { provider, fake } = make({ idleMs: 20 });
		await provider.init();
		await collectTranslations(provider, req("en", ["sw", "Habari."]));
		expect(provider.engine?.running).toBe(true);
		await Bun.sleep(60);
		expect(provider.engine?.running).toBe(false);
		expect(fake.log.terminated).toBe(1);
		await collectTranslations(provider, req("en", ["sw", "Asante."]));
		expect(fake.log.spawned).toBe(2);
		await provider.dispose();
	});

	test("cancel: rejects cancelled promptly and tells the Worker to stop", async () => {
		const { provider, fake } = make({ sentenceMs: 30 });
		await provider.init();
		const controller = new AbortController();
		const segments = Array.from({ length: 10 }, (_, i) => ["sw", `Sentensi ${i}.`] as [string, string]);
		const run = drain(provider.translate(req("en", ...segments), { signal: controller.signal }));
		await Bun.sleep(45);
		controller.abort();
		const error = await run.then(
			() => null,
			(e: unknown) => e,
		);
		expect(isProviderError(error) && error.code).toBe("cancelled");
		expect(fake.log.messages.some((m) => m.type === "cancel")).toBe(true);
		// The provider still works afterwards.
		const out = await collectTranslations(provider, req("en", ["sw", "Habari."]));
		expect(out.get("s0")?.ok).toBe(true);
		await provider.dispose();
	});

	test("a Worker crash fails that request's segments and the next request respawns", async () => {
		const { provider, fake } = make({ crashOn: "BOOM" });
		await provider.init();
		const out = await collectTranslations(provider, req("en", ["sw", "Habari."], ["sw", "BOOM."]));
		expect(out.get("s1")).toMatchObject({ ok: false, error: { code: "internal" } });
		const again = await collectTranslations(provider, req("en", ["sw", "Asante."]));
		expect(again.get("s0")?.ok).toBe(true);
		expect(fake.log.spawned).toBe(2);
		await provider.dispose();
	});

	test("a model that won't load is an error per segment, not a throw", async () => {
		const { provider } = make({ failInit: "Load model failed: protobuf parsing failed" });
		await provider.init();
		const out = await collectTranslations(provider, req("en", ["sw", "Habari."]));
		expect(out.get("s0")).toMatchObject({ ok: false, error: { code: "internal" } });
		await provider.dispose();
	});

	test("factory: options default, second rank, long tail", () => {
		const factory = small100Factory();
		expect(factory.defaultRank).toBe(10);
		expect(parseOrDefault(small100OptionsSchema, {}).value).toEqual({
			threads: 4,
			idleSeconds: 120,
			warmOnStart: false,
		});
		expect(factory.capabilities.longTail).toBe(true);
	});
});

// ---- decode loop ----------------------------------------------------------------------

const kit: TensorKit = {
	int64: (values, dims) => ({ data: [...values], dims }),
	emptyKv: (heads, headDim) => ({ data: new Float32Array(0), dims: [1, heads, 0, headDim] }),
	bool: (value) => ({ data: [value], dims: [1] }),
};

/** A decoder that emits `script` one token per step, then </s>. */
function scripted(script: readonly number[], vocab = 16) {
	const feeds: Record<string, Seq2SeqTensor>[] = [];
	let step = 0;
	const encoder: Seq2SeqSession = {
		run: async (f) => {
			feeds.push(f);
			return { last_hidden_state: { data: new Float32Array(4), dims: [1, 1, 4] } };
		},
	};
	const decoder: Seq2SeqSession = {
		run: async (f) => {
			feeds.push(f);
			const logits = new Float32Array(vocab);
			logits[script[step] ?? SMALL100_CONFIG.eos] = 10;
			step++;
			const out: Record<string, Seq2SeqTensor> = { logits: { data: logits, dims: [1, 1, vocab] } };
			for (let l = 0; l < SMALL100_CONFIG.decoderLayers; l++) {
				for (const k of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
					out[`present.${l}.${k}`] = { data: new Float32Array(0), dims: [step, l] };
				}
			}
			return out;
		},
	};
	return { encoder, decoder, feeds };
}

describe("greedyDecode", () => {
	test("SMaLL-100 prompt: target token first on the encoder side, decoder starts at </s>", async () => {
		const { encoder, decoder, feeds } = scripted([7, 8, 9]);
		const r = await greedyDecode(encoder, decoder, kit, SMALL100_CONFIG, [5, 6], { src: 11, tgt: 12 });
		expect(r.ids).toEqual([7, 8, 9]);
		expect(r.truncated).toBe(false);
		expect(feeds[0]?.["input_ids"]?.data).toEqual([12, 5, 6, 2]);
		expect(feeds[1]?.["input_ids"]?.data).toEqual([2]);
		expect(feeds[1]?.["use_cache_branch"]?.data).toEqual([false]);
		expect(feeds[2]?.["input_ids"]?.data).toEqual([7]);
		expect(feeds[2]?.["use_cache_branch"]?.data).toEqual([true]);
		// Encoder keys / values from step 1 are fed back unchanged; decoder ones advance.
		expect(feeds[3]?.["past_key_values.0.encoder.key"]?.dims).toEqual([1, 0]);
		expect(feeds[3]?.["past_key_values.0.decoder.key"]?.dims).toEqual([2, 0]);
	});

	test("M2M-100 prompt: source token on the encoder, target forced after </s>", async () => {
		const { encoder, decoder, feeds } = scripted([7]);
		const config = { ...SMALL100_CONFIG, scheme: "m2m100" as const };
		await greedyDecode(encoder, decoder, kit, config, [5], { src: 11, tgt: 12 });
		expect(feeds[0]?.["input_ids"]?.data).toEqual([11, 5, 2]);
		expect(feeds[1]?.["input_ids"]?.data).toEqual([2, 12]);
	});

	test("stops at the length budget and checks cancellation between steps", async () => {
		const { encoder, decoder } = scripted(
			Array.from({ length: 100 }, (_, i) => 3 + (i % 9)),
			16,
		);
		const r = await greedyDecode(encoder, decoder, kit, { ...SMALL100_CONFIG, noRepeatNgram: 0 }, [5], {
			src: 11,
			tgt: 12,
		});
		expect(r.ids.length).toBe(maxNewTokens(1, SMALL100_CONFIG));
		expect(r.truncated).toBe(true);
		let n = 0;
		const cancelled = greedyDecode(
			encoder,
			decoder,
			kit,
			SMALL100_CONFIG,
			[5],
			{ src: 11, tgt: 12 },
			{
				cancelled: () => ++n > 2,
			},
		);
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
	});

	test("a source longer than the model's positions is decoded in slices, outputs joined", async () => {
		const { encoder, decoder, feeds } = scripted([7, 2, 8, 2, 9]);
		const body = Array.from({ length: MAX_SOURCE_TOKENS * 2 + 5 }, () => 5);
		const r = await greedyDecodeLong(encoder, decoder, kit, SMALL100_CONFIG, body, { src: 11, tgt: 12 });
		expect(r.ids).toEqual([7, 8, 9]);
		const encoderCalls = feeds.filter((f) => "attention_mask" in f);
		expect(encoderCalls.map((f) => f["input_ids"]?.dims[1])).toEqual([MAX_SOURCE_TOKENS + 2, MAX_SOURCE_TOKENS + 2, 7]);
	});

	test("helpers: prompt ids, n-gram ban, argmax skips <s> and banned ids", () => {
		expect(encoderIds([5], 11, 12, SMALL100_CONFIG)).toEqual([12, 5, 2]);
		expect([...bannedNext([1, 2, 3, 1, 2], 3)]).toEqual([3]);
		expect(bannedNext([1, 2], 3).size).toBe(0);
		const logits = { data: Float32Array.from([9, 1, 5, 4]), dims: [1, 1, 4] };
		expect(argmaxLast(logits, new Set())).toBe(2);
		expect(argmaxLast(logits, new Set([2]))).toBe(3);
		expect(maxNewTokens(200, SMALL100_CONFIG)).toBe(256);
		expect(maxNewTokens(1, SMALL100_CONFIG)).toBe(16);
	});
});
