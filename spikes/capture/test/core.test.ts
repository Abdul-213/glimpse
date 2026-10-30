import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { fixedRateLoop, latencyBench, type BenchDeps } from "../src/core/bench";
import { derivePermission, SCK_USER_DECLINED } from "../src/core/permission";
import {
	allocRgba,
	bgraToRgbaInPlace,
	blitBgra,
	diffFraction,
	fillOpaqueBlack,
	imageStats,
	rgbaToChwFloat32,
	sampleHash,
} from "../src/core/pixels";
import { crc32, encodePng } from "../src/core/png";
import { percentile, summarize } from "../src/core/stats";
import { bundlePathFrom, parseCodesign } from "../src/app/mac-signature";
import { libCandidates } from "../src/native/lib";
import { standardRegions } from "../src/app/runner";

describe("stats", () => {
	test("nearest-rank percentiles", () => {
		const xs = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50
		expect(percentile(xs, 50)).toBe(25);
		expect(percentile(xs, 95)).toBe(48);
		expect(percentile(xs, 100)).toBe(50);
		const s = summarize([3, 1, 2]);
		expect([s.min, s.p50, s.max, s.mean]).toEqual([1, 2, 3, 2]);
		expect(Number.isNaN(summarize([]).p50)).toBe(true);
	});
});

describe("pixels", () => {
	test("BGRA -> RGBA swap and strided blit", () => {
		const d = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
		bgraToRgbaInPlace(d);
		expect([...d]).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);

		// 2x2 source with 12-byte stride (4 bytes padding per row)
		const src = Uint8Array.of(10, 20, 30, 0, 11, 21, 31, 0, 99, 99, 99, 99, 12, 22, 32, 0, 13, 23, 33, 0, 99, 99, 99, 99);
		const dst = allocRgba(3, 3);
		fillOpaqueBlack(dst);
		blitBgra(src, 12, dst, 1, 1, 2, 2);
		const px = (x: number, y: number) => [...dst.data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
		expect(px(0, 0)).toEqual([0, 0, 0, 255]);
		expect(px(1, 1)).toEqual([30, 20, 10, 255]);
		expect(px(2, 2)).toEqual([33, 23, 13, 255]);
	});

	test("stats, hashes and diff", () => {
		const a = allocRgba(4, 4);
		fillOpaqueBlack(a);
		const s = imageStats(a);
		expect(s.flatFraction).toBe(1);
		expect(s.allOpaque).toBe(true);
		const b = allocRgba(4, 4);
		b.data.set(a.data);
		expect(sampleHash(a, 1)).toBe(sampleHash(b, 1));
		b.data[0] = 200;
		expect(sampleHash(a, 1)).not.toBe(sampleHash(b, 1));
		expect(diffFraction(a, b)).toBeCloseTo(1 / 16);
	});

	test("RGBA -> CHW float tensor", () => {
		const img = allocRgba(2, 1);
		img.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
		const t = rgbaToChwFloat32(img, [0, 0, 0], [1, 1, 1]);
		expect([...t]).toEqual([1, 0, 0, 1, 0, 0]); // R plane, G plane, B plane
	});
});

describe("png", () => {
	test("crc32 known value", () => {
		expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
	});
	test("encodes a decodable RGBA PNG", () => {
		const img = allocRgba(3, 2);
		for (let i = 0; i < img.data.length; i++) img.data[i] = i;
		const png = encodePng(img);
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const v = new DataView(png.buffer, png.byteOffset);
		expect(v.getUint32(16)).toBe(3);
		expect(v.getUint32(20)).toBe(2);
		// IDAT starts after sig(8) + IHDR(25)
		const idatLen = v.getUint32(33);
		const raw = inflateSync(png.subarray(41, 41 + idatLen));
		expect(raw.length).toBe((3 * 4 + 1) * 2);
		expect([...raw.subarray(1, 13)]).toEqual([...img.data.subarray(0, 12)]);
	});
});

function fakeDeps(costMs: (i: number) => number) {
	let t = 0;
	let cpu = 0;
	let calls = 0;
	const deps: BenchDeps = {
		now: () => t,
		sleep: async (ms) => {
			t += Math.max(0, ms);
		},
		cpuMicros: () => cpu,
	};
	const capture = () => {
		const c = costMs(calls++);
		t += c;
		cpu += c * 500; // capture burns half a core
		return calls; // always "changed"
	};
	return { deps, capture, calls: () => calls };
}

describe("bench", () => {
	test("latency bench separates warmup", async () => {
		const f = fakeDeps((i) => (i === 0 ? 100 : 5));
		const r = await latencyBench("x", () => void f.capture(), 10, 1, f.deps);
		expect(r.warmupMs).toEqual([100]);
		expect(r.summary.n).toBe(10);
		expect(r.summary.p95).toBe(5);
	});

	test("fixed-rate loop: no drops when fast", async () => {
		const f = fakeDeps(() => 20);
		const r = await fixedRateLoop("x", f.capture, 4, 30_000, f.deps);
		expect(r.ticksScheduled).toBe(120);
		expect(r.framesCaptured).toBe(120);
		expect(r.dropped).toBe(0);
		expect(r.cpuPercent).toBeCloseTo((20 * 0.5 * 120 * 100) / r.durationMs, 1);
	});

	test("fixed-rate loop: a 600 ms stall drops two ticks, then resyncs", async () => {
		const f = fakeDeps((i) => (i === 3 ? 600 : 10));
		const r = await fixedRateLoop("x", f.capture, 4, 5_000, f.deps);
		expect(r.ticksScheduled).toBe(20);
		expect(r.dropped).toBe(2);
		expect(r.framesCaptured).toBe(18);
	});

	test("fixed-rate loop: always-slow capture drops every other tick", async () => {
		const f = fakeDeps(() => 300);
		const r = await fixedRateLoop("x", f.capture, 4, 10_000, f.deps);
		expect(r.framesCaptured + r.dropped).toBe(r.ticksScheduled);
		expect(r.dropped).toBe(20);
	});

	test("failures are counted, not thrown", async () => {
		const f = fakeDeps(() => 1);
		const r = await fixedRateLoop(
			"x",
			() => {
				f.capture();
				throw new Error("boom");
			},
			4,
			1000,
			f.deps,
		);
		expect(r.failures).toBe(4);
		expect(r.firstError).toBe("boom");
	});
});

describe("permission", () => {
	test("tri-state derivation", () => {
		expect(derivePermission({ preflight: true, everRequested: false }).state).toBe("granted");
		expect(derivePermission({ preflight: false, everRequested: false }).state).toBe("not-determined");
		expect(derivePermission({ preflight: false, everRequested: true }).state).toBe("denied-or-restart-needed");
		expect(
			derivePermission({
				preflight: true,
				everRequested: true,
				sckProbe: { ok: false, code: SCK_USER_DECLINED, message: "declined" },
			}).state,
		).toBe("granted-but-capture-failing");
	});
});

describe("mac signature parsing", () => {
	test("bundle path from execPath", () => {
		expect(bundlePathFrom("/Applications/Glimpse Capture Spike.app/Contents/MacOS/bun")).toBe(
			"/Applications/Glimpse Capture Spike.app",
		);
		expect(bundlePathFrom("/opt/homebrew/bin/bun")).toBeNull();
	});
	test("codesign -dvvv output", () => {
		const adhoc = `Executable=/x.app/Contents/MacOS/launcher
Identifier=dev.glimpse.spike.capture
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=30+0 location=embedded
CDHash=0123abcd
Signature=adhoc
TeamIdentifier=not set`;
		expect(parseCodesign(adhoc)).toEqual({
			identifier: "dev.glimpse.spike.capture",
			teamIdentifier: "not set",
			cdhash: "0123abcd",
			signature: "adhoc",
		});
		const self = `Identifier=dev.glimpse.spike.capture
CodeDirectory v=20500 size=1 flags=0x0(none)
CDHash=ffff
Authority=Glimpse Spike Self-Signed
TeamIdentifier=not set`;
		expect(parseCodesign(self).signature).toBe("Glimpse Spike Self-Signed");
	});
});

describe("library lookup", () => {
	test("candidates include bundle and dev paths", () => {
		// Normalise separators: on Windows the candidates come back with "\\".
		const c = libCandidates("win32", "/app/Resources/app/bun").map((p) => p.replaceAll("\\", "/"));
		expect(c.some((p) => p.endsWith("/app/Resources/app/native/glimcapture.dll"))).toBe(true);
		expect(c.some((p) => p.endsWith("native/windows/build/glimcapture.dll"))).toBe(true);
		expect(libCandidates("darwin", "/x")[0]).toMatch(/libglimcapture\.dylib$/);
	});
});

describe("standard regions", () => {
	test("small, large, large-px and span", () => {
		const r = standardRegions([
			{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, pixelScale: 2, uiScale: 2, primary: true },
			{ id: 2, bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, pixelScale: 1, uiScale: 1, primary: false },
		]);
		expect(r.small.width).toBe(400);
		expect(r.large).toEqual({ x: 0, y: 0, width: 1512, height: 982 });
		expect(r.largePx).toEqual({ x: 0, y: 0, width: 960, height: 540 });
		expect(r.span).toBeDefined();
	});
});
