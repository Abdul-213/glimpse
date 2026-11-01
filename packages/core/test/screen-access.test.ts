import { describe, expect, test } from "bun:test";
import { canCapture, deriveScreenAccess, nextScreenAccessMemory } from "../src/index.ts";

describe("GLIM-45 screen access state", () => {
	test("Windows needs no permission", () => {
		expect(deriveScreenAccess({ required: false, preflight: false, memory: "unknown" })).toBe("not-needed");
		expect(canCapture("not-needed")).toBe(true);
	});

	test("preflight true is granted, whatever was remembered", () => {
		for (const memory of ["unknown", "requested", "granted"] as const) {
			expect(deriveScreenAccess({ required: true, preflight: true, memory })).toBe("granted");
		}
	});

	test("never asked: not determined (asking shows the system prompt)", () => {
		expect(deriveScreenAccess({ required: true, preflight: false, memory: "unknown" })).toBe("not-determined");
	});

	test("asked before: denied, or granted and waiting for a restart", () => {
		expect(deriveScreenAccess({ required: true, preflight: false, memory: "requested" })).toBe("denied");
	});

	test("had it before: lost (an update of an ad-hoc signed build, or revoked)", () => {
		expect(deriveScreenAccess({ required: true, preflight: false, memory: "granted" })).toBe("lost");
	});

	test("preflight cached true but capture refused: lost", () => {
		expect(deriveScreenAccess({ required: true, preflight: true, memory: "granted", captureDenied: true })).toBe(
			"lost",
		);
		expect(canCapture("lost")).toBe(false);
	});

	test("memory only moves forward", () => {
		expect(nextScreenAccessMemory("unknown", { granted: false })).toBe("unknown");
		expect(nextScreenAccessMemory("unknown", { granted: false, requested: true })).toBe("requested");
		expect(nextScreenAccessMemory("requested", { granted: true })).toBe("granted");
		expect(nextScreenAccessMemory("granted", { granted: false, requested: true })).toBe("granted");
	});
});
