import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rect } from "@glimpse/core";
import { chooseCaptureBackend, createCaptureSource, SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";

describe("capture backend selection", () => {
	test("native on Windows and macOS, file on Linux", () => {
		expect(chooseCaptureBackend("win32", {})).toEqual({ kind: "windows" });
		expect(chooseCaptureBackend("darwin", {})).toEqual({ kind: "macos" });
		expect(chooseCaptureBackend("linux", {})).toEqual({ kind: "file", path: SAMPLE_FRAMES_DIR });
	});

	test("environment overrides", () => {
		expect(chooseCaptureBackend("darwin", { GLIMPSE_CAPTURE_FRAMES: "/rec" })).toEqual({ kind: "file", path: "/rec" });
		expect(chooseCaptureBackend("win32", { GLIMPSE_CAPTURE: "file" })).toMatchObject({ kind: "file" });
		expect(chooseCaptureBackend("darwin", { GLIMPSE_CAPTURE: "native", GLIMPSE_CAPTURE_FRAMES: "/rec" })).toEqual({
			kind: "macos",
		});
		expect(chooseCaptureBackend("linux", { GLIMPSE_CAPTURE: "native" })).toMatchObject({ kind: "none" });
		expect(chooseCaptureBackend("win32", { GLIMPSE_CAPTURE: "dxgi" })).toMatchObject({ kind: "none" });
	});

	test("createCaptureSource never throws", async () => {
		const ok = createCaptureSource({ platform: "linux", env: {} });
		expect(ok.source.backend).toBe("file");
		expect(ok.status).toContain("4 frames");
		const bad = createCaptureSource({
			platform: "linux",
			env: { GLIMPSE_CAPTURE_FRAMES: join(SAMPLE_FRAMES_DIR, "nope") },
		});
		expect(bad.source.backend).toBe("unavailable");
		await expect(bad.source.capture(rect(0, 0, 1, 1))).rejects.toMatchObject({ code: "unavailable" });
		// On the Linux test machine neither native helper can load.
		for (const platform of ["darwin", "win32"]) {
			const setup = createCaptureSource({ platform, env: {} });
			expect(setup.source.backend).toBe("unavailable");
			await expect(setup.source.openSession(rect(0, 0, 1, 1), { fps: 2 })).rejects.toMatchObject({
				code: "unavailable",
			});
		}
	});
});
