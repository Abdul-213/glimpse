// GLIM-54: cross-display drags and mixed-DPI selections through PickerSession
// (region-picker spec 4.1, 4.2), on the spec's fixtures: Windows 150 % + 100 %
// (Chromium-style layout), Retina + 1x with an offset, a 125 % monitor at negative x.
import { describe, expect, test } from "bun:test";
import {
	type Display,
	NO_MODIFIERS,
	type PickerOutcome,
	PickerSession,
	type Point,
	type RegionSelected,
	readoutPosition,
	rect,
} from "../src/index.ts";
import { FakePointer, SolidPixelSampler, StaticWindowList } from "../src/testing/index.ts";
import { macDisplays, negDisplays, winDisplays } from "./picker-fixtures.ts";

function session(displays: Display[], mode: "snip" | "live" = "snip", at: Point = { x: 100, y: 100 }) {
	let t = 0;
	const pointer = new FakePointer(at);
	const outcomes: PickerOutcome[] = [];
	const s = new PickerSession({
		env: { displays, os: "windows", confirmOnRelease: true },
		mode,
		probe: pointer,
		windows: new StaticWindowList([]),
		sampler: new SolidPixelSampler(),
		now: () => t,
		onView: () => {},
		onDone: (o) => outcomes.push(o),
	});
	s.start();
	const local = (displayId: number, phase: "down" | "move" | "up", x: number, y: number) =>
		s.pointer({ displayId, phase, x, y, button: 0, detail: 1, mods: NO_MODIFIERS });
	const advance = (ms: number) => {
		for (let i = 0; i < ms; i += 16) {
			t += 16;
			s.tick();
		}
	};
	const region = (): RegionSelected | null => {
		const o = outcomes[0];
		return o?.kind === "confirmed" ? o.region : null;
	};
	return { s, pointer, local, advance, region, outcomes };
}

describe("cross-display drags", () => {
	test("points a view extrapolates beyond its own display come from the OS cursor instead", () => {
		const { s, pointer, local, region } = session(winDisplays);
		pointer.down = true;
		local(65537, "down", 2400, 100);
		// The 150 % view keeps capture and reports x 2700 (its own CSS px), but the cursor is
		// really at logical 2650 on the 100 % monitor (physical extrapolation differs).
		pointer.at = { x: 2650, y: 300 };
		local(65537, "move", 2700, 300);
		expect(s.snapshot.selection).toEqual(rect(2400, 100, 250, 200));
		pointer.down = false;
		local(65537, "up", 2700, 300);
		expect(s.stats.substituted).toBe(2);
		expect(region()?.rect).toEqual(rect(2400, 100, 250, 200));
	});

	test("when the views go quiet, polling moves the corner and detects the release", () => {
		const { s, pointer, local, advance, region } = session(macDisplays, "snip", { x: 1400, y: 300 });
		pointer.down = true;
		local(1, "down", 1400, 300);
		local(1, "move", 1450, 320);
		pointer.at = { x: 1700, y: 400 }; // over display 2, whose overlay sent nothing
		advance(48);
		expect(s.snapshot.selection).toEqual(rect(1400, 300, 300, 100));
		expect(s.done).toBe(false); // button still down
		pointer.down = false;
		advance(160);
		expect(s.stats.polledRelease).toBe(1);
		const r = region();
		expect(r?.rect).toEqual(rect(1400, 300, 300, 100));
		expect(r?.pieces.map((p) => [p.displayId, p.scale, p.physical])).toEqual([
			[1, 2, rect(2800, 600, 224, 200)],
			[2, 1, rect(0, 100, 188, 100)],
		]);
	});

	test("a held still press is not a release while the button is down", () => {
		const { pointer, local, advance, outcomes } = session(macDisplays);
		pointer.down = true;
		local(1, "down", 100, 100);
		local(1, "move", 200, 200);
		advance(500);
		expect(outcomes).toEqual([]);
	});

	test("hover on a display whose overlay isn't key is tracked by polling", () => {
		const { s, pointer, advance } = session(negDisplays, "snip", { x: 10, y: 10 });
		pointer.at = { x: -500, y: 300 };
		advance(120);
		expect(s.view?.pointerDisplayId).toBe(11);
		expect(s.view?.crosshair).toBe(true);
		expect(s.view?.loupe?.displayId).toBe(11);
	});
});

describe("mixed DPI", () => {
	test("the emitted rect is snapped to the device grid of the display holding its top-left", () => {
		const { local, region } = session(winDisplays);
		local(65537, "down", 100.2, 100.2);
		local(65537, "move", 200.4, 200.4);
		local(65537, "up", 300.5, 250.1);
		const r = region()?.rect;
		if (!r) throw new Error("no region");
		for (const v of [r.x, r.y, r.x + r.width, r.y + r.height]) {
			expect(Math.abs(v * 1.5 - Math.round(v * 1.5))).toBeLessThan(1e-9);
		}
		expect(region()?.pieces[0]?.physical).toEqual(rect(150, 150, 301, 225));
	});

	test("a Snip spanning a seam reports logical size and one piece per display", () => {
		const { local, region } = session(winDisplays);
		local(65537, "down", 2360, 200);
		local(65537, "move", 2500, 300);
		local(65537, "up", 2560, 400);
		local(65539, "move", 1, 1); // ignored after confirm
		expect(region()?.rect).toEqual(rect(2360, 200, 200, 200));
		expect(region()?.pieces).toHaveLength(1);

		const span = session(winDisplays);
		span.pointer.down = true;
		span.local(65537, "down", 2360, 200);
		span.pointer.at = { x: 2760, y: 400 };
		span.local(65539, "move", 200, 400); // the other overlay sees it too, in its own px
		span.pointer.down = false;
		span.local(65539, "up", 200, 400);
		const r = span.region();
		expect(r?.rect).toEqual(rect(2360, 200, 400, 200));
		expect(r?.pieces.map((p) => p.physical)).toEqual([rect(3540, 300, 300, 300), rect(0, 200, 200, 200)]);
	});

	test("a Live selection never leaves the anchor's display, even across a 125 % / 100 % seam", () => {
		const { pointer, local, region } = session(negDisplays, "live", { x: -100, y: 100 });
		pointer.down = true;
		local(11, "down", 1436, 100);
		pointer.at = { x: 300, y: 300 };
		local(11, "move", 1836, 300);
		pointer.down = false;
		local(11, "up", 1836, 300);
		expect(region()?.rect).toEqual(rect(-100, 100, 100, 200));
		expect(region()?.pieces.map((p) => p.displayId)).toEqual([11]);
		expect(region()?.pieces[0]?.physical).toEqual(rect(1795, 125, 125, 250));
	});

	test("the readout follows the corner onto the display that holds it", () => {
		const chip = { width: 80, height: 20 };
		expect(readoutPosition(rect(-300, 100, 200, 100), chip, negDisplays)?.displayId).toBe(11);
		expect(readoutPosition(rect(-300, 100, 400, 100), chip, negDisplays)?.displayId).toBe(10);
	});
});
