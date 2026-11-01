import { describe, expect, test } from "bun:test";
import { rect } from "@glimpse/core";
import { chooseCaptureBackend, createCaptureSource } from "../src/bun/services/capture/index.ts";

describe("capture backend selection", () => {
	test("native on Windows and macOS, none elsewhere", () => {
		expect(chooseCaptureBackend("win32", {})).toEqual({ kind: "windows" });
		expect(chooseCaptureBackend("darwin", {})).toEqual({ kind: "macos" });
		expect(chooseCaptureBackend("linux", {})).toMatchObject({ kind: "none" });
		expect(chooseCaptureBackend("win32", { GLIMPSE_CAPTURE: "dxgi" })).toMatchObject({ kind: "none" });
	});

	test("createCaptureSource never throws: without a helper it gives an unavailable source", async () => {
		// On the Linux test machine neither helper can load.
		for (const platform of ["darwin", "win32", "linux"]) {
			const setup = createCaptureSource({ platform, env: {} });
			expect(setup.source.backend).toBe("unavailable");
			expect(setup.status).toContain("unavailable");
			await expect(setup.source.capture(rect(0, 0, 1, 1))).rejects.toMatchObject({ code: "unavailable" });
			await expect(setup.source.openSession(rect(0, 0, 1, 1), { fps: 2 })).rejects.toMatchObject({
				code: "unavailable",
			});
		}
	});
});
