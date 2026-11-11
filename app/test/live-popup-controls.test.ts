// GLIM-81: Live popup controls. The keyboard map (live-popup.md §6.2), focus handed back when a
// control click activates Glimpse anyway (§7.2), Focus Live popup, Hide / Show (L19) and manual
// copy.
import { describe, expect, test } from "bun:test";
import { type LiveSessionEvent, type LiveSessionListener, nullLogger, type Rect, rect } from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import { LivePopupController, type LivePopupSession } from "../src/bun/windows/live-popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";
import { liveKey } from "../src/views/live/keys.ts";

const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
	key,
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...mods,
});

describe("liveKey (§6.2)", () => {
	test("Windows: Ctrl", () => {
		expect(liveKey(k("Escape"), false)).toBe("escape");
		expect(liveKey(k("P", { ctrlKey: true, shiftKey: true }), false)).toBe("pause");
		expect(liveKey(k("w", { ctrlKey: true }), false)).toBe("stop");
		expect(liveKey(k("c", { ctrlKey: true }), false)).toBe("copy");
		expect(liveKey(k("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copyOriginal");
		expect(liveKey(k("O", { ctrlKey: true, shiftKey: true }), false)).toBe("original");
		expect(liveKey(k("p", { ctrlKey: true }), false)).toBeNull();
		expect(liveKey(k("w", { metaKey: true }), false)).toBeNull();
		expect(liveKey(k("w", { ctrlKey: true, altKey: true }), false)).toBeNull();
	});
	test("macOS: ⌘", () => {
		expect(liveKey(k("p", { metaKey: true, shiftKey: true }), true)).toBe("pause");
		expect(liveKey(k("w", { metaKey: true }), true)).toBe("stop");
		expect(liveKey(k("w", { ctrlKey: true }), true)).toBeNull();
	});
	test("GLIM-157: Ctrl/⌘R refreshes", () => {
		expect(liveKey(k("r", { ctrlKey: true }), false)).toBe("refresh");
		expect(liveKey(k("r", { metaKey: true }), true)).toBe("refresh");
		expect(liveKey(k("R", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
	});
});

class Session implements LivePopupSession {
	active = true;
	calls: string[] = [];
	#l: LiveSessionListener | null = null;
	onEvent(l: LiveSessionListener) {
		this.#l = l;
		return () => {};
	}
	emit(e: LiveSessionEvent) {
		this.#l?.(e);
	}
	pause() {
		this.calls.push("pause");
	}
	resume() {
		this.calls.push("resume");
	}
	stop() {
		this.calls.push("stop");
	}
	answerConsent() {}
	highlightBlock() {}
	visible: boolean[] = [];
	setPopupVisible(v: boolean) {
		this.visible.push(v);
	}
}

function setup() {
	const calls: string[] = [];
	const window = {
		setFrame: (_: Rect) => {},
		showInactive: () => calls.push("showInactive"),
		activate: () => calls.push("activate"),
		hide: () => calls.push("hide"),
		send: () => {},
		focusControls: () => calls.push("focusControls"),
	};
	const live = new Session();
	const focus = new RecordingFocusKeeper();
	const copied: string[] = [];
	const c = new LivePopupController({
		window,
		live,
		displays: () => [
			{ id: 1, bounds: rect(0, 0, 1440, 900), workArea: rect(0, 0, 1440, 900), scaleFactor: 1, isPrimary: true },
		],
		settings: () => ({ reducedMotion: true, uiDir: "ltr" }),
		setPrivate: () => {},
		repin: () => calls.push("repin"),
		focus,
		clipboard: { writeText: (t) => copied.push(t) },
		eol: "\r\n",
		log: nullLogger,
		scheduler: new ManualScheduler(),
	});
	live.emit({
		type: "opened",
		sessionId: "s",
		region: rect(100, 100, 600, 100),
		providers: { cloud: null, localOnly: false },
		private: false,
	});
	c.painted("s");
	return { c, calls, live, focus, copied };
}

describe("LivePopupController controls (GLIM-81)", () => {
	test("a control click that activates Glimpse anyway hands focus straight back (§7.2)", () => {
		const { c, focus } = setup();
		c.pointerEntered("s");
		expect(focus.calls).toEqual(["save"]);
		c.windowFocused();
		expect(focus.calls).toEqual(["save", "restore"]);
		// Without a pointer-enter first (nothing saved) there's nothing to hand back.
		c.windowFocused();
		expect(focus.calls).toEqual(["save", "restore"]);
	});

	test("Focus Live popup takes keyboard focus on purpose; Esc gives it back", () => {
		const { c, calls, focus } = setup();
		expect(c.focusPopup()).toBe(true);
		expect(calls).toEqual(["showInactive", "activate", "focusControls"]);
		c.windowFocused(); // the activation we asked for: not undone
		expect(focus.calls).toEqual(["save"]);
		c.blurred("s");
		expect(focus.calls).toEqual(["save", "restore"]);
	});

	test("Hide / Show popup: the session keeps running, the frame's tag follows", () => {
		const { c, calls, live } = setup();
		c.setHidden(true);
		expect(calls.at(-1)).toBe("hide");
		expect(live.visible.at(-1)).toBe(false);
		expect(live.calls).toEqual([]);
		c.setHidden(false);
		expect(calls.at(-1)).toBe("showInactive");
		expect(live.visible.at(-1)).toBe(true);
	});

	test("Re-pin hands focus back first; Stop unpins", () => {
		const { c, calls, live } = setup();
		c.repin("s");
		c.stop("s");
		expect(calls).toContain("repin");
		expect(live.calls).toEqual(["stop"]);
	});

	test("copy: only on request, translations (or originals) in reading order, OS line ends", () => {
		const { c, live, copied } = setup();
		const b = (id: string, source: string, translation: string | null, order: number) => ({
			id,
			order,
			cls: "translate" as const,
			lang: null,
			direction: "ltr" as const,
			box: rect(0, 0, 1, 1),
			source,
			translation,
			failed: false,
			waitingForPack: false,
			changed: false,
		});
		live.emit({
			type: "frame",
			sessionId: "s",
			frameSeq: 1,
			upserts: [b("a", "uno", "one", 0), b("b", "dos", "two", 1)],
			removes: [],
			order: ["a", "b"],
			changeSet: [],
			capturedAt: 0,
			reused: false,
			region: rect(100, 100, 600, 100),
			image: { width: 600, height: 100 },
		});
		expect(copied).toEqual([]);
		c.copy("s", "translation");
		c.copy("s", "original");
		expect(copied).toEqual(["one\r\n\r\ntwo", "uno\r\n\r\ndos"]);
	});
});
