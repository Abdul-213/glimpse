// GLIM-70: update notification, pure parts.
import { describe, expect, test } from "bun:test";
import {
	compareReleaseVersions,
	EMPTY_UPDATE_STATE,
	isCheckDue,
	parseLatestRelease,
	parseUpdateCheckState,
	RELEASES_PAGE_URL,
	UPDATE_CHECK_INTERVAL_MS,
	updateStatus,
} from "../src/index.ts";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
	tag_name: tag,
	html_url: `${RELEASES_PAGE_URL}/tag/${tag}`,
	draft: false,
	prerelease: false,
	...extra,
});

describe("compareReleaseVersions", () => {
	test("semver order, with or without v; pre-releases sort before the release", () => {
		expect(compareReleaseVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
		expect(compareReleaseVersions("v1.0.0", "1.0.0")).toBe(0);
		expect(compareReleaseVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareReleaseVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
		expect(compareReleaseVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
		expect(compareReleaseVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
		expect(compareReleaseVersions("1.0.0+build.5", "1.0.0")).toBe(0);
		expect(compareReleaseVersions("latest", "1.0.0")).toBeNull();
	});
});

describe("parseLatestRelease", () => {
	test("takes a published release; drops drafts, prereleases, odd tags and foreign links", () => {
		expect(parseLatestRelease(release("v0.2.0"))).toEqual({
			version: "0.2.0",
			url: `${RELEASES_PAGE_URL}/tag/v0.2.0`,
		});
		expect(parseLatestRelease(release("v0.2.0", { draft: true }))).toBeNull();
		expect(parseLatestRelease(release("v0.2.0", { prerelease: true }))).toBeNull();
		expect(parseLatestRelease(release("nightly"))).toBeNull();
		expect(parseLatestRelease(release("v0.2.0", { html_url: "https://evil.example/x" }))).toBeNull();
		expect(parseLatestRelease({ message: "Not Found" })).toBeNull();
		expect(parseLatestRelease(null)).toBeNull();
	});
});

describe("isCheckDue", () => {
	const now = 1_800_000_000_000;
	test("at most once a day, never when off; a clock set back counts as due", () => {
		expect(isCheckDue(EMPTY_UPDATE_STATE, now, true)).toBe(true);
		expect(isCheckDue(EMPTY_UPDATE_STATE, now, false)).toBe(false);
		expect(isCheckDue({ lastCheckAt: now - 1000, latest: null }, now, true)).toBe(false);
		expect(isCheckDue({ lastCheckAt: now - UPDATE_CHECK_INTERVAL_MS, latest: null }, now, true)).toBe(true);
		expect(isCheckDue({ lastCheckAt: now + 60_000, latest: null }, now, true)).toBe(true);
	});
});

describe("updateStatus", () => {
	const latest = { version: "0.2.0", url: `${RELEASES_PAGE_URL}/tag/v0.2.0` };
	test("available only when newer and enabled", () => {
		expect(updateStatus({ lastCheckAt: 5, latest }, "0.1.0", true)).toEqual({
			state: "available",
			release: latest,
			lastCheckAt: 5,
		});
		expect(updateStatus({ lastCheckAt: 5, latest }, "0.2.0", true)).toEqual({ state: "current", lastCheckAt: 5 });
		expect(updateStatus({ lastCheckAt: 5, latest }, "0.3.0", true).state).toBe("current");
		expect(updateStatus({ lastCheckAt: 5, latest }, "0.1.0", false)).toEqual({ state: "off" });
	});
});

describe("parseUpdateCheckState", () => {
	test("repairs whatever is on disk", () => {
		const good = { lastCheckAt: 7, latest: { version: "0.2.0", url: `${RELEASES_PAGE_URL}/tag/v0.2.0` } };
		expect(parseUpdateCheckState(good)).toEqual(good);
		expect(parseUpdateCheckState({ lastCheckAt: "x", latest: { version: "0.2.0", url: "file:///x" } })).toEqual(
			EMPTY_UPDATE_STATE,
		);
		expect(parseUpdateCheckState([])).toEqual(EMPTY_UPDATE_STATE);
	});
});
