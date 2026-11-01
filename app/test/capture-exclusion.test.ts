import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { CaptureExclusion, type ExcludableWindow, type ExclusionOps } from "../src/bun/windows/capture-exclusion.ts";

class FakeWindow implements ExcludableWindow {
	private closers: ((e: unknown) => void)[] = [];
	constructor(readonly ptr: Pointer | null) {}
	on(_name: "close", handler: (event: unknown) => void): void {
		this.closers.push(handler);
	}
	close(): void {
		for (const c of this.closers) c({});
	}
}

const handle = (n: number) => n as unknown as Pointer;

function setup(ops: Partial<ExclusionOps> | null) {
	const log: string[] = [];
	const order: string[] = [];
	const sink = { lists: [] as number[][], setExcludedWindows: (ids: readonly number[]) => sink.lists.push([...ids]) };
	const full: ExclusionOps | null = ops
		? {
				exclude: (h) => {
					order.push("exclude");
					return ops.exclude?.(h) ?? { excluded: true, windowId: Number(h), detail: "ok" };
				},
				windowId: (h) => (ops.windowId ? ops.windowId(h) : Number(h)),
				setHidden: (h, hidden) => {
					order.push(`${hidden ? "hide" : "show-to-capture"}:${Number(h)}`);
					return ops.setHidden?.(h, hidden) ?? { excluded: hidden, detail: "ok" };
				},
				ownCaptureSkipsIds: ops.ownCaptureSkipsIds ?? false,
			}
		: null;
	return { exclusion: new CaptureExclusion(full, sink, (m) => log.push(m)), sink, log, order };
}

describe("CaptureExclusion", () => {
	test("excludes before showing, registers the id, unregisters on close", () => {
		const { exclusion, sink, order } = setup({});
		const a = new FakeWindow(handle(11));
		const b = new FakeWindow(handle(22));
		const r = exclusion.protect(a, () => order.push("show"));
		exclusion.protect(b);
		expect(order).toEqual(["exclude", "show", "exclude"]);
		expect(r).toEqual({ excluded: true, windowId: 11, detail: "ok" });
		expect(sink.lists).toEqual([[11], [11, 22]]);
		a.close();
		a.close();
		expect(sink.lists.at(-1)).toEqual([22]);
		expect(sink.lists).toHaveLength(3);
	});

	test("macOS: a window without a number yet gets it after show", () => {
		let shown = false;
		const { exclusion, sink } = setup({
			exclude: () => ({ excluded: true, windowId: null, detail: "sharingType none" }),
			windowId: () => (shown ? 4711 : null),
		});
		const r = exclusion.protect(new FakeWindow(handle(1)), () => {
			shown = true;
		});
		expect(r.windowId).toBe(4711);
		expect(sink.lists).toEqual([[4711]]);
	});

	test("failures are logged and the window is still shown", () => {
		const { exclusion, log, sink } = setup({
			exclude: () => {
				throw new Error("not an NSWindow");
			},
			windowId: () => null,
		});
		let shown = false;
		const r = exclusion.protect(new FakeWindow(handle(3)), () => {
			shown = true;
		});
		expect(shown).toBe(true);
		expect(r.excluded).toBe(false);
		expect(log[0]).toContain("not an NSWindow");
		expect(sink.lists).toEqual([]);
	});

	test("old Windows builds read back WDA_MONITOR and are reported", () => {
		const { exclusion, log } = setup({
			exclude: () => ({ excluded: false, windowId: 5, detail: "display affinity reads back 0x1" }),
		});
		exclusion.protect(new FakeWindow(handle(5)));
		expect(log[0]).toContain("0x1");
	});

	test("no ops (Linux): shows the window and does nothing else", () => {
		const { exclusion, sink, log } = setup(null);
		let shown = false;
		exclusion.protect(new FakeWindow(null), () => {
			shown = true;
		});
		expect(shown).toBe(true);
		expect(sink.lists).toEqual([]);
		expect(log).toEqual([]);
	});
});

describe("Hide Glimpse from screenshots and screen sharing (GLIM-98)", () => {
	const popupAt = { x: 100, y: 100, width: 300, height: 120 };

	test("on (default): everything is flagged and nothing needs masking", () => {
		const { exclusion, order } = setup({});
		exclusion.protect(new FakeWindow(handle(1)), undefined, { role: "popup", bounds: () => popupAt });
		exclusion.protect(new FakeWindow(handle(2)), undefined, { role: "window" });
		exclusion.protect(new FakeWindow(handle(3)));
		expect(exclusion.hideFromCapture).toBe(true);
		expect(order).toEqual(["exclude", "exclude", "exclude"]);
		expect(exclusion.maskRects()).toEqual([]);
	});

	test("off: open popups and windows are un-flagged, surfaces stay; turning it on again re-flags", () => {
		const { exclusion, order } = setup({});
		exclusion.protect(new FakeWindow(handle(1)), undefined, { role: "popup", bounds: () => popupAt });
		exclusion.protect(new FakeWindow(handle(2)), undefined, { role: "window" });
		exclusion.protect(new FakeWindow(handle(3)), undefined, { role: "surface" });
		order.length = 0;
		exclusion.setHideFromCapture(false);
		expect(order).toEqual(["show-to-capture:1", "show-to-capture:2"]);
		order.length = 0;
		exclusion.setHideFromCapture(true);
		expect(order).toEqual(["hide:1", "hide:2"]);
	});

	test("off on Windows: a popup shown later isn't flagged, and its frame is masked out of Glimpse's capture", () => {
		const { exclusion, order, sink } = setup({});
		exclusion.setHideFromCapture(false);
		let visible: typeof popupAt | null = null;
		const popup = new FakeWindow(handle(7));
		exclusion.protect(popup, undefined, { role: "popup", bounds: () => visible });
		exclusion.protect(new FakeWindow(handle(8)), undefined, { role: "surface" });
		expect(order).toEqual(["exclude"]); // only the surface
		expect(sink.lists.at(-1)).toEqual([7, 8]); // ids still registered
		expect(exclusion.maskRects()).toEqual([]); // hidden popup: nothing to mask
		visible = popupAt;
		expect(exclusion.maskRects()).toEqual([popupAt]);
		popup.close();
		expect(exclusion.maskRects()).toEqual([]);
	});

	test("macOS: the capture filter skips Glimpse by id, so nothing is masked even when off", () => {
		const { exclusion } = setup({ ownCaptureSkipsIds: true });
		exclusion.setHideFromCapture(false);
		exclusion.protect(new FakeWindow(handle(7)), undefined, { role: "popup", bounds: () => popupAt });
		expect(exclusion.maskRects()).toEqual([]);
	});

	test("a flag that didn't stick (old Windows builds) is masked too", () => {
		const { exclusion } = setup({ exclude: () => ({ excluded: false, windowId: 7, detail: "reads back 0x1" }) });
		exclusion.protect(new FakeWindow(handle(7)), undefined, { role: "popup", bounds: () => popupAt });
		expect(exclusion.maskRects()).toEqual([popupAt]);
	});
});
