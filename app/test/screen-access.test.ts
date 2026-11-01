import { describe, expect, test } from "bun:test";
import type { ScreenAccessMemory } from "@glimpse/core";
import { COMMANDS } from "../src/bun/commands.ts";
import {
	relaunchCommand,
	ScreenAccess,
	type ScreenAccessOS,
	screenAccessNotice,
} from "../src/bun/services/screen-access.ts";
import { buildTrayMenu, type TrayState } from "../src/bun/tray-menu.ts";
import { screenAccessCopy } from "../src/views/onboarding/copy.ts";

function fakeOS(over: Partial<ScreenAccessOS> & { granted?: boolean } = {}) {
	const calls: string[] = [];
	let granted = over.granted ?? false;
	const os: ScreenAccessOS = {
		required: over.required ?? true,
		canRestart: over.canRestart ?? true,
		preflight: () => granted,
		request: () => calls.push("request"),
		openSettings: () => {
			calls.push("open");
			return true;
		},
		scheduleRelaunch: () => {
			calls.push("relaunch");
			return true;
		},
	};
	return { os, calls, grant: (v = true) => (granted = v) };
}

function make(initial: ScreenAccessMemory = "unknown", over: Parameters<typeof fakeOS>[0] = {}) {
	const f = fakeOS(over);
	let memory = initial;
	const quits: number[] = [];
	const access = new ScreenAccess({
		os: f.os,
		memory: () => memory,
		saveMemory: async (m) => {
			memory = m;
		},
		quit: () => quits.push(1),
	});
	return { ...f, access, memory: () => memory, quits };
}

describe("GLIM-45 ScreenAccess service", () => {
	test("first run: the request shows the system prompt once and is remembered", () => {
		const t = make();
		expect(t.access.status().state).toBe("not-determined");
		const after = t.access.request();
		expect(t.calls).toEqual(["request"]);
		expect(t.memory()).toBe("requested");
		expect(after.state).toBe("denied");
		expect(after.settingsOpened).toBe(false);
		// The prompt won't show again: the next request opens System Settings.
		const again = t.access.request();
		expect(t.calls).toEqual(["request", "open"]);
		expect(again.settingsOpened).toBe(true);
	});

	test("a grant is remembered, and losing it later is 'lost'", () => {
		const t = make("requested");
		t.grant();
		expect(t.access.refresh().state).toBe("granted");
		expect(t.memory()).toBe("granted");
		t.grant(false);
		expect(t.access.refresh().state).toBe("lost");
		expect(t.access.canCapture).toBe(false);
	});

	test("subscribers hear about changes only", () => {
		const t = make("requested");
		const seen: string[] = [];
		t.access.refresh();
		t.access.subscribe((s) => seen.push(s.state));
		t.access.refresh();
		t.grant();
		t.access.refresh();
		t.access.refresh();
		expect(seen).toEqual(["granted"]);
	});

	test("capture refused while preflight is cached true: lost", () => {
		const t = make("granted", { granted: true });
		expect(t.access.canCapture).toBe(true);
		t.access.reportCaptureDenied();
		expect(t.access.state).toBe("lost");
	});

	test("restart schedules the relaunch, then quits", () => {
		const t = make("requested");
		expect(t.access.restart()).toBe(true);
		expect(t.calls).toEqual(["relaunch"]);
		expect(t.quits).toEqual([1]);
		const n = make("requested", { canRestart: false });
		expect(n.access.restart()).toBe(false);
		expect(n.quits).toEqual([]);
	});

	test("Windows: nothing to ask, nothing remembered", () => {
		const t = make("unknown", { required: false });
		expect(t.access.request().state).toBe("not-needed");
		expect(t.calls).toEqual([]);
		expect(t.memory()).toBe("unknown");
		expect(t.access.canCapture).toBe(true);
	});

	test("the relaunch helper waits for this pid, then opens the bundle", () => {
		const cmd = relaunchCommand("/Applications/Glimpse.app", 4242);
		expect(cmd.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(cmd.slice(3)).toEqual(["glimpse-relaunch", "4242", "/Applications/Glimpse.app"]);
		expect(cmd[2]).toContain('kill -0 "$1"');
		expect(cmd[2]).toContain('exec /usr/bin/open "$2"');
	});
});

describe("GLIM-45 tray notice", () => {
	const base: TrayState = {
		platform: "macos",
		live: "off",
		private: false,
		translation: null,
		hotkeys: { snip: null, live: null },
		taskbarTheme: "dark",
	};

	test("listed first while capture is blocked", () => {
		expect(COMMANDS).toContain("screen-access.open");
		const notice = screenAccessNotice("lost");
		expect(notice).not.toBeNull();
		const menu = buildTrayMenu({ ...base, notices: notice ? [notice] : [] });
		expect(menu[0]).toEqual({ type: "normal", label: "Allow Screen Access…", action: "screen-access.open" });
		expect(menu[1]).toEqual({ type: "divider" });
	});

	test("no notice when capture works", () => {
		expect(screenAccessNotice("granted")).toBeNull();
		expect(screenAccessNotice("not-needed")).toBeNull();
		expect(buildTrayMenu(base)[0]).toMatchObject({ enabled: false });
	});
});

describe("GLIM-45 screen-access copy", () => {
	test("every state has one primary action", () => {
		const s = (state: Parameters<typeof screenAccessCopy>[0]["state"], settingsOpened = false, canRestart = true) =>
			screenAccessCopy({ state, settingsOpened, canRestart });
		expect(s("not-determined").primary.action).toBe("request");
		expect(s("denied").primary.action).toBe("open-settings");
		expect(s("denied", true).primary.action).toBe("restart");
		expect(s("denied", true, false).primary.action).toBe("open-settings");
		expect(s("lost").primary.action).toBe("open-settings");
		expect(s("lost").banner?.body).toContain("switch it off and on again");
		expect(s("lost", true).primary.action).toBe("restart");
		expect(s("granted").primary.action).toBe("done");
		expect(s("not-needed").primary.action).toBe("done");
	});
});
