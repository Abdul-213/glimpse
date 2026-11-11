// GLIM-130: optional global shortcuts for Live (pause / resume, show / hide the popup, focus
// the popup). Unbound by default; once bound in Settings › Shortcuts they register through the
// hotkey service and dispatch the same commands as the tray.
import { describe, expect, test } from "bun:test";
import { DEFAULT_HOTKEYS, type HotkeyBindings, nullLogger } from "@glimpse/core";
import { type HotkeyBackend, HotkeyService } from "../src/bun/services/hotkeys.ts";
import { HOTKEY_ACTIONS, liveHotkeyHandlers, ServiceHotkeyRegistrar } from "../src/bun/services/hotkeys-port.ts";

describe("Live shortcuts (GLIM-130)", () => {
	test("unbound by default on both OSes", () => {
		for (const os of ["windows", "macos"] as const) {
			const d = DEFAULT_HOTKEYS[os];
			expect([d.pauseLive, d.toggleLivePopup, d.focusLivePopup]).toEqual([null, null, null]);
		}
		expect(HOTKEY_ACTIONS).toContain("focusLivePopup");
	});

	test("handlers dispatch the tray's commands; pause toggles; nothing while no area is pinned", () => {
		const sent: string[] = [];
		let state = { active: false, paused: false };
		const h = liveHotkeyHandlers(
			(c) => sent.push(c),
			() => state,
		);
		h.pauseLive?.();
		h.toggleLivePopup?.();
		h.focusLivePopup?.();
		expect(sent).toEqual([]);
		state = { active: true, paused: false };
		h.pauseLive?.();
		state = { active: true, paused: true };
		h.pauseLive?.();
		h.toggleLivePopup?.();
		h.focusLivePopup?.();
		expect(sent).toEqual(["live.pause", "live.resume", "live.popup.toggle", "live.popup.focus"]);
	});

	test("a bound Live shortcut registers with the backend and reports ready", async () => {
		const registered: string[] = [];
		const backend: HotkeyBackend = {
			name: "fake",
			register: (combo) => {
				registered.push(combo);
				return { ok: true, detail: "ok" };
			},
			unregister: () => {},
			dispose: () => {},
		};
		const service = new HotkeyService(backend, nullLogger);
		const registrar = new ServiceHotkeyRegistrar(service, {
			...liveHotkeyHandlers(
				() => {},
				() => ({ active: true, paused: false }),
			),
		});
		const bindings: HotkeyBindings = {
			...DEFAULT_HOTKEYS.windows,
			snip: null,
			live: null,
			focusLivePopup: "Alt+Shift+F",
		};
		const status = await registrar.apply(bindings);
		expect(status.focusLivePopup).toEqual({ state: "ready" });
		expect(status.pauseLive).toEqual({ state: "unbound" });
		expect(registered).toEqual(["Alt+Shift+F"]);
	});
});
