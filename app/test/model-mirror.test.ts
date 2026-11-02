// GLIM-95: the OCR models' GitHub release mirror: manifest URLs, release assets, and downloads
// that fall back to the mirror when ModelScope is blocked.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEntry, ModelManifest } from "@glimpse/core";
import { ensureModel, loadManifest } from "../scripts/model-cache.ts";
import {
	checkMirrors,
	mirrorFiles,
	mirrorNotes,
	mirrorTag,
	mirrorUrl,
	ocrModels,
	stageMirror,
} from "../scripts/model-mirror.ts";

const tmp = mkdtempSync(join(tmpdir(), "glim-mirror-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const app = loadManifest();

describe("the app manifest", () => {
	test("every OCR file lists its release mirror, second after ModelScope", () => {
		expect(mirrorTag(app)).toBe("models-ocr-v3.10.0");
		expect(checkMirrors(app)).toEqual([]);
		const files = ocrModels(app).flatMap((m) => m.files);
		expect(files.length).toBeGreaterThanOrEqual(25);
		for (const f of files) {
			expect(f.urls[0]).toStartWith("https://www.modelscope.cn/");
			expect(f.urls[1]).toBe(`https://github.com/Abdul-213/glimpse/releases/download/models-ocr-v3.10.0/${f.name}`);
		}
		// Release asset names must be unique.
		expect(mirrorFiles(app)).toHaveLength(files.length);
	});

	test("only the OCR models are mirrored (ModelScope's), not Bergamot or the on-demand models", () => {
		const others = app.models.filter((m) => !ocrModels(app).includes(m));
		for (const m of others) for (const f of m.files) expect(f.urls.join(" ")).not.toContain("releases/download");
	});

	test("the release notes name the licence and say it isn't an app release", () => {
		const notes = mirrorNotes(app);
		expect(notes).toContain("Apache");
		expect(notes).toContain("Not an app release");
	});
});

describe("checkMirrors", () => {
	const entry = (urls: string[]): ModelManifest => ({
		schema: 1,
		models: [
			{
				id: "ocr-det",
				kind: "ocr-detector",
				bundled: true,
				licence: "Apache-2.0",
				attribution: "test",
				revision: "RapidOCR v3.10.0",
				files: [{ name: "det.onnx", urls, sha256: "0".repeat(64), size: 1 }],
			},
		],
	});
	const mirror = mirrorUrl("models-ocr-v3.10.0", "det.onnx");

	test("missing, first, second and too late", () => {
		expect(checkMirrors(entry(["https://a.test/det.onnx"]))).toEqual([`ocr-det/det.onnx: no mirror URL ${mirror}`]);
		expect(checkMirrors(entry([mirror, "https://a.test/det.onnx"]))).toEqual([]);
		expect(checkMirrors(entry(["https://a.test/det.onnx", mirror]))).toEqual([]);
		expect(checkMirrors(entry(["https://a.test/1", "https://a.test/2", mirror]))).toEqual([
			`ocr-det/det.onnx: mirror URL is #3; list it first or second`,
		]);
	});
});

describe("ModelScope blocked", () => {
	const bytes = new TextEncoder().encode("pretend this is an onnx model ".repeat(40));
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const model: ModelEntry = {
		id: "ocr-rec-th",
		kind: "ocr-recognizer",
		recognizer: "th",
		bundled: false,
		licence: "Apache-2.0",
		attribution: "test",
		revision: "RapidOCR v3.10.0",
		files: [
			{
				name: "th_PP-OCRv5_rec_mobile.onnx",
				urls: [
					"https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/th_PP-OCRv5_rec_mobile.onnx",
					mirrorUrl("models-ocr-v3.10.0", "th_PP-OCRv5_rec_mobile.onnx"),
				],
				sha256,
				size: bytes.byteLength,
			},
		],
	};
	const manifest: ModelManifest = { schema: 1, models: [model] };
	const hits: string[] = [];
	const blocked = async (url: string) => {
		hits.push(new URL(url).host);
		if (new URL(url).host.endsWith("modelscope.cn")) throw new TypeError("fetch failed: connection reset");
		return new Response(bytes as Uint8Array<ArrayBuffer>);
	};

	test("`bun run models` falls back to the mirror and verifies the bytes", async () => {
		const logs: string[] = [];
		await ensureModel(model, { cacheDir: join(tmp, "cache-a"), fetch: blocked, log: (l) => logs.push(l) });
		expect(hits).toEqual(["www.modelscope.cn", "github.com"]);
		expect(readdirSync(join(tmp, "cache-a", "sha256"))).toEqual([sha256]);
		expect(logs).toHaveLength(1);
	});

	test("the mirror serving other bytes fails the checksum (nothing is trusted unverified)", async () => {
		const wrong = async (url: string) =>
			new URL(url).host.endsWith("modelscope.cn")
				? Promise.reject(new TypeError("fetch failed"))
				: new Response(new TextEncoder().encode("tampered") as Uint8Array<ArrayBuffer>);
		await expect(ensureModel(model, { cacheDir: join(tmp, "cache-b"), fetch: wrong })).rejects.toThrow(
			/could not fetch th_PP-OCRv5_rec_mobile\.onnx/,
		);
	});

	test("staging writes the files, NOTICE.txt, the licence and SHA256SUMS", async () => {
		const out = join(tmp, "assets");
		const names = await stageMirror(manifest, out, { cacheDir: join(tmp, "cache-a") });
		expect(names).toEqual(["th_PP-OCRv5_rec_mobile.onnx", "NOTICE.txt", "LICENSE-Apache-2.0.txt", "SHA256SUMS"]);
		expect(readdirSync(out).sort()).toEqual([...names].sort());
		expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toBe(`${sha256}  th_PP-OCRv5_rec_mobile.onnx\n`);
		expect(readFileSync(join(out, "NOTICE.txt"), "utf8")).toContain("PaddleOCR");
		expect(readFileSync(join(out, "LICENSE-Apache-2.0.txt"), "utf8")).toContain("Apache License");
		expect(
			createHash("sha256")
				.update(readFileSync(join(out, "th_PP-OCRv5_rec_mobile.onnx")))
				.digest("hex"),
		).toBe(sha256);
	});
});
