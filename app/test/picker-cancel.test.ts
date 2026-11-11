// GLIM-55: every way out of the picker hides every overlay, and focus goes back to the
// previous app unless the user moved it themselves (region-picker spec 7, 10).
import { describe, expect, test } from "bun:test";
import {
	type CancelReason,
	type Display,
	type FocusKeeper,
	NO_MODIFIERS,
	nullLogger,
	type PickerOutcome,
	rect,
} from "@glimpse/core";
import { FakePointer, SolidPixelSampler, StaticWindowList } from "@glimpse/core/testing";
import { EXIT_FADE_MS, PickerController } from "../src/bun/windows/picker-controller.ts";
import { FakeOverlayFactory, ManualScheduler } from "../src/harness/overlays.ts";

const d = (id: number, x: number): Display => ({
	id,
	bounds: rect(x, 0, 1280, 720),
	workArea: rect(x, 28, 1280, 692),
	scaleFactor: 1,
	isPrimary: id === 1,
});

function setup(reducedMotion = false) {
	let displays = [d(1, 0), d(2, 1280)];
	const factory = new FakeOverlayFactory();
	const scheduler = new ManualScheduler();
	const events: string[] = [];
	const focus: FocusKeeper = {
		save: () => events.push(`save (visible overlays: ${factory.created.filter((o) => o.visible).length})`),
		restore: () => {
			events.push("restore");
			return true;
		},
	};
	const controller = new PickerController({
		factory,
		displays: () => displays,
		probe: new FakePointer({ x: 300, y: 300 }),
		windows: new StaticWindowList([]),
		sampler: new SolidPixelSampler(),
		focus,
		os: "windows",
		log: nullLogger,
		now: scheduler.now,
		scheduler,
		settings: () => ({ confirmOnRelease: true, showLoupe: true, reducedMotion }),
	});
	const outcomes: PickerOutcome[] = [];
	controller.onOutcome((o) => outcomes.push(o));
	const allHidden = () => factory.live.every((o) => !o.visible);
	return {
		controller,
		factory,
		scheduler,
		events,
		outcomes,
		allHidden,
		setDisplays: (x: Display[]) => {
			displays = x;
		},
	};
}

const key = (k: string) => ({ displayId: 1, key: k, down: true, repeat: false, mods: NO_MODIFIERS });

describe("cancel paths", () => {
	const paths: [CancelReason, (c: PickerController, s: ManualScheduler) => void][] = [
		["escape", (c) => c.viewKey(key("Escape"))],
		[
			"right-click",
			(c) => c.viewPointer({ displayId: 2, phase: "down", x: 10, y: 10, button: 2, detail: 1, mods: NO_MODIFIERS }),
		],
		["hotkey", (c) => c.toggle("snip")],
		["external", (c) => c.cancel()],
		[
			"focus-lost",
			(c, s) => {
				c.viewFocus(1, true);
				c.viewFocus(1, false);
				s.advance(200);
			},
		],
	];

	for (const [reason, run] of paths) {
		test(`${reason}: every overlay hides (kept for reuse), focus ${reason === "focus-lost" ? "stays where the user put it" : "goes back"}`, () => {
			const { controller, factory, scheduler, events, outcomes, allHidden } = setup();
			controller.open("snip");
			run(controller, scheduler);
			expect(outcomes).toEqual([{ kind: "cancelled", reason }]);
			scheduler.advance(EXIT_FADE_MS);
			expect(allHidden()).toBe(true);
			expect(factory.created.every((o) => !o.closed)).toBe(true);
			expect(events).toEqual(
				reason === "focus-lost" ? ["save (visible overlays: 0)"] : ["save (visible overlays: 0)", "restore"],
			);
			expect(controller.isOpen).toBe(false);
			expect(scheduler.pending).toBe(0); // no tick left running
		});
	}

	test("Esc mid-drag and from adjusting cancels in one keystroke", () => {
		const { controller, outcomes } = setup(true);
		controller.open("snip");
		controller.viewPointer({ displayId: 1, phase: "down", x: 100, y: 100, button: 0, detail: 1, mods: NO_MODIFIERS });
		controller.viewPointer({ displayId: 1, phase: "move", x: 300, y: 300, button: 0, detail: 0, mods: NO_MODIFIERS });
		controller.viewKey(key("Escape"));
		expect(outcomes.at(-1)).toEqual({ kind: "cancelled", reason: "escape" });
		controller.open("live");
		controller.viewKey(key("ArrowUp"));
		controller.viewKey(key("Escape"));
		expect(outcomes.at(-1)).toEqual({ kind: "cancelled", reason: "escape" });
	});
});

describe("focus", () => {
	test("focus is saved before any overlay shows", () => {
		const { controller, events, factory } = setup();
		controller.open("snip");
		expect(events[0]).toBe("save (visible overlays: 0)");
		expect(factory.created.every((o) => o.visible)).toBe(true);
	});

	test("moving between our own overlays is not a focus loss", () => {
		const { controller, scheduler, outcomes } = setup();
		controller.open("snip");
		controller.viewFocus(1, true);
		controller.viewFocus(1, false);
		scheduler.advance(32);
		controller.viewFocus(2, true);
		scheduler.advance(500);
		expect(outcomes).toEqual([]);
	});

	test("an overlay that never got focus (refused foreground) doesn't cancel", () => {
		const { controller, scheduler, outcomes } = setup();
		controller.open("snip");
		controller.viewFocus(1, false);
		scheduler.advance(1000);
		expect(outcomes).toEqual([]);
		expect(controller.isOpen).toBe(true);
	});

	test("Live confirm restores focus at once; a kept Snip leaves it to the popup", () => {
		const live = setup(true);
		live.controller.open("live");
		live.controller.viewKey(key("ArrowRight"));
		live.controller.viewKey(key("Enter"));
		expect(live.events).toEqual(["save (visible overlays: 0)", "restore"]);
		expect(live.allHidden()).toBe(true);

		const snip = setup(true);
		snip.controller.onRegionSelected(() => "keep");
		snip.controller.open("snip");
		snip.controller.viewKey(key("ArrowRight"));
		snip.controller.viewKey(key("Enter"));
		snip.controller.dismiss();
		expect(snip.events).toEqual(["save (visible overlays: 0)"]);
		expect(snip.allHidden()).toBe(true);
	});
});

describe("display changes and teardown", () => {
	test("a display change while picking cancels, restores focus, and replaces the overlays", () => {
		const { controller, factory, scheduler, events, outcomes, setDisplays, allHidden } = setup();
		controller.open("snip");
		setDisplays([d(1, 0)]);
		scheduler.advance(1100); // the display list is re-read at most once a second
		expect(outcomes).toEqual([{ kind: "cancelled", reason: "display-change" }]);
		expect(events.at(-1)).toBe("restore");
		scheduler.advance(EXIT_FADE_MS + 1);
		expect(factory.created.slice(0, 2).every((o) => o.closed)).toBe(true);
		expect(factory.live.map((o) => o.display.id)).toEqual([1]);
		expect(allHidden()).toBe(true);
	});

	test("reopening during the exit fade cancels the pending hide", () => {
		const { controller, factory, scheduler } = setup();
		controller.open("snip");
		controller.cancel();
		scheduler.advance(EXIT_FADE_MS / 2);
		controller.open("live");
		scheduler.advance(EXIT_FADE_MS * 2);
		expect(factory.live.every((o) => o.visible)).toBe(true);
	});

	test("quitting while open closes every overlay and stops ticking", () => {
		const { controller, factory, scheduler } = setup();
		controller.open("snip");
		controller.dispose();
		scheduler.advance(1000);
		expect(factory.created.every((o) => o.closed && !o.visible)).toBe(true);
		expect(scheduler.pending).toBe(0);
	});
});
