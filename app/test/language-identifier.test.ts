// GLIM-104: the fastText language identifier in the app: its manifest entry and notices, the
// pipeline stage that loads it once downloaded, and the Settings copy around it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageCode, rect, type SourceLanguageChoice, sourceLanguageChoices } from "@glimpse/core";
import { ocrBlock } from "@glimpse/core/testing";
import { FASTTEXT_MODEL_FILE, FASTTEXT_MODEL_ID } from "@glimpse/providers/language-detect";
import { appModelManifest } from "../src/bun/services/ocr/paddle-models.ts";
import { fastTextWasmPath, pipelineStages } from "../src/bun/services/translation/pipeline-stages.ts";
import type { ModelRow } from "../src/shared/settings-rpc.ts";
import {
	identifierPrompt,
	LANGUAGE_IDENTIFIER_ID,
	nameList,
	noteFor,
	waitingForIdentifier,
} from "../src/views/settings/panes/detection-copy.ts";

const L = languageCode;
const MODELS = join(import.meta.dir, "..", "models");
const PACKAGE_MODEL = join(
	import.meta.dir,
	"..",
	"..",
	"packages",
	"providers",
	"node_modules",
	"fasttext.wasm.js",
	"dist",
	"models",
	"language-identification",
	"assets",
	"lid.176.ftz",
);
const tmp = mkdtempSync(join(tmpdir(), "glim-lid-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("manifest and notices", () => {
	test("an on-demand CC-BY-SA-3.0 download, never bundled", () => {
		const entry = appModelManifest.models.find((m) => m.id === FASTTEXT_MODEL_ID);
		expect(entry).toMatchObject({ kind: "language-detector", bundled: false, licence: "CC-BY-SA-3.0" });
		expect(entry?.files).toEqual([
			{
				name: FASTTEXT_MODEL_FILE,
				urls: ["https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"],
				sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83",
				size: 938013,
			},
		]);
		expect(LANGUAGE_IDENTIFIER_ID).toBe(FASTTEXT_MODEL_ID);
	});

	test("NOTICE attributes the model and the runtime; the licence texts are there", () => {
		const notice = readFileSync(join(MODELS, "NOTICE.txt"), "utf8");
		expect(notice).toContain("lid.176.ftz");
		expect(notice).toContain("licenses/CC-BY-SA-3.0.txt");
		expect(notice).toContain("fasttext.wasm.js");
		expect(readFileSync(join(MODELS, "licenses", "CC-BY-SA-3.0.txt"), "utf8")).toContain(
			"Attribution-ShareAlike 3.0 Unported",
		);
		expect(existsSync(join(MODELS, "licenses", "MIT-fasttext.txt"))).toBe(true);
	});
});

describe("pipeline stages", () => {
	const indonesian = [
		ocrBlock("b1", "Apakah Anda yakin ingin menghapus file ini?", rect(0, 0, 200, 20), 0.95),
		ocrBlock("b2", "Pembayaran berhasil, pesanan akan segera diproses", rect(0, 30, 200, 20), 0.95),
	];
	const ctx = { sources: [L("id"), L("ja")], target: L("en"), mode: "snip" as const };

	test("fastText joins ELD once its model is installed; invalidate picks a download up", async () => {
		const dir = join(tmp, FASTTEXT_MODEL_ID);
		let installed: string | null = null;
		const warnings: string[] = [];
		const stages = pipelineStages({ warn: (m) => warnings.push(m) }, { fastTextDir: () => installed });
		const before = await stages.detector.detect(indonesian, ctx);
		// ELD alone can't name Indonesian: it is reported undetectable and never decided as id by rule 4.
		expect(before.some((b) => b.kind === "language" && b.lang === L("id") && b.confidence > 0.5)).toBe(false);

		await Bun.write(join(dir, FASTTEXT_MODEL_FILE), Bun.file(PACKAGE_MODEL));
		installed = dir;
		stages.detector.invalidate();
		const after = await stages.detector.detect(indonesian, ctx);
		expect(after.map((b) => (b.kind === "language" ? b.lang : b.kind))).toEqual([L("id"), L("id")]);
		expect(warnings).toEqual([]);
	});

	test("a broken model file is logged and detection goes on with ELD", async () => {
		const dir = join(tmp, "broken");
		await Bun.write(join(dir, FASTTEXT_MODEL_FILE), "not a model");
		const warnings: string[] = [];
		const stages = pipelineStages({ warn: (m) => warnings.push(m) }, { fastTextDir: () => dir });
		const r = await stages.detector.detect(indonesian, ctx);
		expect(r).toHaveLength(2);
		expect(warnings).toEqual(["fastText language identifier unavailable; using ELD and the script rules"]);
	});

	test("the staged WASM runtime is used when it sits next to the bundle", () => {
		expect(fastTextWasmPath(undefined)).toBeUndefined();
		expect(fastTextWasmPath(tmp)).toBeUndefined();
		writeFileSync(join(tmp, "fastText.node.wasm"), "");
		expect(fastTextWasmPath(tmp)).toBe(join(tmp, "fastText.node.wasm"));
	});
});

describe("Settings › Languages copy", () => {
	const choices = sourceLanguageChoices("en");
	const pick = (code: string) => choices.find((c) => c.code === L(code)) as SourceLanguageChoice;
	const row = (status: "missing" | "installed"): ModelRow => ({
		id: LANGUAGE_IDENTIFIER_ID,
		kind: "detector",
		name: "Language identifier",
		bytes: 938013,
		state: status === "installed" ? { status, bundled: false } : { status },
	});

	test("detectedBy: ELD first, fastText for the rest", () => {
		expect(pick("de").detectedBy).toBe("eld");
		expect(pick("id").detectedBy).toBe("fasttext");
		expect(pick("sw").detectedBy).toBe("fasttext");
	});

	test("the option note asks for the identifier only while it's missing", () => {
		expect(noteFor(pick("id"), row("missing"))).toBe("Needs the language identifier");
		expect(noteFor(pick("id"), row("installed"))).not.toBe("Needs the language identifier");
		expect(noteFor(pick("id"), undefined)).not.toBe("Needs the language identifier");
		expect(noteFor(pick("de"), row("missing"))).not.toBe("Needs the language identifier");
	});

	test("the prompt names the chosen languages that wait for it", () => {
		const chosen = [pick("ja"), pick("id"), pick("sw")];
		expect(waitingForIdentifier(chosen, row("installed"))).toEqual([]);
		expect(waitingForIdentifier(chosen, undefined)).toEqual([]);
		const waiting = waitingForIdentifier(chosen, row("missing"));
		expect(waiting.map((l) => l.code)).toEqual([L("id"), L("sw")]);
		expect(identifierPrompt(waiting)).toBe(
			"Indonesian and Swahili aren't recognised by the built-in detector. Until the language identifier is downloaded, Glimpse may skip text in them.",
		);
		expect(identifierPrompt([pick("id")])).toContain("Indonesian isn't recognised");
		expect(nameList(["a", "b", "c"])).toBe("a, b and c");
	});
});
