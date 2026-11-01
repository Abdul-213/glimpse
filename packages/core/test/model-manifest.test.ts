import { describe, expect, test } from "bun:test";
import { downloadSize, installedSize, ManifestError, parseModelManifest } from "../src/index.ts";

const sha = "a".repeat(64);
const file = { name: "m.onnx", urls: ["https://x.test/m.onnx"], sha256: sha, size: 10 };
const entry = {
	id: "ocr-rec-latin",
	kind: "ocr-recognizer",
	recognizer: "latin",
	bundled: false,
	licence: "Apache-2.0",
	attribution: "test",
	revision: "1",
	files: [file],
};
const manifest = (models: unknown[]) => ({ schema: 1, models });

describe("parseModelManifest", () => {
	test("accepts a valid manifest", () => {
		const m = parseModelManifest(manifest([entry]));
		expect(m.models[0]?.recognizer).toBe("latin");
		const model = m.models[0];
		expect(model && installedSize(model)).toBe(10);
	});

	test("zstd files need decompressed hash and size", () => {
		const zstd = { ...file, compression: "zstd", decompressedSha256: "b".repeat(64), decompressedSize: 40 };
		const m = parseModelManifest(manifest([{ ...entry, files: [zstd] }]));
		const model = m.models[0];
		expect(model && installedSize(model)).toBe(40);
		expect(model && downloadSize(model)).toBe(10);
		expect(() => parseModelManifest(manifest([{ ...entry, files: [{ ...file, compression: "zstd" }] }]))).toThrow(
			/decompressedSha256/,
		);
	});

	test.each([
		["wrong schema", { schema: 2, models: [] }, /schema/],
		["not an object", [], /expected an object/],
		["bad hash", manifest([{ ...entry, files: [{ ...file, sha256: "ABC" }] }]), /sha256/],
		["http URL", manifest([{ ...entry, files: [{ ...file, urls: ["http://x.test/m"] }] }]), /https/],
		["path in name", manifest([{ ...entry, files: [{ ...file, name: "../evil" }] }]), /unsafe/],
		["unknown recogniser", manifest([{ ...entry, recognizer: "klingon" }]), /recogniser/],
		["unknown kind", manifest([{ ...entry, kind: "llm" }]), /kind/],
		["duplicate id", manifest([entry, entry]), /duplicate/],
		["no files", manifest([{ ...entry, files: [] }]), /empty/],
		["zero size", manifest([{ ...entry, files: [{ ...file, size: 0 }] }]), /byte count/],
	])("rejects %s", (_name, json, message) => {
		expect(() => parseModelManifest(json)).toThrow(ManifestError);
		expect(() => parseModelManifest(json)).toThrow(message);
	});
});
