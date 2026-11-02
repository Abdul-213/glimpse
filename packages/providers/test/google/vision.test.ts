import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type CloudUsageGate,
	fromGoogle,
	isProviderError,
	languageCode,
	type OcrImage,
	ProviderRegistry,
	spendCapError,
} from "@glimpse/core";
import { type ContractCheck, MemorySecretStore, ocrProviderContract } from "@glimpse/core/testing";
import { GOOGLE_SECRET_ID, GoogleError } from "../../src/google/common.ts";
import { FakeFetch } from "../../src/google/fake-fetch.ts";
import { googleVisionFactory } from "../../src/ocr/google-vision/factory.ts";
import { parseVisionResponse, polyBounds } from "../../src/ocr/google-vision/parse.ts";
import { encodePng } from "../../src/ocr/google-vision/png.ts";
import {
	GoogleVisionProvider,
	VISION_ENDPOINT,
	visionFeatureFor,
	visionHints,
} from "../../src/ocr/google-vision/provider.ts";
import { decodePng, loadPng } from "../helpers/png.ts";
import { errorReply, fixtureJson, TEST_KEY } from "./helpers.ts";

const OCR_FIXTURES = join(import.meta.dir, "..", "fixtures", "ocr");
const imageEn = await loadPng(join(OCR_FIXTURES, "region-en.png"));
const imageJa = await loadPng(join(OCR_FIXTURES, "region-ja.png"));

const documentEn = fixtureJson("vision-document-en.json");
const textJa = fixtureJson("vision-text-ja.json");

function setup(reply: Parameters<FakeFetch["on"]>[2] = { json: documentEn }, key: string | null = TEST_KEY) {
	const fake = new FakeFetch().on("POST", VISION_ENDPOINT, reply);
	const secrets = new MemorySecretStore(key ? { [GOOGLE_SECRET_ID]: key } : {});
	const make = (options = {}) => new GoogleVisionProvider(options, { google: { secrets, fetch: fake.fetch } });
	return { fake, secrets, make };
}

describe("Google Vision: core OCR provider contract (recorded replies)", () => {
	const { make } = setup();
	const checks: ContractCheck[] = ocrProviderContract(() => make(), {
		image: imageEn,
		expectText: "Settings saved",
		language: languageCode("en"),
	});
	for (const c of checks) test(c.name, c.run);
});

describe("Google Vision: request", () => {
	test("one PNG of the region, DOCUMENT_TEXT_DETECTION, key only in the header", async () => {
		const { fake, make } = setup();
		const p = make();
		await p.init();
		await p.recognise({ image: imageEn });
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call?.url).toBe(VISION_ENDPOINT);
		expect(call?.headers["x-goog-api-key"]).toBe(TEST_KEY);
		const body = call?.body as {
			requests: { image: { content: string }; features: { type: string }[]; imageContext?: unknown }[];
		};
		expect(body.requests).toHaveLength(1);
		const req = body.requests[0];
		expect(req?.features).toEqual([{ type: "DOCUMENT_TEXT_DETECTION" }]);
		expect(req?.imageContext).toBeUndefined();
		// The upload is a plain PNG of exactly the region's pixels.
		const png = Buffer.from(req?.image.content ?? "", "base64");
		const decoded = decodePng(new Uint8Array(png));
		expect([decoded.width, decoded.height]).toEqual([imageEn.width, imageEn.height]);
		expect(png.includes(Buffer.from("tEXt"))).toBe(false);
		expect(png.includes(Buffer.from("eXIf"))).toBe(false);
		expect(JSON.stringify(body)).not.toContain(TEST_KEY);
	});

	test("a small source subset goes as languageHints with TEXT_DETECTION", async () => {
		const { fake, make } = setup({ json: textJa });
		const p = make();
		await p.init();
		await p.recognise({ image: imageJa, languages: [languageCode("ja"), languageCode("he")] });
		const req = (fake.calls[0]?.body as { requests: Record<string, unknown>[] } | undefined)?.requests[0];
		expect(req?.["features"]).toEqual([{ type: "TEXT_DETECTION" }]);
		expect(req?.["imageContext"]).toEqual({ languageHints: ["ja", "iw"] });
	});

	test("feature and hint rules", () => {
		expect(visionHints(undefined)).toEqual([]);
		expect(visionHints([])).toEqual([]);
		expect(visionHints(["zh-Hans", "zh-Hant"].map(languageCode))).toEqual(["zh-CN", "zh-TW"]);
		expect(visionHints(["en", "de", "fr", "es"].map(languageCode))).toEqual([]);
		expect(visionFeatureFor("auto", [])).toBe("DOCUMENT_TEXT_DETECTION");
		expect(visionFeatureFor("auto", ["ja"])).toBe("TEXT_DETECTION");
		expect(visionFeatureFor("document", ["ja"])).toBe("DOCUMENT_TEXT_DETECTION");
		expect(visionFeatureFor("text", [])).toBe("TEXT_DETECTION");
	});

	test("bgra and padded rows are re-encoded to the same RGB pixels", () => {
		const width = 3;
		const height = 2;
		const stride = 16;
		const data = new Uint8Array(stride * height);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) data.set([10 * x, 20 * y, 200, 255], y * stride + x * 4); // B, G, R, A
		const bgra: OcrImage = { width, height, stride, format: "bgra8", data };
		const decoded = decodePng(encodePng(bgra));
		expect(decoded.data[0]).toBe(200); // R
		expect(decoded.data[2]).toBe(0); // B of pixel (0,0)
		expect(decoded.data[(1 * width + 2) * 4 + 2]).toBe(20); // B of pixel (2,1)
		expect(decoded.data[(1 * width + 2) * 4 + 1]).toBe(20); // G of pixel (2,1)
	});
});

describe("Google Vision: response mapping", () => {
	test("DOCUMENT_TEXT_DETECTION: blocks with lines, confidences and language hints", async () => {
		const { make } = setup();
		const p = make();
		await p.init();
		const result = await p.recognise({ image: imageEn });
		expect(result.blocks.map((b) => b.text)).toEqual([
			"Settings saved successfully.\nDo you want to install the update now?\nYour session will expire in 5 minutes.\nClick Continue to keep working.",
			"Error 404: file not found",
		]);
		const [first, second] = result.blocks;
		expect(first?.lines).toHaveLength(4);
		expect(first?.lines?.[1]?.text).toBe("Do you want to install the update now?");
		expect(first?.confidence).toBe(0.98);
		expect(second?.confidence).toBe(0.96);
		expect(first?.languageHints).toEqual([{ lang: languageCode("en"), confidence: 1 }]);
		expect(first?.box.x).toBe(16);
		expect(result.provider).toMatchObject({ id: "cloud:google-vision", kind: "cloud", name: "Google Cloud Vision" });
	});

	test("TEXT_DETECTION: no confidences means 1, hints without confidence, separate button blocks", async () => {
		const { make } = setup({ json: textJa });
		const p = make();
		await p.init();
		const result = await p.recognise({ image: imageJa });
		expect(result.blocks.map((b) => b.text)).toEqual([
			"設定を保存しました。\nこのアイテムを使用しますか？\n明日の会議は午後三時に始まります。\nダウンロードが完了しました",
			"キャンセル",
			"次へ",
		]);
		for (const b of result.blocks) {
			expect(b.confidence).toBe(1);
			expect(b.languageHints?.[0]?.lang).toBe(languageCode("ja"));
		}
	});

	test("paragraph units", () => {
		const blocks = parseVisionResponse((documentEn as { responses: unknown[] }).responses[0], {
			width: 600,
			height: 200,
			unit: "paragraph",
			fromGoogle,
		});
		expect(blocks).toHaveLength(2);
	});

	test("an empty reply is no blocks", async () => {
		const { make } = setup({ json: fixtureJson("vision-empty.json") });
		const p = make();
		await p.init();
		expect((await p.recognise({ image: imageEn })).blocks).toEqual([]);
	});

	test("polygons: missing zero coordinates, normalised vertices, clamping", () => {
		expect(polyBounds({ vertices: [{}, { x: 10 }, { x: 10, y: 5 }, { y: 5 }] }, 100, 100)).toEqual({
			x: 0,
			y: 0,
			width: 10,
			height: 5,
		});
		expect(
			polyBounds(
				{
					normalizedVertices: [
						{ x: 0.5, y: 0.5 },
						{ x: 1, y: 1 },
					],
				},
				200,
				100,
			),
		).toEqual({
			x: 100,
			y: 50,
			width: 100,
			height: 50,
		});
		expect(
			polyBounds(
				{
					vertices: [
						{ x: -4, y: -2 },
						{ x: 900, y: 300 },
					],
				},
				600,
				200,
			),
		).toEqual({
			x: 0,
			y: 0,
			width: 600,
			height: 200,
		});
	});

	test("hyphenated line ends keep the hyphen and break the line", () => {
		const sym = (text: string, brk?: string) => ({
			text,
			...(brk ? { property: { detectedBreak: { type: brk } } } : {}),
		});
		const word = (symbols: unknown[], x: number) => ({
			boundingBox: {
				vertices: [
					{ x, y: 0 },
					{ x: x + 10, y: 10 },
				],
			},
			symbols,
		});
		const response = {
			fullTextAnnotation: {
				pages: [
					{
						blocks: [
							{
								blockType: "TEXT",
								paragraphs: [
									{
										words: [
											word([sym("con"), sym("t", "HYPHEN")], 0),
											word([sym("inue", "SPACE")], 0),
											word([sym("now", "LINE_BREAK")], 20),
										],
									},
								],
							},
							{ blockType: "PICTURE", paragraphs: [] },
						],
					},
				],
			},
		};
		const [b] = parseVisionResponse(response, { width: 100, height: 100, unit: "block", fromGoogle });
		expect(b?.text).toBe("cont-\ninue now");
		expect(b?.lines).toHaveLength(2);
	});
});

describe("Google Vision: keys and errors", () => {
	test("no key: init ends in needs-key and recognise rejects needs-key without calling Google", async () => {
		const { fake, make } = setup(undefined, null);
		const p = make();
		expect((await p.init()).state).toBe("needs-key");
		const error = await p.recognise({ image: imageEn }).catch((e: unknown) => e);
		expect(isProviderError(error, "needs-key")).toBe(true);
		expect(fake.calls).toHaveLength(0);
	});

	test("adding a key later: init again reaches ready", async () => {
		const { make, secrets } = setup(undefined, null);
		const p = make();
		expect((await p.init()).state).toBe("needs-key");
		await secrets.set(GOOGLE_SECRET_ID, TEST_KEY);
		expect((await p.init()).state).toBe("ready");
	});

	test("key removed while ready: the request fails needs-key and the status follows", async () => {
		const { fake, make, secrets } = setup();
		const p = make();
		await p.init();
		await secrets.delete(GOOGLE_SECRET_ID);
		const error = await p.recognise({ image: imageEn }).catch((e: unknown) => e);
		expect(isProviderError(error, "needs-key")).toBe(true);
		expect(p.status.state).toBe("needs-key");
		expect(fake.calls).toHaveLength(0);
	});

	test("a keychain that can't be read: init reports an error", async () => {
		const { make, secrets } = setup();
		secrets.failWith = "unavailable";
		const status = await make().init();
		expect(status.state).toBe("error");
	});

	test("API not enabled -> invalid-key with fix-it copy naming Cloud Vision", async () => {
		const { make } = setup(errorReply("service-disabled"));
		const p = make();
		await p.init();
		const error = (await p.recognise({ image: imageEn }).catch((e: unknown) => e)) as GoogleError;
		expect(error).toBeInstanceOf(GoogleError);
		expect(error.code).toBe("invalid-key");
		expect(error.problem).toBe("api-disabled");
		expect(error.userMessage).toContain("Cloud Vision API");
	});

	test("billing off -> invalid-key (billing-disabled)", async () => {
		const { make } = setup(errorReply("billing-disabled"));
		const p = make();
		await p.init();
		const error = (await p.recognise({ image: imageEn }).catch((e: unknown) => e)) as GoogleError;
		expect([error.code, error.problem]).toEqual(["invalid-key", "billing-disabled"]);
	});

	test("rate limit and daily quota", async () => {
		for (const [name, code] of [
			["rate-limited", "rate-limited"],
			["quota-daily", "quota-exceeded"],
		] as const) {
			const { make } = setup(errorReply(name));
			const p = make();
			await p.init();
			expect(isProviderError(await p.recognise({ image: imageEn }).catch((e: unknown) => e), code)).toBe(true);
		}
	});

	test("a per-image error (HTTP 200) -> invalid-request", async () => {
		const { make } = setup({ json: fixtureJson("vision-bad-image.json") });
		const p = make();
		await p.init();
		const error = await p.recognise({ image: imageEn }).catch((e: unknown) => e);
		expect(isProviderError(error, "invalid-request")).toBe(true);
	});

	test("offline", async () => {
		const { make } = setup({ network: "offline" });
		const p = make();
		await p.init();
		expect(isProviderError(await p.recognise({ image: imageEn }).catch((e: unknown) => e), "offline")).toBe(true);
	});

	test("cancelling mid-request rejects cancelled", async () => {
		const { make } = setup({ hang: true });
		const p = make();
		await p.init();
		const controller = new AbortController();
		const pending = p.recognise({ image: imageEn }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 5);
		expect(isProviderError(await pending.catch((e: unknown) => e), "cancelled")).toBe(true);
	});
});

describe("Google Vision: registry", () => {
	test("registers as an opt-in cloud OCR provider, never in the defaults", () => {
		const registry = new ProviderRegistry<{ google: { secrets: MemorySecretStore } }>();
		registry.register(googleVisionFactory());
		const [d] = registry.descriptors("ocr");
		expect(d?.info).toMatchObject({ id: "cloud:google-vision", kind: "cloud", vendor: "Google" });
		expect(d?.capabilities).toMatchObject({ secretId: GOOGLE_SECRET_ID, needsNetwork: true });
		expect(d?.isDefault).toBe(false);
		expect(registry.defaultConfig().ocr).toBeNull();
	});
});

describe("Google Vision: the spend guard (GLIM-120)", () => {
	function guarded(reply: Parameters<FakeFetch["on"]>[2] = { json: documentEn }, paused = false) {
		const fake = new FakeFetch().on("POST", VISION_ENDPOINT, reply);
		const secrets = new MemorySecretStore({ [GOOGLE_SECRET_ID]: TEST_KEY });
		const recorded: [string, number][] = [];
		const usage: CloudUsageGate = {
			admit: (id) => {
				if (paused) throw spendCapError(id);
			},
			record: (id, units) => recorded.push([id, units]),
		};
		const p = new GoogleVisionProvider({}, { google: { secrets, fetch: fake.fetch, usage } });
		return { fake, p, recorded };
	}

	test("one answered request counts one image", async () => {
		const { p, recorded } = guarded();
		await p.init();
		await p.recognise({ image: imageEn });
		expect(recorded).toEqual([["cloud:google-vision", 1]]);
	});

	test("paused: rejects spend-cap without sending the image", async () => {
		const { fake, p, recorded } = guarded(undefined, true);
		await p.init();
		const error = await p.recognise({ image: imageEn }).catch((e: unknown) => e);
		expect(isProviderError(error, "spend-cap")).toBe(true);
		expect(fake.calls).toHaveLength(0);
		expect(recorded).toEqual([]);
	});

	test("a request Google refused isn't counted", async () => {
		const { p, recorded } = guarded(errorReply("quota-daily"));
		await p.init();
		await p.recognise({ image: imageEn }).catch(() => undefined);
		expect(recorded).toEqual([]);
	});
});
