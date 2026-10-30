// End-to-end through the real bun:ffi binding, against native/fake/fakecapture.c
// (built here with the system C compiler). Skipped if no compiler is available.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latencyBench } from "../src/core/bench";
import { planCapture } from "../src/core/geometry";
import { nativeCapturer, runSuite } from "../src/app/runner";
import { NativeLib } from "../src/native/lib";

const root = join(import.meta.dir, "..");
const so = join(root, "native", "fake", "build", "libfakecapture.so");
let built = false;

beforeAll(() => {
	if (process.platform !== "linux") return;
	mkdirSync(join(root, "native", "fake", "build"), { recursive: true });
	const r = spawnSync("cc", ["-O2", "-shared", "-fPIC", "-Wall", "-Werror", "-o", so, join(root, "native", "fake", "fakecapture.c")]);
	built = r.status === 0;
});

describe("bun:ffi binding (fake native library)", () => {
	test.skipIf(process.platform !== "linux")("displays, capture composition, errors", () => {
		expect(built).toBe(true);
		for (const symbols of ["darwin", "win32"]) {
			const lib = NativeLib.loadFrom(so, symbols);
			const info = lib.displays();
			expect(info.displays).toHaveLength(2);

			// Spans display 1 (2x) and display 2 (1x): 40x10 pt -> 80x20 px.
			const region = { x: 180, y: 10, width: 40, height: 10 };
			const cap = nativeCapturer(lib, "sck-shot");
			const img = cap.grab(region);
			expect([img.width, img.height]).toEqual([80, 20]);
			const px = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
			// Left half from display 1, local x 180..200; right half from display 2, local x 0..20.
			expect(px(0, 0)).toEqual([40, 180, 10, 255]);
			expect(px(39, 0)[0]).toBe(40);
			expect(px(40, 0)).toEqual([80, 0, 10, 255]);
			expect(px(79, 19)).toEqual([80, 19, 19, 255]);

			// Off-screen part is opaque black.
			const off = cap.grab({ x: 280, y: 90, width: 40, height: 20 });
			expect([...off.data.subarray(off.data.length - 4)]).toEqual([0, 0, 0, 255]);

			// Native errors surface with the native message.
			expect(() => lib.capture("gdi", planCapture(region, info.displays), img)).toThrow(/unknown backend 10/);
			if (symbols === "darwin") {
				expect(lib.macPreflight()).toBe(true);
				expect(lib.macSckProbe()).toEqual({ ok: false, code: -3801, message: expect.stringContaining("declined") });
			} else {
				expect(lib.wgcRequestBorderless()).toEqual({ status: 4, meaning: "Allowed" });
			}
			expect(lib.stats()).toEqual({ fake: true });
		}
	});

	test.skipIf(process.platform !== "linux")("FFI overhead for a 400x120 grab is small", async () => {
		const lib = NativeLib.loadFrom(so, "darwin");
		const cap = nativeCapturer(lib, "sck-stream");
		const region = { x: 0, y: 0, width: 200, height: 60 }; // 400x120 px at 2x
		const r = await latencyBench("fake", () => void cap.grab(region), 50);
		expect(r.failures).toBe(0);
		console.log(`fake 400x120 grab via bun:ffi: p50=${r.summary.p50.toFixed(3)} ms p95=${r.summary.p95.toFixed(3)} ms`);
	});

	test.skipIf(process.platform !== "linux")("suite writes PNGs and results", async () => {
		const dir = mkdtempSync(join(tmpdir(), "glim15-"));
		process.env.GLIM_CAPTURE_OUT = dir;
		const lib = NativeLib.loadFrom(so, "darwin");
		const lines: string[] = [];
		const res = await runSuite(
			[nativeCapturer(lib, "sck-shot")],
			lib.displays().displays,
			(l) => lines.push(l),
			{ n: 5, loopSeconds: 1, fps: 4 },
			lib,
		);
		const rep = res.reports[0]!;
		expect(rep.snapshots.every((s) => !s.error)).toBe(true);
		expect(rep.snapshots.map((s) => s.label)).toContain("span");
		expect(rep.loops[0]!.framesCaptured).toBeGreaterThanOrEqual(3);
		expect(readFileSync(res.file, "utf8")).toContain('"reports"');
		expect(res.markdown).toContain("| sck-shot | small |");
		delete process.env.GLIM_CAPTURE_OUT;
	});
});
