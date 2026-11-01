import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry, Redactor, rect } from "@glimpse/core";
import { fakeOcrFactory, fakeTranslationFactory } from "@glimpse/core/testing";
import { buildDiagnostics, providerRows } from "../src/bun/services/diagnostics.ts";
import { createAppLogger, LOG_FILE, logEnvOverrides, RotatingFileSink } from "../src/bun/services/log.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "glimpse-log-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const record = (message: string) => ({ time: 0, level: "info" as const, scope: "t", message, fields: {} });

describe("RotatingFileSink", () => {
	test("creates the dir and appends lines", () => {
		const logsDir = join(dir, "nested", "logs");
		const sink = new RotatingFileSink(logsDir);
		sink.write(record("one"));
		sink.write(record("two"));
		sink.close();
		const text = readFileSync(join(logsDir, LOG_FILE), "utf8");
		expect(text.trim().split("\n")).toHaveLength(2);
		expect(text).toContain("t: two");
		if (process.platform !== "win32") expect(statSync(join(logsDir, LOG_FILE)).mode & 0o777).toBe(0o600);
	});

	test("rotates at maxBytes and keeps at most `keep` files", () => {
		const sink = new RotatingFileSink(dir, { maxBytes: 1024, keep: 3 });
		for (let i = 0; i < 200; i++) sink.write(record(`line ${i} ${"x".repeat(40)}`));
		sink.close();
		const files = readdirSync(dir).sort();
		expect(files).toEqual(["glimpse.1.log", "glimpse.2.log", "glimpse.log"]);
		for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(1024);
		// Newest lines are in the current file, oldest dropped.
		expect(readFileSync(join(dir, LOG_FILE), "utf8")).toContain("line 199 ");
		expect(readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes("line 0 "))).toBe(false);
	});

	test("picks up an existing file's size after a restart", () => {
		writeFileSync(join(dir, LOG_FILE), `${"y".repeat(1000)}\n`);
		const sink = new RotatingFileSink(dir, { maxBytes: 1024, keep: 2 });
		sink.write(record("x".repeat(100)));
		sink.close();
		expect(existsSync(join(dir, "glimpse.1.log"))).toBe(true);
	});

	test("tail reads across rotated files; recent is this session", () => {
		const sink = new RotatingFileSink(dir, { maxBytes: 1024, keep: 5, memoryLines: 3 });
		for (let i = 0; i < 60; i++) sink.write(record(`n${i} ${"z".repeat(30)}`));
		const tail = sink.tail(40);
		expect(tail).toHaveLength(40);
		expect(tail[39]).toContain("n59 ");
		expect(tail[0]).toContain("n20 ");
		expect(sink.recent()).toHaveLength(3);
		sink.close();
	});

	test("an unwritable dir drops lines instead of throwing", () => {
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "");
		const sink = new RotatingFileSink(join(file, "logs"));
		expect(() => sink.write(record("x"))).not.toThrow();
		expect(sink.dropped).toBe(1);
		expect(sink.recent()).toHaveLength(1);
	});
});

describe("createAppLogger", () => {
	test("env overrides: level and screen text", () => {
		expect(logEnvOverrides({ GLIMPSE_LOG_LEVEL: " DEBUG " })).toEqual({ level: "debug", screenText: false });
		expect(logEnvOverrides({ GLIMPSE_LOG_LEVEL: "loud", GLIMPSE_LOG_SCREEN_TEXT: "1" })).toEqual({
			level: null,
			screenText: true,
		});
	});

	test("settings level applies unless the env overrides it", () => {
		const a = createAppLogger({ dir, env: {}, console: false });
		a.applySettingsLevel("warn");
		expect(a.logger.level).toBe("warn");
		const b = createAppLogger({ dir, env: { GLIMPSE_LOG_LEVEL: "debug" }, console: false });
		b.applySettingsLevel("warn");
		expect(b.logger.level).toBe("debug");
		a.file.close();
		b.file.close();
	});

	test("the file never contains keys or screen text by default", () => {
		const { logger, file } = createAppLogger({ dir, env: {}, console: false, homeDir: "/home/alice" });
		logger.redactor.addSecret("k-123456789");
		logger.info("translated", { sourceText: "秘密のメッセージ", apiKey: "k-123456789", path: "/home/alice/x" });
		logger.warn("cloud error k-123456789");
		file.close();
		const text = readFileSync(join(dir, LOG_FILE), "utf8");
		expect(text).not.toContain("秘密");
		expect(text).not.toContain("k-123456789");
		expect(text).not.toContain("alice");
		expect(text).toContain('sourceText="[text: 8 chars]"');
	});

	test("GLIMPSE_LOG_SCREEN_TEXT=1 logs text and says so", () => {
		const { logger, file } = createAppLogger({ dir, env: { GLIMPSE_LOG_SCREEN_TEXT: "1" }, console: false });
		logger.info("translated", { translation: "Hello there" });
		file.close();
		const text = readFileSync(join(dir, LOG_FILE), "utf8");
		expect(text).toContain("screen text logging is on");
		expect(text).toContain('"Hello there"');
	});
});

describe("diagnostics", () => {
	const registry = new ProviderRegistry<unknown>()
		.register(fakeOcrFactory({ id: "paddleocr", defaultRank: 0 }))
		.register(fakeTranslationFactory({ id: "bergamot", defaultRank: 10 }))
		.register(fakeTranslationFactory({ id: "cloud:google-translate-v2", kind: "cloud" }));

	test("provider rows show the selection", () => {
		const rows = providerRows(registry, { ocr: "paddleocr", translation: ["bergamot"], options: {} });
		expect(rows.map((r) => [r.id, r.selected])).toEqual([
			["paddleocr", "ocr"],
			["bergamot", "translation #1"],
			["cloud:google-translate-v2", null],
		]);
	});

	test("bundle has versions, OS, displays, providers, state and log tail; survives failing sources", () => {
		const text = buildDiagnostics({
			appInfo: { name: "Glimpse", version: "0.0.1", platform: "linux", electrobun: "2.0.6-beta.2", bun: "1.4.4" },
			displays: () => [
				{ id: 7, bounds: rect(0, 0, 1920, 1080), workArea: rect(0, 0, 1920, 1040), scaleFactor: 1.5, isPrimary: true },
			],
			providers: registry,
			providersConfig: () => ({ ocr: "paddleocr", translation: ["bergamot"], options: {} }),
			state: () => {
				throw new Error("not ready");
			},
			logTail: () => ["2026-11-01T12:00:00.000Z INFO  started"],
			redactor: new Redactor(),
			now: () => 0,
			locale: "de-DE",
		});
		expect(text).toContain("Glimpse 0.0.1");
		expect(text).toContain("electrobun: 2.0.6-beta.2");
		expect(text).toContain("locale: de-DE");
		expect(text).toContain("#7 primary: 1920x1080");
		expect(text).toContain("paddleocr");
		expect(text).toContain("## State\n(none)");
		expect(text).toContain("INFO  started");
	});
});
