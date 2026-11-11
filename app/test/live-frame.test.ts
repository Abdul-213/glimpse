// GLIM-90: the pinned Live frame's pure parts (layout, tag copy, colours, coordinate mapping)
// and its controller over a fake native binding. The helpers themselves are compiled and
// smoke-tested on Windows/macOS runners (native.yml) and checked by hand (GLIM-87).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CaptureDisplay, createLogger, type Display, intersection, type Rect, rect } from "@glimpse/core";
import { MemoryLogSink } from "@glimpse/core/testing";
import {
	FRAME_PALETTE_ORDER,
	type FrameHandle,
	type FrameNativeBinding,
	type FrameNativeStyle,
	logicalFrameSpace,
	physicalFrameSpace,
	rgbaOf,
} from "../src/bun/native/frame.ts";
import {
	FRAME_COLORS,
	FRAME_GEOMETRY,
	frameTagText,
	pinnedFrameLayout,
} from "../src/bun/services/live/frame-layout.ts";
import { PinnedFrame } from "../src/bun/services/live/pinned-frame.ts";
import { CaptureExclusion } from "../src/bun/windows/capture-exclusion.ts";

const contains = (outer: Rect, inner: Rect) =>
	inner.x >= outer.x &&
	inner.y >= outer.y &&
	inner.x + inner.width <= outer.x + outer.width &&
	inner.y + inner.height <= outer.y + outer.height;

describe("pinnedFrameLayout (live-popup.md §2.4)", () => {
	const region = rect(100, 200, 400, 80);

	test("eight 12 x 2 arms, 1 px outside the region, never covering it", () => {
		const l = pinnedFrameLayout(region, { tag: false, displayTop: 0 });
		expect(l.ticks).toHaveLength(8);
		for (const t of l.ticks) {
			expect([t.width, t.height].sort()).toEqual([12, 2]);
			expect(intersection(t, region)).toBeNull();
			expect(contains(l.window, t)).toBe(true);
		}
		// Top-left corner: the arms' inner edges sit 1 px outside the region.
		expect(l.ticks[0]).toEqual(rect(97, 197, 12, 2));
		expect(l.ticks[1]).toEqual(rect(97, 197, 2, 12));
		// Bottom-right corner arms end at the region's corner + 3.
		expect(l.ticks[6]).toEqual(rect(503 - 12, 281, 12, 2));
		expect(l.ticks[7]).toEqual(rect(501, 283 - 12, 2, 12));
		expect(l.window).toEqual(rect(84, 184, 432, 112));
		expect(l.tag).toBeNull();
	});

	test("the tag sits 4 px above the top-left tick, inside a 40 px top margin", () => {
		const l = pinnedFrameLayout(region, { tag: true, displayTop: 0 });
		expect(l.tagBelow).toBe(false);
		expect(l.window).toEqual(rect(84, 160, 432, 136));
		expect(l.tag).toEqual({ x: 97, y: 197 - 4 - 20, height: 20 });
		expect((l.tag?.y ?? 0) >= l.window.y).toBe(true);
	});

	test("no room above (region at the display's top): the tag goes below the bottom-left tick", () => {
		const top = rect(100, 10, 400, 80);
		const l = pinnedFrameLayout(top, { tag: true, displayTop: 0 });
		expect(l.tagBelow).toBe(true);
		expect(l.tag).toEqual({ x: 97, y: 93 + 4, height: 20 });
		expect(l.window).toEqual(rect(84, -6, 432, 80 + 16 + 40));
		expect((l.tag?.y ?? 0) + 20 <= l.window.y + l.window.height).toBe(true);
	});

	test("geometry constants match the spec", () => {
		expect(FRAME_GEOMETRY).toMatchObject({
			arm: 12,
			stroke: 2,
			gap: 1,
			halo: 1,
			margin: 16,
			tagMargin: 40,
			tagHeight: 20,
		});
	});
});

describe("tag copy and colours", () => {
	test("live-popup.md §11 live.tag*", () => {
		expect(frameTagText({ kind: "live" })).toBe("Live");
		expect(frameTagText({ kind: "paused" })).toBe("Live · Paused");
		expect(frameTagText({ kind: "cloud", company: "Google" })).toBe("☁︎ Live · Google");
		expect(frameTagText({ kind: "none" })).toBe("");
	});

	test("FRAME_COLORS are DESIGN.md's tokens", () => {
		const design = readFileSync(resolve(import.meta.dir, "../../DESIGN.md"), "utf8");
		for (const name of FRAME_PALETTE_ORDER) {
			const m = design.match(new RegExp(`^\\s+${name}: "(#[0-9A-Fa-f]+)"`, "m"));
			expect(m?.[1]?.toUpperCase()).toBe(FRAME_COLORS[name].toUpperCase());
		}
	});

	test("rgbaOf packs RGBA, defaulting alpha to opaque", () => {
		expect(rgbaOf("#0A63C9")).toBe(0x0a63c9ff);
		expect(rgbaOf("#00000099")).toBe(0x00000099);
		expect(() => rgbaOf("blue")).toThrow();
	});
});

describe("frame coordinate spaces", () => {
	test("macOS: global points as they are", () => {
		expect(logicalFrameSpace(rect(10, 20, 30, 40))).toEqual({ rect: rect(10, 20, 30, 40), scale: 1 });
	});

	test("Windows: logical -> physical px through the capture geometry, with the display scale", () => {
		// A 150 % display at physical 0,0 (2560x1440 -> 1706.67 x 960 logical) and a 100 % one to its right.
		const displays: CaptureDisplay[] = [
			{
				id: 1,
				bounds: rect(0, 0, 2560 / 1.5, 960),
				workArea: rect(0, 0, 2560 / 1.5, 920),
				scaleFactor: 1.5,
				isPrimary: true,
				nativeBounds: rect(0, 0, 2560, 1440),
			},
			{
				id: 2,
				bounds: rect(2560 / 1.5, 0, 1920, 1080),
				workArea: rect(2560 / 1.5, 0, 1920, 1040),
				scaleFactor: 1,
				isPrimary: false,
				nativeBounds: rect(2560, 0, 1920, 1080),
			},
		];
		const space = physicalFrameSpace(() => displays);
		expect(space(rect(100, 200, 400, 80))).toEqual({ rect: rect(150, 300, 600, 120), scale: 1.5 });
		expect(space(rect(2560 / 1.5 + 10, 50, 100, 40))).toEqual({ rect: rect(2570, 50, 100, 40), scale: 1 });
		expect(space(rect(-5000, -5000, 10, 10))).toBeNull();
	});
});

class FakeFrameBinding implements FrameNativeBinding {
	readonly calls: string[] = [];
	readonly styles: FrameNativeStyle[] = [];
	readonly rects: { region: Rect; scale: number }[] = [];
	highlight: Rect | null = null;
	visible = false;
	failOn: string | null = null;
	#next = 1n;
	#live = new Set<FrameHandle>();

	#log(name: string): void {
		this.calls.push(name);
		if (this.failOn === name) throw new Error(`${name} failed`);
	}
	frameCreate(): FrameHandle {
		this.#log("create");
		const h = this.#next++;
		this.#live.add(h);
		return h;
	}
	frameSetRect(_h: FrameHandle, region: Rect, scale: number): void {
		this.#log("rect");
		this.rects.push({ region, scale });
	}
	frameSetStyle(_h: FrameHandle, style: FrameNativeStyle): void {
		this.#log("style");
		this.styles.push(style);
	}
	frameSetHighlight(_h: FrameHandle, box: Rect | null): void {
		this.#log("highlight");
		this.highlight = box;
	}
	frameShow(_h: FrameHandle, visible: boolean): void {
		this.#log(visible ? "show" : "hide");
		this.visible = visible;
	}
	frameWindowId(): number {
		this.#log("windowId");
		return 4242;
	}
	frameDestroy(h: FrameHandle): void {
		this.calls.push("destroy");
		this.#live.delete(h);
	}
	frameInfo(): Record<string, number> | null {
		return null;
	}
	get alive(): number {
		return this.#live.size;
	}
}

const display: Display = {
	id: 1,
	bounds: rect(0, 0, 1440, 900),
	workArea: rect(0, 25, 1440, 875),
	scaleFactor: 2,
	isPrimary: true,
};

function frameWith(binding: FakeFrameBinding | null) {
	const sink = new MemoryLogSink();
	const log = createLogger({ sinks: [sink], level: "debug" });
	const excluded: number[][] = [];
	const exclusion = new CaptureExclusion(null, { setExcludedWindows: (ids) => excluded.push([...ids]) });
	const frame = new PinnedFrame({
		binding,
		space: logicalFrameSpace,
		displays: () => [display],
		exclude: (id) => exclusion.register(id),
		log,
	});
	return { frame, excluded, sink };
}

describe("PinnedFrame (GLIM-90)", () => {
	test("show creates, styles, places and shows the frame once, and registers it for capture exclusion", () => {
		const b = new FakeFrameBinding();
		const { frame, excluded } = frameWith(b);
		frame.show(rect(100, 200, 400, 80));
		expect(b.calls).toEqual(["create", "style", "rect", "show", "windowId"]);
		expect(b.rects[0]).toEqual({ region: rect(100, 200, 400, 80), scale: 1 });
		expect(b.styles[0]).toMatchObject({ paused: false, tag: 0, tagText: "", tagBelow: false });
		expect([...(b.styles[0]?.palette ?? [])]).toEqual([
			0x0a63c9ff, 0x00000099, 0xffffffff, 0x1c1c1ee0, 0xf5f5f7ff, 0x0a63c93d, 0xc4b0ffff,
		]);
		expect(excluded).toEqual([[4242]]);
		expect(b.visible).toBe(true);
	});

	test("paused ticks, tags (cloud names the company) and the tag flipping below near the top", () => {
		const b = new FakeFrameBinding();
		const { frame } = frameWith(b);
		frame.show(rect(100, 10, 400, 80));
		frame.setPaused(true);
		expect(b.styles.at(-1)?.paused).toBe(true);
		frame.setTag({ kind: "cloud", company: "Google" });
		expect(b.styles.at(-1)).toMatchObject({ tag: 3, tagText: "☁︎ Live · Google", tagBelow: true });
		frame.setTag({ kind: "paused" });
		expect(b.styles.at(-1)).toMatchObject({ tag: 2, tagText: "Live · Paused" });
		frame.setPaused(true); // no change, no call
		const n = b.calls.length;
		frame.setPaused(true);
		expect(b.calls.length).toBe(n);
	});

	test("highlight, hide and dispose", () => {
		const b = new FakeFrameBinding();
		const { frame, excluded } = frameWith(b);
		frame.show(rect(100, 200, 400, 80));
		frame.setHighlight(rect(110, 210, 50, 20));
		expect(b.highlight).toEqual(rect(110, 210, 50, 20));
		frame.setHighlight(null);
		expect(b.highlight).toBeNull();
		frame.hide();
		expect(b.visible).toBe(false);
		frame.dispose();
		expect(b.calls.at(-1)).toBe("destroy");
		expect(b.alive).toBe(0);
		expect(excluded.at(-1)).toEqual([]);
	});

	test("a helper failure is logged once and Live carries on without a frame", () => {
		const b = new FakeFrameBinding();
		b.failOn = "rect";
		const { frame, sink } = frameWith(b);
		expect(() => frame.show(rect(100, 200, 400, 80))).not.toThrow();
		expect(frame.available).toBe(false);
		expect(b.alive).toBe(0);
		frame.setPaused(true);
		frame.setHighlight(rect(0, 0, 1, 1));
		expect(sink.records.filter((r) => r.level === "warn")).toHaveLength(1);
	});

	test("no binding (Linux, helper missing): state is tracked, nothing is drawn", () => {
		const { frame } = frameWith(null);
		frame.show(rect(1, 2, 3, 4));
		frame.setPaused(true);
		expect(frame.available).toBe(false);
		expect(frame.state).toMatchObject({ region: rect(1, 2, 3, 4), visible: true, paused: true });
	});
});
