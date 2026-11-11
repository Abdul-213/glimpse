import { describe, expect, test } from "bun:test";
import {
	createLogger,
	formatDiagnostics,
	formatLogRecord,
	isContentKey,
	isSecretKey,
	levelEnabled,
	nullLogger,
	REDACTED,
	Redactor,
	rect,
	sensitive,
} from "@glimpse/core";
import { MemoryLogSink } from "@glimpse/core/testing";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

function setup(options: { includeContent?: boolean; homeDir?: string } = {}) {
	const sink = new MemoryLogSink();
	const logger = createLogger({ sinks: [sink], level: "debug", redactor: new Redactor(options), now: () => T0 });
	return { sink, logger };
}

describe("levels", () => {
	test("threshold filters lower levels", () => {
		expect(levelEnabled("info", "error")).toBe(true);
		expect(levelEnabled("info", "debug")).toBe(false);
		const sink = new MemoryLogSink();
		const logger = createLogger({ sinks: [sink], level: "warn" });
		logger.info("hidden");
		logger.warn("shown");
		expect(sink.records.map((r) => r.message)).toEqual(["shown"]);
	});

	test("setLevel applies to children", () => {
		const sink = new MemoryLogSink();
		const root = createLogger({ sinks: [sink], level: "info" });
		const child = root.child("live");
		child.debug("a");
		root.setLevel("debug");
		child.debug("b");
		expect(child.level).toBe("debug");
		expect(sink.records.map((r) => r.message)).toEqual(["b"]);
	});

	test("nullLogger is inert", () => {
		nullLogger.child("x").error("nothing");
		expect(nullLogger.enabled("error")).toBe(false);
	});
});

describe("structured fields and scopes", () => {
	test("child scopes nest and base fields merge", () => {
		const { sink, logger } = setup();
		logger.child("providers", { task: "ocr" }).child("paddleocr").info("ready", { ms: 412 });
		const r = sink.records[0];
		expect(r?.scope).toBe("providers.paddleocr");
		expect(r?.fields).toEqual({ task: "ocr", ms: 412 });
	});

	test("one line per record, logfmt-style", () => {
		const { sink, logger } = setup();
		logger.child("settings").warn("bad field\nsecond line", { path: "live.fps", note: "has spaces", n: 3, ok: true });
		expect(sink.text()).toBe(
			'2026-11-01T12:00:00.000Z WARN  settings: bad field\\nsecond line path=live.fps note="has spaces" n=3 ok=true',
		);
	});

	test("errors keep name, message, code and a short stack", () => {
		const { sink, logger } = setup();
		const error = Object.assign(new Error("boom"), { code: "E_X" });
		logger.error("failed", { error });
		const f = sink.records[0]?.fields["error"] as Record<string, unknown>;
		expect(f["name"]).toBe("Error");
		expect(f["message"]).toBe("boom");
		expect(f["code"]).toBe("E_X");
		expect(typeof f["stack"]).toBe("string");
	});

	test("a sink that throws doesn't break the caller or other sinks", () => {
		const good = new MemoryLogSink();
		const logger = createLogger({
			sinks: [
				{
					write: () => {
						throw new Error("disk full");
					},
				},
				good,
			],
		});
		expect(() => logger.info("x")).not.toThrow();
		expect(good.records).toHaveLength(1);
	});

	test("circular and deep values are bounded", () => {
		const { sink, logger } = setup();
		const a: Record<string, unknown> = { name: "a" };
		a["self"] = a;
		logger.info("x", { a, list: Array.from({ length: 80 }, (_, i) => i) });
		const f = sink.records[0]?.fields ?? {};
		expect((f["a"] as Record<string, unknown>)["self"]).toBe("[circular]");
		expect((f["list"] as unknown[]).length).toBe(51);
	});
});

describe("privacy: secrets", () => {
	test("credential-like field names are redacted", () => {
		for (const k of ["apiKey", "api_key", "API-KEY", "key", "accessToken", "password", "authorization", "secret"]) {
			expect(isSecretKey(k)).toBe(true);
		}
		for (const k of ["hotkey", "cacheKey", "monkey", "providerId", "author"]) expect(isSecretKey(k)).toBe(false);
		const { sink, logger } = setup();
		logger.info("saving", { apiKey: "AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI", nested: { token: "abc" } });
		expect(sink.records[0]?.fields).toEqual({ apiKey: REDACTED, nested: { token: REDACTED } });
	});

	test("registered secret values are scrubbed anywhere, including messages and errors", () => {
		const { sink, logger } = setup();
		const key = "my-very-private-key-123";
		logger.redactor.addSecret(key);
		logger.warn(`request failed for ${key}`, { error: new Error(`HTTP 400: key ${key} invalid`), url: `x/${key}` });
		expect(sink.text()).not.toContain(key);
		expect(sink.text()).toContain(REDACTED);
	});

	test("credential shapes in strings are scrubbed", () => {
		const r = new Redactor();
		expect(r.string("GET https://translation.googleapis.com/v2?key=AIzaXYZ123&q=1")).toBe(
			`GET https://translation.googleapis.com/v2?key=${REDACTED}&q=1`,
		);
		expect(r.string("Authorization: Bearer abcdefgh12345678")).toBe(`Authorization: Bearer ${REDACTED}`);
		expect(r.string("key AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI end")).toBe(`key ${REDACTED} end`);
		expect(r.string("sk-abcdefghijklmnopqrstu")).toBe(REDACTED);
	});
});

describe("privacy: screen content and pixels", () => {
	test("sensitive() and content-named fields become lengths by default", () => {
		expect(isContentKey("sourceText")).toBe(true);
		expect(isContentKey("translation")).toBe(true);
		const { sink, logger } = setup();
		logger.info("translated", {
			sourceText: "こんにちは",
			translation: "Hello",
			blocks: [sensitive("secret chat line")],
			lang: "ja",
		});
		expect(sink.records[0]?.fields).toEqual({
			sourceText: "[text: 5 chars]",
			translation: "[text: 5 chars]",
			blocks: ["[text: 16 chars]"],
			lang: "ja",
		});
		expect(sink.text()).not.toContain("Hello");
		expect(sink.text()).not.toContain("secret chat line");
	});

	test("includeContent (developer opt-in) logs text", () => {
		const { sink, logger } = setup({ includeContent: true });
		logger.info("translated", { translation: "Hello", other: sensitive("World") });
		expect(sink.records[0]?.fields).toEqual({ translation: "Hello", other: "World" });
	});

	test("pixels are never logged, even with includeContent", () => {
		const { sink, logger } = setup({ includeContent: true });
		logger.info("frame", { image: { width: 2, height: 2, data: new Uint8Array(16) }, raw: new ArrayBuffer(8) });
		expect(sink.records[0]?.fields).toEqual({
			image: { width: 2, height: 2, data: "[binary: 16 bytes]" },
			raw: "[binary: 8 bytes]",
		});
	});

	test("home dir becomes ~", () => {
		const r = new Redactor({ homeDir: "/home/alice" });
		expect(r.string("/home/alice/Library/Logs/x.log")).toBe("~/Library/Logs/x.log");
		const w = new Redactor({ homeDir: "C:\\Users\\Alice" });
		expect(w.string("c:\\users\\alice\\AppData")).toBe("~\\AppData");
	});

	test("long strings are capped", () => {
		const r = new Redactor({ maxStringLength: 10 });
		expect(r.string("x".repeat(25))).toBe(`${"x".repeat(10)}… [15 more chars]`);
	});
});

describe("diagnostics bundle", () => {
	test("formats every section and stays redacted", () => {
		const redactor = new Redactor({ homeDir: "/home/alice" });
		redactor.addSecret("super-secret-value");
		const text = formatDiagnostics(
			{
				generatedAt: T0,
				app: { name: "Glimpse", version: "0.1.0" },
				runtime: { bun: "1.4.4" },
				os: { platform: "macos", release: "25.0" },
				displays: [
					{ id: 1, bounds: rect(0, 0, 1512, 982), workArea: rect(0, 33, 1512, 949), scaleFactor: 2, isPrimary: true },
				],
				providers: [
					{
						id: "bergamot",
						name: "Bergamot",
						task: "translation",
						kind: "local",
						selected: "translation #1",
						status: null,
					},
				],
				state: { logsDir: "/home/alice/Library/Logs/dev.glimpse.app", apiKey: "x" },
				logTail: ["line with super-secret-value"],
			},
			redactor,
		);
		expect(text).toContain("# Glimpse diagnostics");
		expect(text).toContain("Glimpse 0.1.0");
		expect(text).toContain("#1 primary: 1512x982 at 0,0 scale 2");
		expect(text).toContain("bergamot (Bergamot, translation, local): translation #1");
		expect(text).toContain("logsDir: ~/Library/Logs/dev.glimpse.app");
		expect(text).toContain(`apiKey: ${REDACTED}`);
		expect(text).not.toContain("super-secret-value");
		expect(text).not.toContain("alice");
	});

	test("format of a record without scope or fields", () => {
		expect(formatLogRecord({ time: T0, level: "info", scope: "", message: "hi", fields: {} })).toBe(
			"2026-11-01T12:00:00.000Z INFO  hi",
		);
	});
});
