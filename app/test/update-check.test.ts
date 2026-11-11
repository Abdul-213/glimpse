// GLIM-70: the update checker (fake fetch, temp state file), the tray item and Settings.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_RELEASE_URL, nullLogger, RELEASES_PAGE_URL, UPDATE_CHECK_INTERVAL_MS } from "@glimpse/core";
import {
	fileUpdateStateStore,
	UPDATE_STATE_FILE,
	UpdateChecker,
	type UpdateCheckerDeps,
} from "../src/bun/services/update-check.ts";
import { buildTrayMenu, type TrayState } from "../src/bun/tray-menu.ts";

const tmp = mkdtempSync(join(tmpdir(), "glimpse-updates-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const latest = (tag: string) => ({
	tag_name: tag,
	html_url: `${RELEASES_PAGE_URL}/tag/${tag}`,
	draft: false,
	prerelease: false,
});

function setup(reply: () => Response | Promise<Response>, opts: Partial<UpdateCheckerDeps> = {}) {
	const dir = mkdtempSync(join(tmp, "case-"));
	let now = 1_800_000_000_000;
	let enabled = true;
	const calls: { url: string; init: RequestInit }[] = [];
	const checker = new UpdateChecker({
		currentVersion: "0.1.0",
		enabled: () => enabled,
		store: fileUpdateStateStore(dir),
		fetch: async (url, init) => {
			calls.push({ url, init });
			return reply();
		},
		now: () => now,
		log: nullLogger,
		...opts,
	});
	return {
		dir,
		checker,
		calls,
		advance: (ms: number) => {
			now += ms;
		},
		setEnabled: (v: boolean) => {
			enabled = v;
		},
	};
}

describe("UpdateChecker", () => {
	test("finds a newer release, at most once a day, and remembers it across runs", async () => {
		const t = setup(() => Response.json(latest("v0.2.0")));
		const seen: string[] = [];
		t.checker.subscribe((s) => seen.push(s.state));
		const s = await t.checker.checkIfDue();
		expect(s).toMatchObject({ state: "available", release: { version: "0.2.0" } });
		expect(t.calls.length).toBe(1);
		expect(t.calls[0]?.url).toBe(LATEST_RELEASE_URL);
		const headers = t.calls[0]?.init.headers as Record<string, string>;
		expect(headers["User-Agent"]).toBe("Glimpse/0.1.0");
		expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent", "X-GitHub-Api-Version"]);

		await t.checker.checkIfDue();
		t.advance(UPDATE_CHECK_INTERVAL_MS - 1);
		await t.checker.checkIfDue();
		expect(t.calls.length).toBe(1);
		t.advance(1);
		await t.checker.checkIfDue();
		expect(t.calls.length).toBe(2);
		expect(seen.at(-1)).toBe("available");

		// A new run reads the state file: no request, still shows the update.
		const again = new UpdateChecker({
			currentVersion: "0.1.0",
			enabled: () => true,
			store: fileUpdateStateStore(t.dir),
			fetch: () => Promise.reject(new Error("must not fetch")),
			now: () => 1_800_000_000_000 + UPDATE_CHECK_INTERVAL_MS + 10,
			log: nullLogger,
		});
		expect((await again.checkIfDue()).state).toBe("available");
		expect(JSON.parse(readFileSync(join(t.dir, UPDATE_STATE_FILE), "utf8")).latest.version).toBe("0.2.0");
	});

	test("the same or an older release is not an update", async () => {
		const t = setup(() => Response.json(latest("v0.1.0")));
		expect((await t.checker.checkIfDue()).state).toBe("current");
	});

	test("fails quietly: 404 (private repo / no release), offline, garbage; each counts as the day's check", async () => {
		for (const reply of [
			() => new Response('{"message":"Not Found"}', { status: 404 }),
			() => new Response("rate limited", { status: 403 }),
			() => Promise.reject(new TypeError("fetch failed")),
			() => new Response("<html>", { status: 200 }),
		]) {
			const t = setup(reply);
			expect((await t.checker.checkIfDue()).state).toBe("current");
			await t.checker.checkIfDue();
			expect(t.calls.length).toBe(1);
		}
	});

	test("off: no request, status off; turning it back on shows what was found before", async () => {
		const t = setup(() => Response.json(latest("v0.2.0")));
		await t.checker.checkIfDue();
		t.setEnabled(false);
		t.checker.settingsChanged();
		t.advance(2 * UPDATE_CHECK_INTERVAL_MS);
		expect((await t.checker.checkIfDue()).state).toBe("off");
		expect(t.calls.length).toBe(1);
		t.setEnabled(true);
		expect(t.checker.status.state).toBe("available");
	});

	test("concurrent ticks share one request; a broken state file is ignored", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const t = setup(async () => {
			await gate;
			return Response.json(latest("v0.3.0"));
		});
		writeFileSync(join(t.dir, UPDATE_STATE_FILE), "{not json");
		const a = t.checker.checkIfDue();
		const b = t.checker.checkIfDue();
		release();
		expect((await a).state).toBe("available");
		expect((await b).state).toBe("available");
		expect(t.calls.length).toBe(1);
	});
});

describe("tray", () => {
	const base: TrayState = {
		platform: "windows",
		live: "off",
		private: false,
		translation: null,
		hotkeys: { snip: null, live: null },
		taskbarTheme: "dark",
	};
	test("a newer release adds one item that opens its page; none otherwise", () => {
		const menu = buildTrayMenu({ ...base, update: { version: "0.2.0" } });
		const item = menu.find((m) => m.type === "normal" && m.action === "update.open");
		expect(item).toMatchObject({ label: "Download Glimpse 0.2.0…" });
		expect(buildTrayMenu(base).some((m) => m.type === "normal" && m.action === "update.open")).toBe(false);
		expect(buildTrayMenu({ ...base, update: null })).toEqual(buildTrayMenu(base));
	});
});
