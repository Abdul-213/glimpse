import { describe, expect, test } from "bun:test";
import { isProviderError, languageCode, type OcrProgress, rect, validateOcrImage } from "../../src/index.ts";
import {
	blankImage,
	type ContractCheck,
	FakeOcrProvider,
	ocrBlock,
	ocrProviderContract,
} from "../../src/testing/index.ts";

const runAll = (checks: ContractCheck[]) => {
	for (const c of checks) test(c.name, c.run);
};

const blocks = [ocrBlock("b1", "続ける", rect(10, 10, 60, 20)), ocrBlock("b2", "設定", rect(10, 50, 40, 20))];

describe("OCR contract: fake, progressive", () => {
	runAll(
		ocrProviderContract(() => new FakeOcrProvider({ blocks }), {
			image: blankImage(200, 100),
			expectText: "設定",
			language: languageCode("ja"),
		}),
	);
});

describe("OCR contract: fake cloud, not progressive, with a pixel limit", () => {
	runAll(
		ocrProviderContract(
			() =>
				new FakeOcrProvider({
					id: "cloud:fake-vision",
					kind: "cloud",
					blocks,
					capabilities: { progressive: false, maxImagePixels: 1_000_000 },
				}),
			{ image: blankImage(200, 100) },
		),
	);
});

describe("contract catches broken OCR providers", () => {
	test("boxes outside the image fail", async () => {
		const checks = ocrProviderContract(
			() => new FakeOcrProvider({ blocks: [ocrBlock("b", "x", rect(190, 0, 50, 10))] }),
			{ image: blankImage(200, 100) },
		);
		const c = checks.find((x) => x.name.startsWith("recognise: blocks are well-formed"));
		await expect(c?.run()).rejects.toThrow(/outside/);
	});
});

describe("FakeOcrProvider behaviour", () => {
	test("progress: boxes first, then blocks", async () => {
		const p = new FakeOcrProvider({ blocks });
		await p.init();
		const events: OcrProgress[] = [];
		const result = await p.recognise({ image: blankImage(200, 100) }, { onProgress: (e) => events.push(e) });
		expect(events.map((e) => e.type)).toEqual(["detected", "block", "block"]);
		expect(result.blocks).toHaveLength(2);
		expect(result.provider).toMatchObject({ id: "fake-ocr", kind: "local", modelRevision: "fake-ocr-1" });
	});

	test("regions limit recognition to changed areas", async () => {
		const p = new FakeOcrProvider({ blocks });
		await p.init();
		const result = await p.recognise({ image: blankImage(200, 100), regions: [rect(0, 45, 200, 30)] });
		expect(result.blocks.map((b) => b.id)).toEqual(["b2"]);
	});

	test("per-language support reports missing recognition models", async () => {
		const p = new FakeOcrProvider({ missingLanguages: ["ko"], unsupportedLanguages: ["am"] });
		expect(p.languageSupport(languageCode("ja")).status).toBe("unsupported"); // before init
		await p.init();
		expect(p.languageSupport(languageCode("ja")).status).toBe("ready");
		const ko = p.languageSupport(languageCode("ko"));
		expect(ko.status === "missing" && ko.missing[0]?.id).toBe("fake-ocr:rec-ko");
		expect(p.languageSupport(languageCode("am")).status).toBe("unsupported");
	});

	test("cloud failures surface as typed errors", async () => {
		const p = new FakeOcrProvider({ kind: "cloud", fail: () => "invalid-key" });
		await p.init();
		const error = await p.recognise({ image: blankImage(10, 10) }).catch((e: unknown) => e);
		expect(isProviderError(error, "invalid-key")).toBe(true);
	});
});

describe("validateOcrImage", () => {
	test("accepts padded rows and rejects short buffers", () => {
		expect(validateOcrImage({ width: 2, height: 2, stride: 16, format: "bgra8", data: new Uint8Array(24) })).toBeNull();
		expect(validateOcrImage({ width: 2, height: 2, stride: 4, format: "bgra8", data: new Uint8Array(16) })).toMatch(
			/stride/,
		);
		expect(validateOcrImage({ width: 0, height: 2, stride: 0, format: "gray8", data: new Uint8Array(0) })).toMatch(
			/positive/,
		);
	});
});
