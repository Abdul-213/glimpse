// Windows and macOS capture services against fake native bindings: backend choice,
// fallbacks, geometry handed to native code, sequences, session lifetimes.
import { describe, expect, test } from "bun:test";
import { CaptureError, type CapturePiece, type Display, type Rect, type RgbaImage, rect } from "@glimpse/core";
import { pixelAt } from "@glimpse/core/testing";
import type { MacCaptureBinding, MacNativeDisplay, StreamHandle } from "../src/bun/native/macos.ts";
import type { PhysicalDisplay, WindowsBackend, WindowsCaptureBinding } from "../src/bun/native/windows.ts";
import { MacCaptureSource } from "../src/bun/services/capture/macos.ts";
import { displaysFromMac, displaysFromWindows } from "../src/bun/services/capture/native-displays.ts";
import { SequenceTracker } from "../src/bun/services/capture/sequence.ts";
import { dxgiFailureIsSticky, WindowsCaptureSource } from "../src/bun/services/capture/windows.ts";

function paint(out: RgbaImage, dest: Rect, rgb: readonly [number, number, number]): void {
	for (let y = dest.y; y < dest.y + dest.height; y++) {
		for (let x = dest.x; x < dest.x + dest.width; x++) {
			const i = (y * out.width + x) * 4;
			out.data.set([rgb[0], rgb[1], rgb[2], 255], i);
		}
	}
}

const display = (id: number, bounds: Rect, scaleFactor: number, isPrimary = false): Display => ({
	id,
	bounds,
	workArea: bounds,
	scaleFactor,
	isPrimary,
});

// 150% primary + 100% monitor on its left (Electrobun logical layout + glimpse.dll physical rects).
const shell = [display(101, rect(0, 0, 2560, 1440), 1.5, true), display(202, rect(-1920, 0, 1920, 1080), 1)];
const physical: PhysicalDisplay[] = [
	{ id: 101, name: "\\\\.\\DISPLAY1", bounds: rect(0, 0, 3840, 2160), dpi: 144, primary: true },
	{ id: 202, name: "\\\\.\\DISPLAY2", bounds: rect(-1920, 0, 1920, 1080), dpi: 96, primary: false },
];

class FakeWindowsBinding implements WindowsCaptureBinding {
	readonly status = { available: true as const, path: "fake.dll" };
	calls: { backend: WindowsBackend; piece: CapturePiece }[] = [];
	released: string[] = [];
	dxgiSeq = 1;
	/** Errors to throw from DXGI per display, consumed in order. */
	dxgiFailures = new Map<number, CaptureError[]>();

	physicalDisplays(): PhysicalDisplay[] {
		return physical;
	}

	capturePiece(backend: WindowsBackend, piece: CapturePiece, out: RgbaImage): number {
		this.calls.push({ backend, piece });
		if (backend === "dxgi") {
			const err = this.dxgiFailures.get(piece.displayId)?.shift();
			if (err) throw err;
		}
		paint(out, piece.dest, backend === "dxgi" ? [0, 0, 200] : [0, 200, 0]);
		return backend === "dxgi" ? this.dxgiSeq : this.calls.length;
	}

	release(backend: WindowsBackend | "all"): void {
		this.released.push(backend);
	}
}

describe("WindowsCaptureSource", () => {
	const make = (binding = new FakeWindowsBinding()) => ({
		binding,
		source: new WindowsCaptureSource({ binding, shellDisplays: () => shell, now: () => 42 }),
	});

	test("Snip uses GDI with physical source rects at the monitor's scale", async () => {
		const { binding, source } = make();
		const f = await source.capture(rect(100, 100, 400, 120));
		expect([f.width, f.height, f.scale, f.capturedAt]).toEqual([600, 180, 1.5, 42]);
		expect(binding.calls).toHaveLength(1);
		expect(binding.calls[0]?.backend).toBe("gdi");
		expect(binding.calls[0]?.piece.source).toEqual(rect(150, 150, 600, 180));
		expect(pixelAt(f, 0, 0)).toEqual([0, 200, 0]);
		expect(source.exclusion).toBe("window-flag");
	});

	test("a rect spanning mixed DPI asks the DLL to resample the 100% piece", async () => {
		const { binding, source } = make();
		await source.capture(rect(-100, 100, 200, 100));
		const left = binding.calls.find((c) => c.piece.displayId === 202)?.piece;
		expect(left?.source).toEqual(rect(-100, 100, 100, 100));
		expect(left?.sourceLocal).toEqual(rect(1820, 100, 100, 100));
		expect(left?.dest).toEqual(rect(0, 0, 150, 150));
	});

	test("Live uses DXGI; the sequence only moves when DXGI saw new content", async () => {
		const { binding, source } = make();
		const s = await source.openSession(rect(10, 10, 100, 50), { fps: 4 });
		const a = await s.next();
		const b = await s.next();
		binding.dxgiSeq = 2;
		const c = await s.next();
		expect(binding.calls.every((x) => x.backend === "dxgi")).toBe(true);
		expect([a.sequence, b.sequence, c.sequence]).toEqual([a.sequence, a.sequence, a.sequence + 1]);
		expect(pixelAt(c, 0, 0)).toEqual([0, 0, 200]);
		s.close();
		s.close();
		expect(binding.released).toEqual(["dxgi"]);
	});

	test("a lasting DXGI failure moves that monitor to GDI for the session", async () => {
		const binding = new FakeWindowsBinding();
		binding.dxgiFailures.set(101, [new CaptureError("unavailable", "DXGI_ERROR_UNSUPPORTED")]);
		const fallbacks: number[] = [];
		const source = new WindowsCaptureSource({
			binding,
			shellDisplays: () => shell,
			onFallback: (id) => fallbacks.push(id),
		});
		const s = await source.openSession(rect(10, 10, 100, 50), { fps: 4 });
		await s.next();
		expect(binding.calls.map((c) => c.backend)).toEqual(["dxgi", "gdi", "gdi"]);
		expect(fallbacks).toEqual([101]);
	});

	test("a temporary DXGI failure uses GDI for that frame only", async () => {
		const binding = new FakeWindowsBinding();
		const source = new WindowsCaptureSource({ binding, shellDisplays: () => shell });
		const s = await source.openSession(rect(10, 10, 100, 50), { fps: 4 });
		binding.dxgiFailures.set(101, [new CaptureError("temporarily-unavailable", "ACCESS_LOST")]);
		binding.calls = [];
		await s.next();
		await s.next();
		expect(binding.calls.map((c) => c.backend)).toEqual(["dxgi", "gdi", "dxgi"]);
	});

	test("errors other than DXGI fallbacks propagate; bad rects are rejected", async () => {
		const { source } = make();
		await expect(source.capture(rect(9000, 9000, 10, 10))).rejects.toMatchObject({ code: "no-display" });
		await expect(source.capture(rect(0, 0, 0, 10))).rejects.toMatchObject({ code: "invalid-argument" });
		await expect(source.openSession(rect(0, 0, 10, 10), { fps: 0 })).rejects.toMatchObject({
			code: "invalid-argument",
		});
	});

	test("dispose releases everything", () => {
		const { binding, source } = make();
		source.dispose();
		expect(binding.released).toEqual(["all"]);
	});

	test("sticky vs temporary DXGI failures", () => {
		expect(dxgiFailureIsSticky("unavailable")).toBe(true);
		expect(dxgiFailureIsSticky("failed")).toBe(true);
		expect(dxgiFailureIsSticky("temporarily-unavailable")).toBe(false);
		expect(dxgiFailureIsSticky("timeout")).toBe(false);
	});
});

class FakeMacBinding implements MacCaptureBinding {
	readonly status = { available: true as const, path: "fake.dylib" };
	shots: { displayId: number; source: Rect; dest: Rect }[] = [];
	streams = new Map<
		StreamHandle,
		{ displayId: number; source: Rect; width: number; height: number; fps: number; seq: number }
	>();
	closed: StreamHandle[] = [];
	excluded: number[][] = [];
	next = 1n;
	failOpenOn: number | null = null;
	resetCalls = 0;

	preflight(): boolean {
		return true;
	}
	displays(): MacNativeDisplay[] {
		return [];
	}
	backgroundError: ((error: unknown) => void) | null = null;
	/** Shots wait for this before painting (an in-flight capture, GLIM-97). */
	gate: Promise<void> = Promise.resolve();
	setExcludedWindows(ids: readonly number[]): void {
		this.excluded.push([...ids]);
	}
	onBackgroundError(listener: ((error: unknown) => void) | null): void {
		this.backgroundError = listener;
	}
	async shot(displayId: number, source: Rect, dest: Rect, out: RgbaImage): Promise<void> {
		this.shots.push({ displayId, source, dest });
		await this.gate;
		paint(out, dest, [200, 0, 0]);
	}
	async streamOpen(displayId: number, source: Rect, width: number, height: number, fps: number): Promise<StreamHandle> {
		await Promise.resolve();
		if (displayId === this.failOpenOn) throw new CaptureError("permission-denied", "-3801");
		const h = this.next++;
		this.streams.set(h, { displayId, source, width, height, fps, seq: 1 });
		return h;
	}
	streamRead(handle: StreamHandle, dest: Rect, out: RgbaImage): number {
		const s = this.streams.get(handle);
		if (!s) throw new CaptureError("invalid-argument", "unknown stream");
		paint(out, dest, [0, 0, 200]);
		return s.seq;
	}
	streamClose(handle: StreamHandle): void {
		this.closed.push(handle);
	}
	reset(): void {
		this.resetCalls++;
	}
}

describe("MacCaptureSource", () => {
	// Retina main display + 1x external on its right (points).
	const macShell = [display(1, rect(0, 0, 1512, 982), 2, true), display(2, rect(1512, 0, 1920, 1080), 1)];

	test("Snip: one SCScreenshotManager shot per display piece, display-local points", async () => {
		const binding = new FakeMacBinding();
		const source = new MacCaptureSource({ binding, shellDisplays: () => macShell });
		const f = await source.capture(rect(1312, 100, 400, 120));
		expect([f.width, f.height, f.scale]).toEqual([800, 240, 2]);
		expect(binding.shots).toEqual([
			{ displayId: 1, source: rect(1312, 100, 200, 120), dest: rect(0, 0, 400, 240) },
			{ displayId: 2, source: rect(0, 100, 200, 120), dest: rect(400, 0, 400, 240) },
		]);
		expect(pixelAt(f, 799, 239)).toEqual([200, 0, 0]);
		expect(source.exclusion).toBe("filter");
	});

	test("Live: one stream per piece, sequences folded, all closed with the session", async () => {
		const binding = new FakeMacBinding();
		const source = new MacCaptureSource({ binding, shellDisplays: () => macShell });
		const s = await source.openSession(rect(1312, 100, 400, 120), { fps: 3 });
		expect([...binding.streams.values()].map((x) => [x.displayId, x.width, x.height, x.fps])).toEqual([
			[1, 400, 240, 3],
			[2, 400, 240, 3],
		]);
		const a = await s.next();
		const b = await s.next();
		const second = binding.streams.get(2n);
		if (second) second.seq = 5;
		const c = await s.next();
		expect([b.sequence, c.sequence]).toEqual([a.sequence, a.sequence + 1]);
		s.close();
		expect(binding.closed).toEqual([1n, 2n]);
		source.dispose();
		expect(binding.resetCalls).toBe(1);
	});

	test("a failed stream open closes the streams already started", async () => {
		const binding = new FakeMacBinding();
		binding.failOpenOn = 2;
		const source = new MacCaptureSource({ binding, shellDisplays: () => macShell });
		await expect(source.openSession(rect(1312, 100, 400, 120), { fps: 3 })).rejects.toMatchObject({
			code: "permission-denied",
		});
		expect(binding.closed).toEqual([1n]);
	});

	test("setExcludedWindows reaches the filter; failures are reported, not thrown", () => {
		const binding = new FakeMacBinding();
		const errors: unknown[] = [];
		const source = new MacCaptureSource({
			binding,
			shellDisplays: () => macShell,
			onExclusionError: (e) => errors.push(e),
		});
		source.setExcludedWindows([11, 12]);
		expect(binding.excluded).toEqual([[11, 12]]);
		binding.setExcludedWindows = () => {
			throw new CaptureError("timeout", "updateContentFilter timed out");
		};
		source.setExcludedWindows([11]);
		expect(errors).toHaveLength(1);
		// The stream refilter runs on the helper queue; its failures arrive later.
		binding.backgroundError?.(new CaptureError("timeout", "refilter timed out"));
		expect(errors).toHaveLength(2);
	});

	test("GLIM-97: a capture in flight doesn't hold up other work on the worker", async () => {
		const binding = new FakeMacBinding();
		let release = () => {};
		binding.gate = new Promise<void>((r) => {
			release = r;
		});
		const source = new MacCaptureSource({ binding, shellDisplays: () => macShell });
		const order: string[] = [];
		const shot = source.capture(rect(1312, 100, 400, 120)).then(() => order.push("capture"));
		// An RPC round trip stands in for any other handler on the worker.
		await new Promise<void>((r) => setTimeout(r, 0)).then(() => order.push("rpc"));
		// Both pieces were asked for at once, not one after the other.
		expect(binding.shots).toHaveLength(2);
		release();
		await shot;
		expect(order).toEqual(["rpc", "capture"]);
	});

	test("GLIM-97: one failed piece rejects the shot with its CaptureError", async () => {
		const binding = new FakeMacBinding();
		const shot = binding.shot.bind(binding);
		binding.shot = async (displayId, source, dest, out) => {
			if (displayId === 2) throw new CaptureError("permission-denied", "-3801");
			return shot(displayId, source, dest, out);
		};
		const source = new MacCaptureSource({ binding, shellDisplays: () => macShell });
		await expect(source.capture(rect(1312, 100, 400, 120))).rejects.toMatchObject({ code: "permission-denied" });
	});
});

describe("native display lists (harness --native)", () => {
	test("Windows: logical = physical / (dpi / 96)", () => {
		expect(displaysFromWindows(physical)[0]).toMatchObject({ bounds: rect(0, 0, 2560, 1440), scaleFactor: 1.5 });
	});
	test("macOS: CoreGraphics points are already logical", () => {
		expect(displaysFromMac([{ id: 7, bounds: rect(0, 0, 1512, 982), scale: 2, primary: true }])).toEqual([
			display(7, rect(0, 0, 1512, 982), 2, true),
		]);
	});
});

describe("SequenceTracker", () => {
	test("moves only when a piece moved", () => {
		const t = new SequenceTracker();
		expect(t.update([5, 9])).toBe(1);
		expect(t.update([5, 9])).toBe(1);
		expect(t.update([5, 10])).toBe(2);
		t.invalidate();
		expect(t.update([5, 10])).toBe(3);
	});
});
