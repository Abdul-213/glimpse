import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import {
	CONTROL_RGB,
	METHODS,
	POPUP_RGB,
	SHARING_NONE,
	SHARING_READ_ONLY,
	WDA_EXCLUDEFROMCAPTURE,
	WDA_MONITOR,
	WDA_NONE,
	affinityName,
	captureFileName,
	countMarkers,
	describeWin32Error,
	expectationFor,
	expectedForAffinity,
	intersect,
	mergeCounts,
	parseMacVersion,
	regionAroundPopup,
	sharingName,
	toIntRect,
	verdict,
	windowsSupportsExclude,
} from "../src/shared/analysis";
import { PNG_SIGNATURE, bgraToRgbaOpaque, crc32, encodePng } from "../src/shared/png";

/** Synthetic "screenshot": grey background, optional green and magenta blocks. */
function scene(w: number, h: number, opts: { popup?: boolean; control?: boolean; black?: boolean } = {}) {
	const px = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const x = i % w;
		const y = Math.floor(i / w);
		let c: readonly number[] = opts.black ? [0, 0, 0] : [90, 90, 100];
		if (opts.control && x < w / 2) c = CONTROL_RGB;
		if (opts.popup && x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4) c = POPUP_RGB;
		px.set([c[0]!, c[1]!, c[2]!, 255], i * 4);
	}
	return px;
}

describe("png", () => {
	test("crc32 matches the standard check value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	test("encodes a decodable RGBA PNG", () => {
		const w = 3;
		const h = 2;
		const px = new Uint8Array(w * h * 4).map((_, i) => (i * 7) & 0xff);
		const png = encodePng(px, w, h);
		expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
		const dv = new DataView(png.buffer, png.byteOffset);
		// IHDR
		expect(dv.getUint32(8)).toBe(13);
		expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
		expect(dv.getUint32(16)).toBe(w);
		expect(dv.getUint32(20)).toBe(h);
		expect(png[24]).toBe(8);
		expect(png[25]).toBe(6);
		expect(dv.getUint32(29)).toBe(crc32(png, 12, 29));
		// IDAT round trip
		const idatLen = dv.getUint32(33);
		expect(new TextDecoder().decode(png.subarray(37, 41))).toBe("IDAT");
		const raw = new Uint8Array(inflateSync(png.subarray(41, 41 + idatLen)));
		expect(raw.length).toBe((w * 4 + 1) * h);
		expect(raw[0]).toBe(0);
		expect([...raw.subarray(1, 1 + w * 4)]).toEqual([...px.subarray(0, w * 4)]);
		expect([...raw.subarray(w * 4 + 2)]).toEqual([...px.subarray(w * 4)]);
		expect(dv.getUint32(41 + idatLen)).toBe(crc32(png, 37, 41 + idatLen));
		// IEND
		expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
	});

	test("rejects wrong buffer sizes", () => {
		expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow();
		expect(() => encodePng(new Uint8Array(0), 0, 0)).toThrow();
	});

	test("BGRA to opaque RGBA", () => {
		const px = new Uint8Array([1, 2, 3, 0, 10, 20, 30, 0]);
		expect([...bgraToRgbaOpaque(px)]).toEqual([3, 2, 1, 255, 30, 20, 10, 255]);
	});
});

describe("marker detection and verdicts", () => {
	test("counts popup and control pixels", () => {
		const c = countMarkers(scene(100, 100, { popup: true, control: true }), 100, 100);
		expect(c.total).toBe(10000);
		expect(c.popup).toBe(2500);
		expect(c.control).toBe(3750); // left half (5000) minus the popup overlap (25x50)
		expect(c.nonBlack).toBe(10000);
	});

	test("tolerates colour-managed magenta and green", () => {
		const px = new Uint8Array([235, 51, 247, 255, 52, 234, 40, 255]);
		const c = countMarkers(px, 2, 1);
		expect(c.popup).toBe(1);
		expect(c.control).toBe(1);
	});

	test("PASS when popup absent and control present", () => {
		const c = countMarkers(scene(100, 100, { control: true }), 100, 100);
		expect(verdict(c, { popup: "absent", control: "present" }).result).toBe("PASS");
	});

	test("FAIL when the excluded popup shows up", () => {
		const c = countMarkers(scene(100, 100, { popup: true, control: true }), 100, 100);
		const v = verdict(c, { popup: "absent", control: "present" });
		expect(v.result).toBe("FAIL");
		expect(v.popup).toBe("present");
	});

	test("INCONCLUSIVE when the capture is black (no permission / WDA_MONITOR full screen)", () => {
		const c = countMarkers(scene(100, 100, { black: true }), 100, 100);
		expect(verdict(c, { popup: "absent", control: "present" }).result).toBe("INCONCLUSIVE");
	});

	test("INCONCLUSIVE when the control window is missing too", () => {
		const c = countMarkers(scene(100, 100), 100, 100);
		expect(verdict(c, { popup: "absent", control: "present" }).result).toBe("INCONCLUSIVE");
	});

	test("exclude-app mode expects the control window to be gone", () => {
		const gone = countMarkers(scene(100, 100), 100, 100);
		expect(verdict(gone, { popup: "absent", control: "absent" }).result).toBe("PASS");
		const there = countMarkers(scene(100, 100, { control: true }), 100, 100);
		expect(verdict(there, { popup: "absent", control: "absent" }).result).toBe("FAIL");
	});

	test("observe mode reports without judging", () => {
		const c = countMarkers(scene(100, 100, { popup: true, control: true }), 100, 100);
		const v = verdict(c, { popup: "observe", control: "present" });
		expect(v.result).toBe("OBSERVED");
		expect(v.popup).toBe("present");
	});

	test("mergeCounts sums per-display counts", () => {
		const a = countMarkers(scene(50, 50, { popup: true }), 50, 50);
		const b = countMarkers(scene(50, 50, { control: true }), 50, 50);
		const m = mergeCounts([a, b]);
		expect(m.total).toBe(5000);
		expect(m.popup).toBe(a.popup);
		expect(m.control).toBe(b.control);
	});
});

describe("rectangles", () => {
	test("intersect", () => {
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
			x: 5,
			y: 5,
			width: 5,
			height: 5,
		});
		expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
	});

	test("toIntRect covers fractional edges", () => {
		expect(toIntRect({ x: 1.5, y: 2.2, width: 3, height: 3 })).toEqual({ x: 1, y: 2, width: 4, height: 4 });
	});

	test("region around popup is clipped to its display", () => {
		const displays = [
			{ x: 0, y: 0, width: 1920, height: 1080 },
			{ x: 1920, y: 0, width: 1280, height: 1024 },
		];
		expect(regionAroundPopup({ x: 10, y: 10, width: 340, height: 160 }, displays)).toEqual({
			x: 0,
			y: 0,
			width: 390,
			height: 210,
		});
		// mostly on the second display
		const r = regionAroundPopup({ x: 1900, y: 100, width: 340, height: 160 }, displays)!;
		expect(r.x).toBe(1920);
		expect(r.width).toBe(1900 + 340 + 40 - 1920);
		expect(regionAroundPopup({ x: 5000, y: 5000, width: 10, height: 10 }, displays)).toBeNull();
	});
});

describe("Windows affinity logic", () => {
	test("names and build gate", () => {
		expect(affinityName(WDA_EXCLUDEFROMCAPTURE)).toBe("WDA_EXCLUDEFROMCAPTURE");
		expect(affinityName(WDA_MONITOR)).toBe("WDA_MONITOR");
		expect(affinityName(WDA_NONE)).toBe("WDA_NONE");
		expect(windowsSupportsExclude(19041)).toBe(true);
		expect(windowsSupportsExclude(18363)).toBe(false);
		expect(windowsSupportsExclude(26100)).toBe(true);
	});

	test("expected popup presence per affinity", () => {
		expect(expectedForAffinity(WDA_NONE, 22631)).toBe("present");
		expect(expectedForAffinity(WDA_EXCLUDEFROMCAPTURE, 22631)).toBe("absent");
		expect(expectedForAffinity(WDA_MONITOR, 22631)).toBe("absent"); // black box, no magenta
		expect(expectedForAffinity(WDA_EXCLUDEFROMCAPTURE, 18363)).toBe("absent"); // acts as MONITOR
	});

	test("win32 error text", () => {
		expect(describeWin32Error(87)).toContain("INVALID_PARAMETER");
		expect(describeWin32Error(12345)).toBe("12345");
	});
});

describe("macOS logic", () => {
	test("sharingType names", () => {
		expect(sharingName(SHARING_NONE)).toBe("none");
		expect(sharingName(SHARING_READ_ONLY)).toBe("readOnly");
		expect(sharingName(2)).toBe("readWrite");
	});

	test("parses macOS versions", () => {
		expect(parseMacVersion("15.3.1")).toEqual({ major: 15, minor: 3, patch: 1 });
		expect(parseMacVersion("26.0")).toEqual({ major: 26, minor: 0, patch: 0 });
		expect(parseMacVersion("x")).toBeNull();
	});
});

describe("method expectations", () => {
	test("every method has a platform and an expectation", () => {
		for (const m of METHODS) {
			const e = expectationFor(m.id, { platform: m.platform, affinity: WDA_EXCLUDEFROMCAPTURE, winBuild: 22631, sharingType: SHARING_NONE });
			expect(["present", "absent", "observe", "any"]).toContain(e.popup);
		}
	});

	test("Windows expectations follow the affinity", () => {
		expect(expectationFor("win-gdi-bitblt", { platform: "win32", affinity: WDA_EXCLUDEFROMCAPTURE, winBuild: 22631 })).toEqual({
			popup: "absent",
			control: "present",
		});
		expect(expectationFor("win-gdi-bitblt", { platform: "win32", affinity: WDA_NONE, winBuild: 22631 }).popup).toBe("present");
	});

	test("macOS: SCK filter must exclude regardless of sharingType; no-filter is the open question", () => {
		for (const sharingType of [SHARING_NONE, SHARING_READ_ONLY]) {
			expect(expectationFor("mac-sck-exclude-window", { platform: "darwin", sharingType }).popup).toBe("absent");
			expect(expectationFor("mac-sck-exclude-app", { platform: "darwin", sharingType }).control).toBe("absent");
		}
		expect(expectationFor("mac-sck-no-filter", { platform: "darwin", sharingType: SHARING_NONE }).popup).toBe("observe");
		expect(expectationFor("mac-sck-no-filter", { platform: "darwin", sharingType: SHARING_READ_ONLY }).popup).toBe("present");
	});

	test("capture file names are filesystem-safe", () => {
		const n = captureFileName("mac-sck-exclude-window", new Date("2026-10-30T12:34:56.789Z"), "display1");
		expect(n).toBe("2026-10-30_12-34-56-789_mac-sck-exclude-window_display1.png");
		expect(n).not.toMatch(/[:\\/]/);
	});
});
