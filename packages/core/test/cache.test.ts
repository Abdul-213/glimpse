import { describe, expect, test } from "bun:test";
import {
	type CachedTranslation,
	isProviderError,
	keyHash,
	languageCode,
	normaliseSegment,
	type Provenance,
	ProviderError,
	TranslationCache,
	TranslationCaches,
	type TranslationKey,
} from "../src/index.ts";
import { ManualClock } from "../src/testing/index.ts";

const L = languageCode;
const fp = { providerId: "bergamot", modelRevision: "ja-en@1/abc", optionsHash: "o1" };
const key = (text: string, over: Partial<TranslationKey> = {}): TranslationKey => ({
	text,
	from: L("ja"),
	to: L("en"),
	fingerprint: fp,
	...over,
});
const prov = (over: Partial<Provenance> = {}): Provenance => ({
	id: "bergamot",
	kind: "local",
	name: "On-device translation",
	...fp,
	...over,
});
const value = (text: string, over: Partial<Provenance> = {}): CachedTranslation => ({
	text,
	provider: prov(over),
	createdAt: 1,
});

describe("normaliseSegment (GLIM-20 normaliser)", () => {
	test.each([
		[
			"Latin line breaks become spaces",
			"Save your\nprogress  before\r\nquitting.",
			"Save your progress before quitting.",
		],
		["CJK line breaks are removed", "明日の会議は\n午後三時です。", "明日の会議は午後三時です。"],
		["CJK next to Latin keeps a space", "設定\nSettings", "設定 Settings"],
		["NFKC folds full-width forms", "ＨＰ　１００", "HP 100"],
		[
			"zero-width and BiDi controls are stripped",
			`a${String.fromCharCode(0x200b)}b ${String.fromCharCode(0x202e)}مرحبا${String.fromCharCode(0x202c)}`,
			"ab مرحبا",
		],
		["whitespace is collapsed and trimmed", "  hello \t  world  ", "hello world"],
		["case, punctuation and digits are kept", "Not now? 1 HP", "Not now? 1 HP"],
	])("%s", (_name, input, expected) => {
		expect(normaliseSegment(input)).toBe(expected);
	});
});

describe("TranslationCache", () => {
	test("set + get round trip marks results remembered; misses are counted", () => {
		const cache = new TranslationCache();
		expect(cache.get(key("こんにちは"))).toBeUndefined();
		cache.set(key("こんにちは"), value("Hello"));
		const hit = cache.get(key("こんにちは"));
		expect(hit?.text).toBe("Hello");
		expect(hit?.provider.remembered).toBe(true);
		expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, writes: 1 });
	});

	test("every key field changes the key", () => {
		const cache = new TranslationCache();
		cache.set(key("x"), value("X"));
		const variants: TranslationKey[] = [
			key("y"),
			key("x", { from: L("zh-Hans") }),
			key("x", { to: L("de") }),
			key("x", { fingerprint: { ...fp, providerId: "cloud:google-translate-v2" } }),
			key("x", { fingerprint: { ...fp, modelRevision: "ja-en@2/abc" } }),
			key("x", { fingerprint: { ...fp, optionsHash: "o2" } }),
			key("x", { contextHash: "c1" }),
		];
		for (const k of variants) {
			expect(keyHash(k)).not.toBe(keyHash(key("x")));
			expect(cache.get(k)).toBeUndefined();
		}
		expect(cache.get(key("x"))?.text).toBe("X");
	});

	test("empty output is never written", () => {
		const cache = new TranslationCache();
		cache.set(key("x"), value("  "));
		expect(cache.stats().entries).toBe(0);
	});

	test("LRU evicts the least recently used entry by count", () => {
		const cache = new TranslationCache({ maxEntries: 2 });
		cache.set(key("a"), value("A"));
		cache.set(key("b"), value("B"));
		cache.get(key("a")); // a is now most recent
		cache.set(key("c"), value("C"));
		expect(cache.get(key("b"))).toBeUndefined();
		expect(cache.get(key("a"))?.text).toBe("A");
		expect(cache.get(key("c"))?.text).toBe("C");
		expect(cache.stats().evictions).toBe(1);
	});

	test("LRU evicts by bytes", () => {
		const cache = new TranslationCache({ maxBytes: 2000 });
		for (let i = 0; i < 10; i++) cache.set(key(`s${i}`), value("x".repeat(200)));
		const { entries, bytes } = cache.stats();
		expect(bytes).toBeLessThanOrEqual(2000);
		expect(entries).toBeGreaterThan(0);
		expect(entries).toBeLessThan(10);
		expect(cache.get(key("s9"))).toBeDefined();
		expect(cache.get(key("s0"))).toBeUndefined();
	});

	test("a non-storing cache (Private Snip) never reads or writes", () => {
		const cache = new TranslationCache({ store: false });
		cache.set(key("a"), value("A"));
		expect(cache.get(key("a"))).toBeUndefined();
		const flight = cache.lookup(key("a"));
		expect(flight.kind).toBe("claimed");
		if (flight.kind === "claimed") flight.flight.complete(value("A"));
		expect(cache.stats().entries).toBe(0);
	});

	test("dropProvider removes only that provider's entries", () => {
		const cache = new TranslationCache();
		const cloudFp = { ...fp, providerId: "cloud:google-translate-v2" };
		cache.set(key("a"), value("A"));
		cache.set(
			key("b", { fingerprint: cloudFp }),
			value("B", { id: "cloud:google-translate-v2", kind: "cloud", providerId: "cloud:google-translate-v2" }),
		);
		expect(cache.dropProvider("cloud:google-translate-v2")).toBe(1);
		expect(cache.get(key("a"))).toBeDefined();
		expect(cache.get(key("b", { fingerprint: cloudFp }))).toBeUndefined();
	});

	test("cloud results keep their provenance when remembered", () => {
		const cache = new TranslationCache();
		const cloud = { id: "cloud:x", providerId: "cloud:x", kind: "cloud" as const, name: "X Cloud" };
		cache.set(key("a"), value("A", cloud));
		expect(cache.get(key("a"))?.provider).toMatchObject({ kind: "cloud", name: "X Cloud", remembered: true });
	});
});

describe("single-flight", () => {
	test("a second lookup joins the in-flight request and gets its result", async () => {
		const cache = new TranslationCache();
		const first = cache.lookup(key("a"));
		const second = cache.lookup(key("a"));
		expect(first.kind).toBe("claimed");
		expect(second.kind).toBe("pending");
		if (first.kind !== "claimed" || second.kind !== "pending") return;
		first.flight.complete(value("A"));
		expect((await second.promise).text).toBe("A");
		expect(cache.get(key("a"))?.text).toBe("A");
		expect(cache.stats().joins).toBe(1);
	});

	test("failures reach joiners and are not written", async () => {
		const cache = new TranslationCache();
		const first = cache.lookup(key("a"));
		const second = cache.lookup(key("a"));
		if (first.kind !== "claimed" || second.kind !== "pending") throw new Error("unexpected");
		first.flight.fail(new ProviderError("timeout", "slow"));
		await expect(second.promise).rejects.toMatchObject({ code: "timeout" });
		expect(cache.stats().entries).toBe(0);
		// The key is free again.
		expect(cache.lookup(key("a")).kind).toBe("claimed");
	});

	test("a joiner that cancels detaches; the shared request keeps going for the others", async () => {
		const cache = new TranslationCache();
		const claimant = new AbortController();
		const joiner = new AbortController();
		const first = cache.lookup(key("a"), { signal: claimant.signal });
		const second = cache.lookup(key("a"), { signal: joiner.signal });
		if (first.kind !== "claimed" || second.kind !== "pending") throw new Error("unexpected");
		joiner.abort();
		expect(isProviderError(await second.promise.catch((e: unknown) => e), "cancelled")).toBe(true);
		expect(first.flight.signal.aborted).toBe(false);
		first.flight.complete(value("A"));
		expect(cache.get(key("a"))?.text).toBe("A");
	});

	test("the claimant cancelling keeps the request alive while a joiner waits", async () => {
		const cache = new TranslationCache();
		const claimant = new AbortController();
		const first = cache.lookup(key("a"), { signal: claimant.signal });
		const second = cache.lookup(key("a"), { signal: new AbortController().signal });
		if (first.kind !== "claimed" || second.kind !== "pending") throw new Error("unexpected");
		claimant.abort();
		expect(first.flight.signal.aborted).toBe(false);
		first.flight.complete(value("A"));
		expect((await second.promise).text).toBe("A");
	});

	test("when every waiter leaves, the flight's signal fires and nothing is written", () => {
		const cache = new TranslationCache();
		const a = new AbortController();
		const b = new AbortController();
		const first = cache.lookup(key("a"), { signal: a.signal });
		const second = cache.lookup(key("a"), { signal: b.signal });
		if (first.kind !== "claimed" || second.kind !== "pending") throw new Error("unexpected");
		second.promise.catch(() => {});
		a.abort();
		b.abort();
		expect(first.flight.signal.aborted).toBe(true);
		expect(first.flight.settled).toBe(true);
		first.flight.complete(value("A")); // too late: ignored
		expect(cache.stats().entries).toBe(0);
	});

	test("clear() during a flight stops its result from being written", () => {
		const cache = new TranslationCache();
		const first = cache.lookup(key("a"));
		if (first.kind !== "claimed") throw new Error("unexpected");
		cache.clear("user");
		first.flight.complete(value("A"));
		expect(cache.stats().entries).toBe(0);
	});

	test("bypass (Retranslate) skips the entry and overwrites it", () => {
		const cache = new TranslationCache();
		cache.set(key("a"), value("old"));
		const fresh = cache.lookup(key("a"), { bypass: true });
		if (fresh.kind !== "claimed") throw new Error("unexpected");
		fresh.flight.complete(value("new"));
		expect(cache.get(key("a"))?.text).toBe("new");
	});

	test("getOrTranslate runs once for concurrent callers", async () => {
		const cache = new TranslationCache();
		let runs = 0;
		const run = async () => {
			runs++;
			await Bun.sleep(5);
			return value("A");
		};
		const [x, y] = await Promise.all([cache.getOrTranslate(key("a"), run), cache.getOrTranslate(key("a"), run)]);
		expect(runs).toBe(1);
		expect(x.text).toBe("A");
		expect(y.text).toBe("A");
		expect((await cache.getOrTranslate(key("a"), run)).provider.remembered).toBe(true);
		expect(runs).toBe(1);
	});
});

describe("TranslationCaches (scopes and wipes)", () => {
	const make = (over: { idleMinutes?: number } = {}) => {
		const clock = new ManualClock(1_000_000);
		const wipes: string[] = [];
		const caches = new TranslationCaches({ now: clock.now, onClear: (r) => wipes.push(r), ...over });
		return { clock, caches, wipes };
	};

	test("Private Snip: the app cache is neither read nor written", () => {
		const { caches } = make();
		caches.app.set(key("a"), value("A"));
		const priv = caches.forSnip(true);
		expect(priv).not.toBe(caches.app);
		expect(priv.get(key("a"))).toBeUndefined();
		priv.set(key("b"), value("B"));
		expect(caches.app.get(key("b"))).toBeUndefined();
		expect(caches.forSnip(false)).toBe(caches.app);
	});

	test("Private Live session: isolated cache, dropped on close", () => {
		const { caches } = make();
		caches.app.set(key("a"), value("A"));
		const session = caches.openSession(true);
		expect(session.cache.get(key("a"))).toBeUndefined();
		session.cache.set(key("b"), value("B"));
		expect(session.cache.get(key("b"))?.text).toBe("B");
		expect(caches.app.get(key("b"))).toBeUndefined();
		expect(caches.stats().privateSessions).toBe(1);
		session.close();
		expect(session.cache.stats().entries).toBe(0);
		expect(caches.stats().privateSessions).toBe(0);
		expect(caches.openSession(false).cache).toBe(caches.app);
	});

	test("clear('user') wipes the app cache and every session cache", () => {
		const { caches, wipes } = make();
		const session = caches.openSession(true);
		caches.app.set(key("a"), value("A"));
		session.cache.set(key("b"), value("B"));
		caches.clear("user");
		expect(caches.app.stats().entries).toBe(0);
		expect(session.cache.stats().entries).toBe(0);
		expect(wipes).toEqual(["user"]);
	});

	test("idle wipe after 15 minutes without activity", () => {
		const { caches, clock, wipes } = make();
		caches.app.set(key("a"), value("A"));
		for (let t = 0; t < 14 * 2; t++) {
			clock.advance(30_000);
			expect(caches.tick()).toBeNull();
		}
		clock.advance(30_000);
		clock.advance(30_000);
		expect(caches.tick()).toBe("idle");
		expect(caches.app.stats().entries).toBe(0);
		expect(wipes).toEqual(["idle"]);
	});

	test("activity and open Live sessions postpone the idle wipe", () => {
		const { caches, clock } = make();
		caches.app.set(key("a"), value("A"));
		const session = caches.openSession(false);
		for (let i = 0; i < 60; i++) {
			clock.advance(30_000);
			expect(caches.tick()).toBeNull();
		}
		session.close();
		for (let i = 0; i < 20; i++) {
			clock.advance(30_000);
			caches.noteActivity();
			expect(caches.tick()).toBeNull();
		}
		expect(caches.app.stats().entries).toBe(1);
	});

	test("idle 0 means only on quit", () => {
		const { caches, clock } = make({ idleMinutes: 0 });
		caches.app.set(key("a"), value("A"));
		for (let i = 0; i < 200; i++) {
			clock.advance(30_000);
			caches.tick();
		}
		expect(caches.app.stats().entries).toBe(1);
	});

	test("a wall-clock jump between ticks (system sleep) wipes the cache", () => {
		const { caches, clock, wipes } = make({ idleMinutes: 0 });
		caches.app.set(key("a"), value("A"));
		clock.advance(30_000);
		expect(caches.tick()).toBeNull();
		clock.advance(10 * 60_000);
		expect(caches.tick()).toBe("sleep");
		expect(caches.app.stats().entries).toBe(0);
		expect(wipes).toEqual(["sleep"]);
	});
});
