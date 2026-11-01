// Native-side pure parts: library lookup, string reading, status-code mapping.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { libraryCandidates, nativeOsFor, readNativeString } from "../src/bun/native/load.ts";
import {
	captureErrorFor,
	describeStatus,
	GLIM_E_NO_DISPLAY,
	GLIM_E_PERMISSION,
	GLIM_E_TIMEOUT,
} from "../src/bun/native/status.ts";

describe("native library lookup", () => {
	test("maps platforms to helper OSes", () => {
		expect(nativeOsFor("darwin")).toBe("macos");
		expect(nativeOsFor("win32")).toBe("windows");
		expect(nativeOsFor("linux")).toBeNull();
	});

	test("bundle path, then dev build path; env override first", () => {
		const bundled = "/App/Contents/Resources/app/bun";
		expect(libraryCandidates("macos", bundled, {})).toEqual([
			"/App/Contents/Resources/app/native/libglimpse.dylib",
			resolve(bundled, "../../../native/macos/build/libglimpse.dylib"),
		]);
		const src = "/repo/app/src/bun/native";
		expect(libraryCandidates("windows", src, { GLIMPSE_NATIVE_LIB: "/tmp/x.dll" })).toEqual([
			"/tmp/x.dll",
			"/repo/app/src/bun/native/glimpse.dll",
			"/repo/app/native/windows/build/glimpse.dll",
		]);
	});

	test("readNativeString grows the buffer when the text doesn't fit", () => {
		const text = "x".repeat(5000);
		const bytes = new TextEncoder().encode(text);
		const calls: number[] = [];
		const out = readNativeString((buf, cap) => {
			calls.push(cap);
			const n = Math.min(bytes.length, cap - 1);
			buf.set(bytes.subarray(0, n));
			buf[n] = 0;
			return bytes.length;
		}, 16);
		expect(out).toBe(text);
		expect(calls).toEqual([16, 5001]);
	});
});

describe("status codes", () => {
	test("Glimpse's own codes", () => {
		expect(describeStatus("windows", GLIM_E_NO_DISPLAY).code).toBe("no-display");
		expect(describeStatus("macos", GLIM_E_TIMEOUT).code).toBe("timeout");
		expect(describeStatus("macos", GLIM_E_PERMISSION).code).toBe("permission-denied");
	});

	test("HRESULTs on Windows", () => {
		expect(describeStatus("windows", 0x80070005 | 0)).toMatchObject({ code: "temporarily-unavailable" });
		expect(describeStatus("windows", 0x887a0004 | 0).code).toBe("unavailable");
		expect(describeStatus("windows", 0x80004005 | 0)).toEqual({ code: "failed", text: "status 0x80004005" });
	});

	test("ScreenCaptureKit errors on macOS", () => {
		expect(describeStatus("macos", -3801).code).toBe("permission-denied");
		expect(describeStatus("macos", -9999)).toEqual({ code: "failed", text: "status -9999" });
	});

	test("captureErrorFor carries code, status and the native detail", () => {
		const e = captureErrorFor("macos", "screenshot", -3801, "SCStreamErrorDomain -3801");
		expect(e.code).toBe("permission-denied");
		expect(e.status).toBe(-3801);
		expect(e.message).toContain("screenshot failed");
		expect(e.message).toContain("SCStreamErrorDomain -3801");
	});
});
