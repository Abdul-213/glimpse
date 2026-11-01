// GLIM-80: E3 "Translate on this device" appears only when the local packs are installed.
import { describe, expect, test } from "bun:test";
import { initialSnipState, type SnipPopupState } from "@glimpse/core";
import { errorBody } from "../src/views/popup/copy.ts";

const state: SnipPopupState = {
	...initialSnipState("r"),
	translatorProvider: { id: "cloud:google-translate-v2", kind: "cloud", name: "Google Cloud Translation" },
};
const actions = (kind: Parameters<typeof errorBody>[0], local: boolean) =>
	errorBody(kind, state, "windows", "en", local).buttons.map((b) => `${b.action}${b.primary ? "*" : ""}`);

describe("E3 actions (snip-popup.md §12)", () => {
	test("without local packs: no Translate on this device", () => {
		expect(actions("providerQuota", false)).toEqual(["retry"]);
		expect(actions("offline", false)).toEqual(["retry*"]);
		expect(actions("providerTimeout", false)).toEqual(["retry*"]);
		expect(actions("providerKey", false)).toEqual(["checkKey*", "retry"]);
	});

	test("with local packs: offered on every E3 variant, primary for a used-up quota", () => {
		expect(actions("providerQuota", true)).toEqual(["local*"]);
		expect(actions("offline", true)).toEqual(["retry*", "local"]);
		expect(actions("providerTimeout", true)).toEqual(["retry*", "local"]);
		expect(actions("providerKey", true)).toEqual(["checkKey*", "local"]);
	});

	test("E3 names the cloud translator the run started with", () => {
		expect(errorBody("providerKey", state, "macos", "en").title).toBe("Google Cloud Translation rejected the API key");
	});

	test("other errors never offer it", () => {
		expect(actions("noText", true)).not.toContain("local");
	});
});
