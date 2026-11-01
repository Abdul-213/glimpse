import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	DISK_HEADROOM_BYTES,
	type InstallEvent,
	type InstallState,
	installProgress,
	installReducer,
	isDesktopRelease,
	isPrerelease,
	languageCode,
	MISSING,
	packDescriptor,
	packDownloadSize,
	packInstalledSize,
	packUpdate,
	parseBergamotRecords,
	requiredFreeBytes,
	selectDesktopPacks,
	summarizeAvailability,
} from "../src/index.ts";

const h = (c: string) => c.repeat(64);
let n = 0;
function rec(
	src: string,
	tgt: string,
	fileType: string,
	version = "3.0",
	extra: { architecture?: string; filter?: string; name?: string } = {},
) {
	n++;
	return {
		id: `id-${n}`,
		name: extra.name ?? `${fileType}.${src}${tgt}.bin`,
		version,
		fileType,
		architecture: extra.architecture ?? "base-memory",
		sourceLanguage: src,
		targetLanguage: tgt,
		filter_expression: extra.filter ?? "",
		decompressedHash: h("d"),
		decompressedSize: 100,
		attachment: { hash: h("a"), size: 40, location: `main-workspace/translations-models-v2/${n}.zst` },
	};
}
const pack = (src: string, tgt: string, version = "3.0", extra = {}) => [
	rec(src, tgt, "model", version, extra),
	rec(src, tgt, "lex", version, extra),
	rec(src, tgt, "vocab", version, extra),
];

describe("Bergamot records", () => {
	test("parse skips malformed records", () => {
		const bad = { ...rec("de", "en", "model"), attachment: { hash: "nope", size: 1, location: "x" } };
		const parsed = parseBergamotRecords({ data: [rec("de", "en", "model"), bad, null, { name: "x" }] });
		expect(parsed.records.length).toBe(1);
		expect(parsed.rejected).toBe(3);
		expect(() => parseBergamotRecords({})).toThrow();
	});

	test("filters, prerelease and versions", () => {
		expect(isDesktopRelease("")).toBe(true);
		expect(isDesktopRelease("env.appinfo.OS != 'Android'")).toBe(true);
		expect(isDesktopRelease("env.appinfo.OS == 'Android'")).toBe(false);
		expect(isDesktopRelease("env.channel == 'default' || env.channel == 'nightly'")).toBe(false);
		expect(isPrerelease("3.0a1")).toBe(true);
		expect(isPrerelease("3.1")).toBe(false);
		expect(compareVersions("3.10", "3.9")).toBeGreaterThan(0);
		expect(compareVersions("3.0", "3")).toBe(0);
	});

	test("selects the newest complete desktop release per direction", () => {
		const records = parseBergamotRecords({
			data: [
				...pack("ja", "en", "3.0", { architecture: "base", filter: "env.appinfo.OS != 'Android'" }),
				...pack("ja", "en", "3.1", { architecture: "base-memory", filter: "env.appinfo.OS == 'Android'" }),
				...pack("ja", "en", "4.0a1"),
				...pack("de", "en", "3.0"),
				...pack("de", "en", "3.1"),
				rec("fr", "en", "model", "3.2"), // incomplete at 3.2: falls back to 3.0
				...pack("fr", "en", "3.0"),
				rec("en", "ja", "model"),
				rec("en", "ja", "lex"),
				rec("en", "ja", "srcvocab"),
				rec("en", "ja", "trgvocab"),
				...pack("x", "en"), // not a language tag: skipped (new real languages like "xh" still map)
			],
		}).records;
		const packs = selectDesktopPacks(records);
		expect(packs.map((p) => `${p.id}@${p.version}:${p.architecture}`)).toEqual([
			"bergamot-de-en@3.1:base-memory",
			"bergamot-en-ja@3.0:base-memory",
			"bergamot-fr-en@3.0:base-memory",
			"bergamot-ja-en@3.0:base",
		]);
		const ja = packs.find((p) => p.id === "bergamot-ja-en");
		expect(ja?.source).toBe(languageCode("ja"));
		expect(ja?.files.map((f) => f.fileType)).toEqual(["model", "lex", "vocab"]);
		expect(ja?.files[0]?.urls[0]).toMatch(
			/^https:\/\/firefox-settings-attachments\.cdn\.mozilla\.net\/main-workspace\//,
		);
		expect(ja?.files[0]?.compression).toBe("zstd");
		const enJa = packs.find((p) => p.id === "bergamot-en-ja");
		expect(enJa && packDescriptor(enJa).files).toEqual({
			model: "model.enja.bin",
			lex: "lex.enja.bin",
			srcvocab: "srcvocab.enja.bin",
			trgvocab: "trgvocab.enja.bin",
		});
		expect(ja && packDownloadSize(ja)).toBe(120);
		expect(ja && packInstalledSize(ja)).toBe(300);
	});

	test("zh-Hans maps to the canonical code and the pack id stays lowercase", () => {
		const [p] = selectDesktopPacks(parseBergamotRecords({ data: pack("zh-Hans", "en") }).records);
		expect(p?.id).toBe("bergamot-zh-hans-en");
		expect(p?.source).toBe(languageCode("zh-Hans"));
	});

	test("updates", () => {
		const packs = selectDesktopPacks(parseBergamotRecords({ data: pack("de", "en", "3.1") }).records);
		expect(packUpdate({ id: "bergamot-de-en", version: "3.0" }, packs)?.version).toBe("3.1");
		expect(packUpdate({ id: "bergamot-de-en", version: "3.1" }, packs)).toBeNull();
		expect(packUpdate({ id: "bergamot-fr-en", version: "1.0" }, packs)).toBeNull();
	});
});

describe("install state machine", () => {
	const run = (events: InstallEvent[], from: InstallState = MISSING) => events.reduce(installReducer, from);

	test("happy path", () => {
		const s = run([
			{ type: "queue" },
			{ type: "progress", receivedBytes: 5, totalBytes: 10 },
			{ type: "progress", receivedBytes: 10, totalBytes: 10 },
			{ type: "verify" },
			{ type: "install" },
			{ type: "done", version: "3.0" },
		]);
		expect(s).toEqual({ status: "installed", version: "3.0", bundled: false });
	});

	test("progress", () => {
		const s = run([{ type: "queue" }, { type: "progress", receivedBytes: 15, totalBytes: 10 }]);
		expect(installProgress(s)).toBe(1);
		expect(installProgress(MISSING)).toBeNull();
	});

	test("ignores events that don't fit", () => {
		expect(run([{ type: "progress", receivedBytes: 1, totalBytes: 2 }])).toBe(MISSING);
		expect(run([{ type: "install" }])).toBe(MISSING);
		const downloading = run([{ type: "queue" }, { type: "progress", receivedBytes: 1, totalBytes: 2 }]);
		expect(installReducer(downloading, { type: "queue" })).toBe(downloading);
		expect(installReducer(downloading, { type: "remove" })).toBe(downloading);
		expect(run([{ type: "fail", error: { kind: "io", message: "x" } }])).toBe(MISSING);
	});

	test("failure and retry", () => {
		const failed = run([{ type: "queue" }, { type: "fail", error: { kind: "network", message: "offline" } }]);
		expect(failed.status).toBe("failed");
		expect(installReducer(failed, { type: "queue" })).toEqual({ status: "queued" });
	});
});

describe("disk space and availability", () => {
	test("needs downloads + unpacked + headroom, minus resumed bytes", () => {
		const files = [{ size: 40, decompressedSize: 100 }, { size: 10 }];
		expect(requiredFreeBytes(files)).toBe(50 + 100 + DISK_HEADROOM_BYTES);
		expect(requiredFreeBytes(files, 30)).toBe(20 + 100 + DISK_HEADROOM_BYTES);
	});

	const installed: InstallState = { status: "installed", version: "1", bundled: false };
	const downloading: InstallState = { status: "downloading", receivedBytes: 50, totalBytes: 100 };
	const failed: InstallState = { status: "failed", error: { kind: "checksum", message: "bad" } };
	const offlineFail: InstallState = { status: "failed", error: { kind: "network", message: "offline" } };

	test("summaries", () => {
		expect(summarizeAvailability([{ id: "a", state: installed, downloadBytes: 1 }], true)).toEqual({ kind: "ready" });
		expect(
			summarizeAvailability(
				[
					{ id: "a", state: downloading, downloadBytes: 100 },
					{ id: "b", state: installed, downloadBytes: 1 },
				],
				true,
			),
		).toEqual({ kind: "downloading", progress: 0.5 });
		expect(
			summarizeAvailability(
				[
					{ id: "a", state: MISSING, downloadBytes: 30 },
					{ id: "b", state: MISSING, downloadBytes: 20 },
				],
				true,
			),
		).toEqual({ kind: "needs-download", ids: ["a", "b"], bytes: 50 });
		expect(summarizeAvailability([{ id: "a", state: MISSING, downloadBytes: 30 }], false)).toEqual({
			kind: "offline",
			ids: ["a"],
		});
		expect(summarizeAvailability([{ id: "a", state: offlineFail, downloadBytes: 30 }], false).kind).toBe("offline");
		expect(summarizeAvailability([{ id: "a", state: failed, downloadBytes: 30 }], true).kind).toBe("failed");
	});
});
