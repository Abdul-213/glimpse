// GLIM-91: the pure parts of the picker's native helpers (struct decoding, window list
// mapping, focus wrapper, macOS loupe stream) with fake bindings.
import { describe, expect, test } from "bun:test";
import { type Display, rect } from "@glimpse/core";
import { RecordingFocusKeeper, SolidPixelSampler } from "@glimpse/core/testing";
import type { MacCaptureBinding, MacPickerBinding } from "../src/bun/native/macos.ts";
import {
	decodeWindowInfos,
	encodeWindowInfos,
	listNativeWindows,
	type NativeWindowInfo,
	WINDOW_INFO_SIZE,
} from "../src/bun/native/window-info.ts";
import { overlayExStyle, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW } from "../src/bun/native/windows.ts";
import { NativeFocusKeeper } from "../src/bun/services/picker/focus.ts";
import { createPickerNatives } from "../src/bun/services/picker/index.ts";
import { MacStreamPixelSampler } from "../src/bun/services/picker/mac-sampler.ts";
import { macWindows, windowsWindows } from "../src/bun/services/picker/window-list.ts";

const d = (id: number, bounds: ReturnType<typeof rect>, scaleFactor: number): Display => ({
	id,
	bounds,
	workArea: bounds,
	scaleFactor,
	isPrimary: id === 1,
});

describe("GlimWindowInfo", () => {
	const items: NativeWindowInfo[] = [
		{ rect: rect(10.5, 20, 800, 600), pid: 4242, z: 0, appName: "Safari" },
		{ rect: rect(-1920, 0, 1920, 1080), pid: 7, z: 1, appName: "日本語のアプリ" },
	];

	test("round-trips through the 104-byte struct", () => {
		const buf = encodeWindowInfos(items);
		expect(buf.length).toBe(2 * WINDOW_INFO_SIZE);
		expect(decodeWindowInfos(buf, 2)).toEqual(items);
		expect(decodeWindowInfos(buf, 9)).toHaveLength(2); // never reads past the buffer
	});

	test("listNativeWindows grows the buffer once when more matched than fit", () => {
		const all = Array.from({ length: 5 }, (_, i) => ({ rect: rect(i, 0, 50, 50), pid: i, z: i, appName: `w${i}` }));
		const caps: number[] = [];
		const { status, windows } = listNativeWindows((buf, cap, counts) => {
			caps.push(cap);
			const n = Math.min(cap, all.length);
			buf.set(encodeWindowInfos(all.slice(0, n)));
			counts[0] = n;
			counts[1] = all.length;
			return 0;
		}, 2);
		expect(status).toBe(0);
		expect(caps).toEqual([2, 5]);
		expect(windows).toHaveLength(5);
	});

	test("a failing call reports its status", () => {
		expect(listNativeWindows(() => -4).status).toBe(-4);
	});
});

describe("window lists in logical space", () => {
	test("macOS: points pass through; tiny windows dropped; sorted by z", () => {
		const out = macWindows([
			{ rect: rect(0, 0, 30, 300), pid: 1, z: 1, appName: "Narrow" },
			{ rect: rect(100, 100, 500, 400), pid: 2, z: 2, appName: "Back" },
			{ rect: rect(50, 50, 500, 400), pid: 3, z: 0, appName: "Front" },
		]);
		expect(out.map((w) => w.appName)).toEqual(["Front", "Back"]);
	});

	test("Windows: physical frames map per monitor (150 % primary, 100 % secondary)", () => {
		const shell = [d(1, rect(0, 0, 2560, 1440), 1.5), d(2, rect(2560, 0, 1920, 1080), 1)];
		const physical = [
			{ id: 1, name: "a", bounds: rect(0, 0, 3840, 2160), dpi: 144, primary: true },
			{ id: 2, name: "b", bounds: rect(3840, 0, 1920, 1080), dpi: 96, primary: false },
		];
		const out = windowsWindows(
			[
				{ rect: rect(300, 150, 1500, 900), pid: 1, z: 0, appName: "Edge" },
				{ rect: rect(3940, 100, 800, 600), pid: 2, z: 1, appName: "Notepad" },
			],
			shell,
			physical,
		);
		expect(out.map((w) => w.rect)).toEqual([rect(200, 100, 1000, 600), rect(2660, 100, 800, 600)]);
	});
});

describe("overlay ex-style", () => {
	test("swaps WS_EX_APPWINDOW for WS_EX_TOOLWINDOW and keeps the rest", () => {
		const before = WS_EX_APPWINDOW | 0x00200000; // + WS_EX_NOREDIRECTIONBITMAP (Electrobun transparency)
		const after = overlayExStyle(before);
		expect(after & WS_EX_APPWINDOW).toBe(0);
		expect(after & WS_EX_TOOLWINDOW).toBe(WS_EX_TOOLWINDOW);
		expect(after & 0x00200000).toBe(0x00200000);
	});
});

describe("NativeFocusKeeper", () => {
	test("never throws; a refused restore is logged and reports false", () => {
		const logs: string[] = [];
		const keeper = new NativeFocusKeeper(
			{
				focusSave: () => {
					throw new Error("boom");
				},
				focusRestore: () => {
					throw new Error("refused");
				},
			},
			(m) => logs.push(m),
		);
		keeper.save();
		expect(keeper.restore()).toBe(false);
		expect(logs).toHaveLength(2);
	});

	test("passes the helper's answer through", () => {
		const keeper = new NativeFocusKeeper({ focusSave: () => 1, focusRestore: () => true });
		expect(keeper.restore()).toBe(true);
		expect(new RecordingFocusKeeper(false).restore()).toBe(false);
	});
});

type FakeMac = Pick<MacCaptureBinding, "streamOpen" | "streamClose"> & Pick<MacPickerBinding, "streamSample">;

function fakeMac(opts: { failOpen?: boolean; firstFrameAfter?: number } = {}) {
	const calls: string[] = [];
	let samples = 0;
	const binding: FakeMac = {
		async streamOpen(id, source, width, height, fps) {
			calls.push(`open ${id} ${source.width}x${source.height} -> ${width}x${height} @${fps}`);
			await Promise.resolve();
			if (opts.failOpen) throw new Error("SCStream start failed");
			return BigInt(id);
		},
		streamClose(h) {
			calls.push(`close ${h}`);
		},
		streamSample(h, x, y, size, out) {
			calls.push(`sample ${h} ${x},${y} ${size}`);
			if (samples++ < (opts.firstFrameAfter ?? 0)) return null;
			out.fill(9);
			return 5;
		},
	};
	return { binding: binding as unknown as MacCaptureBinding & MacPickerBinding, calls };
}

describe("MacStreamPixelSampler", () => {
	const displays = [d(1, rect(0, 0, 1512, 982), 2), d(2, rect(1512, 0, 1920, 1080), 1)];

	test("opens one full-display stream at backing resolution and samples around the hotspot", async () => {
		const { binding, calls } = fakeMac();
		const sampler = new MacStreamPixelSampler(binding, () => displays, new SolidPixelSampler());
		const patch = await sampler.sample({ x: 100.25, y: 50.75 }, 15);
		await sampler.sample({ x: 101, y: 51 }, 15);
		expect(patch?.displayId).toBe(1);
		expect(patch?.sequence).toBe(5);
		expect(calls).toEqual(["open 1 1512x982 -> 3024x1964 @30", "sample 1 193,94 15", "sample 1 195,95 15"]);
	});

	test("follows the pointer to another display", async () => {
		const { binding, calls } = fakeMac();
		const sampler = new MacStreamPixelSampler(binding, () => displays, new SolidPixelSampler());
		await sampler.sample({ x: 10, y: 10 }, 15);
		await sampler.sample({ x: 1600, y: 10 }, 15);
		sampler.stop();
		expect(calls.filter((c) => !c.startsWith("sample"))).toEqual([
			"open 1 1512x982 -> 3024x1964 @30",
			"close 1",
			"open 2 1920x1080 -> 1920x1080 @30",
			"close 2",
		]);
	});

	test("no frame yet: null (empty grid), not the fallback", async () => {
		const { binding } = fakeMac({ firstFrameAfter: 1 });
		const fallback = new SolidPixelSampler();
		const sampler = new MacStreamPixelSampler(binding, () => displays, fallback);
		expect(await sampler.sample({ x: 10, y: 10 }, 15)).toBeNull();
		expect((await sampler.sample({ x: 10, y: 10 }, 15))?.sequence).toBe(5);
		expect(fallback.samples).toHaveLength(0);
	});

	test("a stream that can't start falls back to screenshots for that display", async () => {
		const { binding } = fakeMac({ failOpen: true });
		const fallback = new SolidPixelSampler();
		const errors: unknown[] = [];
		const sampler = new MacStreamPixelSampler(
			binding,
			() => displays,
			fallback,
			(e) => errors.push(e),
		);
		expect(await sampler.sample({ x: 10, y: 10 }, 15)).not.toBeNull();
		await sampler.sample({ x: 11, y: 10 }, 15);
		expect(fallback.samples).toHaveLength(2);
		expect(errors).toHaveLength(1);
	});
});

describe("createPickerNatives", () => {
	test("Linux / file backend: capture-backed loupe, no window list, no focus", async () => {
		const capture = {
			backend: "file",
			exclusion: "none" as const,
			displays: () => [],
			capture: async () => {
				throw new Error("x");
			},
			openSession: async () => {
				throw new Error("x");
			},
			setExcludedWindows: () => {},
			dispose: () => {},
		};
		const natives = createPickerNatives({ platform: "linux", capture, shellDisplays: () => [] });
		expect(await natives.windows.list()).toEqual([]);
		expect(natives.focus.restore()).toBe(false);
		expect(natives.status).toContain("no native picker helpers");
	});
});
