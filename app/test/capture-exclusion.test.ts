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
