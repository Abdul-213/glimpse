// GLIM-123 (live-popup.md L12): the Live popup's language-pack row. The session's `packs`
// event shows a row at the top of the list, Download goes through the same PackPort as Snip
// (the user's consent), progress updates the row, and once the pack is in the row goes away
// and the session re-reads the region so the waiting blocks translate. The session keeps
// running throughout.
import { describe, expect, test } from "bun:test";
import {
	type Display,
	type InstallState,
	type LiveSessionEvent,
	type LiveSessionListener,
	languageCode,
	nullLogger,
	type Rect,
	rect,
} from "@glimpse/core";
import { RecordingFocusKeeper } from "@glimpse/core/testing";
import {
	LivePopupController,
	type LivePopupSession,
	type LivePopupWindowPort,
} from "../src/bun/windows/live-popup-controller.ts";
import type { PackPort } from "../src/bun/windows/popup-controller.ts";
import { ManualScheduler } from "../src/harness/overlays.ts";
import type { LiveStateMessage } from "../src/shared/live-rpc.ts";

class FakeWindow implements LivePopupWindowPort {
	messages: LiveStateMessage[] = [];
	setFrame(): void {}
	showInactive(): void {}
	activate(): void {}
	hide(): void {}
	send(m: LiveStateMessage): void {
		this.messages.push(m);
	}
	focusControls(): void {}
}

class FakeSession implements LivePopupSession {
	readonly calls: string[] = [];
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
	setPopupVisible() {}
	refresh(reason: string) {
		this.calls.push(`refresh:${reason}`);
	}
}

class FakePacks implements PackPort {
	readonly downloads: string[][] = [];
	readonly states = new Map<string, InstallState>();
	#listeners = new Set<(id: string, s: InstallState) => void>();
	download(ids: readonly string[]) {
		this.downloads.push([...ids]);
		return Promise.resolve([]);
	}
	state(id: string): InstallState {
		return this.states.get(id) ?? { status: "missing" };
	}
	subscribe(l: (id: string, s: InstallState) => void) {
		this.#listeners.add(l);
		return () => this.#listeners.delete(l);
	}
	set(id: string, s: InstallState) {
		this.states.set(id, s);
		for (const l of this.#listeners) l(id, s);
	}
}

const DISPLAY: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 0, 1440, 900),
	scaleFactor: 2,
	isPrimary: true,
};
const REGION: Rect = rect(120, 760, 1200, 100);
const S = "s1";
const KO = languageCode("ko");

function setup(withPacks = true) {
	const window = new FakeWindow();
	const live = new FakeSession();
	const packs = new FakePacks();
	const c = new LivePopupController({
		window,
		live,
		displays: () => [DISPLAY],
		settings: () => ({ reducedMotion: true, uiDir: "ltr" }),
		setPrivate: () => {},
		repin: () => {},
		focus: new RecordingFocusKeeper(),
		log: nullLogger,
		scheduler: new ManualScheduler(),
		...(withPacks ? { packs } : {}),
	});
	live.emit({
		type: "opened",
		sessionId: S,
		region: REGION,
		providers: { cloud: null, localOnly: false },
		private: false,
	});
	live.emit({
		type: "frame",
		sessionId: S,
		frameSeq: 1,
		upserts: [
			{
				id: "L1",
				order: 0,
				cls: "translate",
				lang: KO,
				direction: "ltr",
				box: rect(0, 0, 100, 20),
				source: "안녕하세요",
				translation: null,
				failed: false,
				waitingForPack: true,
				changed: false,
			},
		],
		removes: [],
		order: ["L1"],
		changeSet: [],
		capturedAt: 1000,
		reused: false,
		region: REGION,
		image: { width: 2400, height: 200 },
	});
	live.emit(packsEvent(1, [{ lang: KO, ids: ["bergamot-koen"], blocks: ["L1"] }]));
	return { c, window, live, packs };
}

function packsEvent(seq: number, rows: { lang: typeof KO; ids: string[]; blocks: string[] }[]): LiveSessionEvent {
	return {
		type: "packs",
		sessionId: S,
		frameSeq: seq,
		rows: rows.map((r) => ({
			lang: r.lang,
			state: "missing",
			resourceIds: r.ids,
			bytes: 40_000_000,
			progress: null,
			segmentIds: r.blocks,
		})),
	};
}

describe("Live popup pack row (GLIM-123, L12)", () => {
	test("a packs event shows one row per language; the waiting block shows its source", () => {
		const { c } = setup();
		expect(c.state.packs).toEqual([
			{
				lang: KO,
				state: "missing",
				bytes: 40_000_000,
				received: null,
				total: null,
				resourceIds: ["bergamot-koen"],
				blockIds: ["L1"],
			},
		]);
		const b = c.state.blocks[0];
		expect(b?.waitingForPack).toBe(true);
		expect(b?.translation).toBeNull();
		expect(c.state.status).toBe("starting");
	});

	test("Download asks the PackPort (consent) once, the row follows the download, the session keeps running", () => {
		const { c, live, packs } = setup();
		c.downloadPack(S, KO);
		expect(packs.downloads).toEqual([["bergamot-koen"]]);
		packs.set("bergamot-koen", { status: "downloading", receivedBytes: 10_000_000, totalBytes: 40_000_000 });
		expect(c.state.packs[0]).toMatchObject({ state: "downloading", received: 10_000_000, total: 40_000_000 });
		// Pressing again while downloading does nothing.
		c.downloadPack(S, KO);
		expect(packs.downloads.length).toBe(1);
		// A frame read meanwhile (the readiness still says missing) keeps the progress.
		live.emit(packsEvent(2, [{ lang: KO, ids: ["bergamot-koen"], blocks: ["L1"] }]));
		expect(c.state.packs[0]?.state).toBe("downloading");
		expect(live.calls).toEqual([]);
	});

	test("the pack landing removes the row and re-reads the region so the blocks translate", () => {
		const { c, live, packs } = setup();
		c.downloadPack(S, KO);
		packs.set("bergamot-koen", { status: "installed", version: "1", bundled: false });
		expect(c.state.packs).toEqual([]);
		expect(live.calls).toEqual(["refresh:pack-installed"]);
		// The re-read frame translates the block and clears the rows.
		live.emit(packsEvent(2, []));
		live.emit({ type: "translation", sessionId: S, frameSeq: 2, id: "L1", text: "Hello", final: true, failed: false });
		expect(c.state.packs).toEqual([]);
	});

	test("a failed download says so and offers Download again", () => {
		const { c, packs } = setup();
		c.downloadPack(S, KO);
		packs.set("bergamot-koen", { status: "failed", error: { kind: "network", message: "offline" } } as InstallState);
		expect(c.state.packs[0]?.state).toBe("failed");
		c.downloadPack(S, KO);
		expect(packs.downloads.length).toBe(2);
	});

	test("rows of another session, and installs of other packs, are ignored", () => {
		const { c, live, packs } = setup();
		c.downloadPack("other", KO);
		expect(packs.downloads).toEqual([]);
		packs.set("bergamot-jaen", { status: "installed", version: "1", bundled: false });
		expect(c.state.packs.length).toBe(1);
		expect(live.calls).toEqual([]);
	});

	test("the view gets the rows in the state message; stopping clears them", async () => {
		const { c, window, live } = setup();
		await new Promise<void>((r) => queueMicrotask(() => r()));
		expect(window.messages.at(-1)?.state.packs.length).toBe(1);
		live.emit({
			type: "status",
			sessionId: S,
			status: "stopped",
			reason: null,
			error: null,
			stale: true,
			capturedAt: null,
			at: 0,
		});
		expect(c.state.packs).toEqual([]);
	});

	test("without a PackPort the row shows and Download is a no-op", () => {
		const { c } = setup(false);
		expect(c.state.packs.length).toBe(1);
		c.downloadPack(S, KO);
		expect(c.state.packs[0]?.state).toBe("missing");
	});
});
