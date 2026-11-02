// GLIM-131: the Live skipped line's actions. "Translate these" hands the skipped blocks'
// languages to the session (session-only); "Edit source languages…" opens Settings › Languages
// and hands focus back. Other sessions' intents are ignored.
import { describe, expect, test } from "bun:test";
import { type LiveSessionEvent, type LiveSessionListener, languageCode, nullLogger, rect } from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import { LivePopupController, type LivePopupSession } from "../src/bun/windows/live-popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";

class FakeSession implements LivePopupSession {
	readonly included: string[][] = [];
	active = true;
	#l: LiveSessionListener | null = null;
	onEvent(l: LiveSessionListener) {
		this.#l = l;
		return () => {
			this.#l = null;
		};
	}
	emit(e: LiveSessionEvent) {
		this.#l?.(e);
	}
	pause() {}
	resume() {}
	stop() {}
	answerConsent() {}
	highlightBlock() {}
	setPopupVisible() {}
	includeLanguages(langs: readonly string[]) {
		this.included.push([...langs]);
	}
}

const REGION = rect(120, 760, 1200, 100);
const up = (id: string, cls: "translate" | "skip", lang: string) => ({
	id,
	order: 0,
	cls,
	lang: languageCode(lang),
	direction: "ltr" as const,
	box: rect(0, 0, 10, 10),
	source: id,
	translation: null,
	failed: false,
	waitingForPack: false,
	changed: false,
});

function setup() {
	const live = new FakeSession();
	const opened: string[] = [];
	const c = new LivePopupController({
		window: { setFrame() {}, showInactive() {}, activate() {}, hide() {}, send() {}, focusControls() {} },
		live,
		displays: () => [
			{ id: 1, bounds: rect(0, 0, 1440, 900), workArea: rect(0, 0, 1440, 900), scaleFactor: 1, isPrimary: true },
		],
		settings: () => ({ reducedMotion: true, uiDir: "ltr" }),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log: nullLogger,
		scheduler: new ManualScheduler(),
		openSettings: (s) => opened.push(s),
	});
	live.emit({
		type: "opened",
		sessionId: "s1",
		region: REGION,
		providers: { cloud: null, localOnly: false },
		private: false,
	});
	live.emit({
		type: "frame",
		sessionId: "s1",
		frameSeq: 1,
		upserts: [up("L1", "translate", "es"), up("K1", "skip", "de"), up("K2", "skip", "de"), up("K3", "skip", "fr")],
		removes: [],
		order: ["L1", "K1", "K2", "K3"],
		changeSet: [],
		capturedAt: 1,
		reused: false,
		region: REGION,
		image: { width: 100, height: 100 },
	});
	return { c, live, opened };
}

describe("Live skipped-line actions (GLIM-131)", () => {
	test("Translate these: the skipped languages, once each, for this session", () => {
		const { c, live } = setup();
		c.skippedAction("s1", "translateSkipped");
		expect(live.included).toEqual([["de", "fr"]]);
	});

	test("Edit source languages… opens Settings › Languages", () => {
		const { c, opened, live } = setup();
		c.skippedAction("s1", "editSources");
		expect(opened).toEqual(["languages"]);
		expect(live.included).toEqual([]);
	});

	test("another session's intent does nothing", () => {
		const { c, opened, live } = setup();
		c.skippedAction("old", "translateSkipped");
		c.skippedAction("old", "editSources");
		expect(opened).toEqual([]);
		expect(live.included).toEqual([]);
	});
});
