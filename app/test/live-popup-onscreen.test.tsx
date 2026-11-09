// GLIM-163: the Live strip's On screen toggle. Once consent is answered it is always there;
// when the frame can't draw the cards it is disabled (still focusable) and its tooltip says why.
import "../../packages/ui/test/dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
	initialLivePopupState,
	type LivePopupState,
	type LiveSessionEvent,
	rect,
	reduceLivePopup,
} from "@glimpse/core";
import { render } from "solid-js/web";
import type { LiveMarksUnavailable, LiveStateMessage, LiveViewInit } from "../src/shared/live-rpc.ts";
import { COPY, onScreenUnavailable } from "../src/views/live/copy.ts";
import { LivePopup, type LivePopupIntents } from "../src/views/live/LivePopup.tsx";

const S = "s1";
const INIT: LiveViewInit = {
	os: "windows",
	uiLang: "en",
	uiDir: "ltr",
	keys: {
		pause: "Ctrl+Shift+P",
		stop: "Ctrl+W",
		copy: "Ctrl+C",
		copyOriginal: "Ctrl+Shift+C",
		original: "Ctrl+Shift+O",
		focus: null,
		overlay: "Ctrl+Shift+T",
	},
};

function stateAfter(events: LiveSessionEvent[]): LivePopupState {
	return events.reduce((s, event) => reduceLivePopup(s, { type: "session", event }), initialLivePopupState);
}

const opened: LiveSessionEvent = {
	type: "opened",
	sessionId: S,
	region: rect(100, 100, 400, 200),
	providers: { cloud: null, localOnly: false },
	private: false,
};

function message(
	state: LivePopupState,
	extra: { marks?: LiveStateMessage["marks"]; marksUnavailable?: LiveMarksUnavailable; width?: number } = {},
): LiveStateMessage {
	return {
		sessionId: S,
		layout: { side: "inline-end", width: extra.width ?? 360, maxHeight: 400 },
		state,
		reducedMotion: true,
		now: 0,
		focused: false,
		...(extra.marks ? { marks: extra.marks } : {}),
		...(extra.marksUnavailable ? { marksUnavailable: extra.marksUnavailable } : {}),
	};
}

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
});

function mount(msg: LiveStateMessage) {
	const overlay: boolean[] = [];
	const noop = () => {};
	const intents: LivePopupIntents = {
		painted: noop,
		resized: noop,
		pause: noop,
		resume: noop,
		stop: noop,
		repin: noop,
		setPrivate: noop,
		consent: noop,
		hoverBlock: noop,
		pointerEntered: noop,
		blurred: noop,
		copy: noop,
		skipped: noop,
		overlay: (_id, on) => overlay.push(on),
	};
	const root = document.createElement("div");
	document.body.append(root);
	dispose = render(() => <LivePopup init={INIT} message={msg} intents={intents} raf={(cb) => cb()} />, root);
	const toggle = () =>
		[...root.querySelectorAll<HTMLButtonElement>("button.glim-toggle-btn")].find((b) =>
			b.textContent?.includes(COPY.onScreen),
		);
	return { root, overlay, toggle };
}

describe("Live On screen toggle (GLIM-163)", () => {
	const running = stateAfter([opened]);

	test("marks available: enabled, toggles the overlay", () => {
		const { toggle, overlay } = mount(message(running, { marks: { scale: 2, target: "en" } }));
		const t = toggle();
		expect(t).toBeDefined();
		expect(t?.getAttribute("aria-disabled")).toBeNull();
		expect(t?.getAttribute("aria-pressed")).toBe("false");
		t?.click();
		expect(overlay).toEqual([true]);
	});

	test("frame not out of capture: still shown, disabled but focusable, clicks do nothing", () => {
		const { toggle, overlay } = mount(message(running, { marksUnavailable: "not-excluded" }));
		const t = toggle();
		expect(t).toBeDefined();
		expect(t?.getAttribute("aria-disabled")).toBe("true");
		expect(t?.disabled).toBe(false);
		expect(t?.getAttribute("aria-pressed")).toBe("false");
		t?.focus();
		expect(document.activeElement).toBe(t ?? null);
		t?.click();
		expect(overlay).toEqual([]);
	});

	test("its tooltip says why (keyboard focus opens it)", async () => {
		const t = mount(message(running, { marksUnavailable: "not-excluded" })).toggle();
		t?.dispatchEvent(new FocusEvent("focus"));
		t?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		t?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
		await new Promise((r) => setTimeout(r, 700));
		const tip = document.querySelector(".glim-tooltip");
		expect(tip?.textContent).toBe(COPY.onScreenNotExcluded);
	});

	test("overlay on by setting but no marks: not shown as pressed", () => {
		const on = reduceLivePopup(running, { type: "toggleOverlay", on: true });
		const t = mount(message(on, { marksUnavailable: "no-frame" })).toggle();
		expect(t?.getAttribute("aria-disabled")).toBe("true");
		expect(t?.getAttribute("aria-pressed")).toBe("false");
	});

	test("compact strip: still there", () => {
		const t = mount(message(running, { marksUnavailable: "not-excluded", width: 240 })).toggle();
		expect(t).toBeDefined();
	});

	test("before consent is answered: no toggle", () => {
		const asking = stateAfter([
			opened,
			{
				type: "consent",
				sessionId: S,
				providers: [{ id: "deepl", kind: "cloud", name: "DeepL" }],
				canRemember: true,
				reason: "cloud-translation",
				localAvailable: true,
			},
		]);
		expect(asking.status).toBe("consent");
		expect(mount(message(asking, { marksUnavailable: "not-excluded" })).toggle()).toBeUndefined();
	});

	test("the reason, in plain words", () => {
		expect(onScreenUnavailable("not-excluded")).toBe(
			"On screen isn't available here: Glimpse can't hide its overlay from its own capture",
		);
		expect(onScreenUnavailable("no-frame")).toContain("isn't available here");
		expect(onScreenUnavailable(undefined)).toBe("On screen isn't available yet");
	});
});
