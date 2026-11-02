// GLIM-80: E3 "Translate on this device" appears only when the local packs are installed.
import { describe, expect, test } from "bun:test";
import { initialSnipState, languageCode, type SnipPopupState } from "@glimpse/core";
import { errorBody, packConfirmText, packProgressLabel, packRowText, partialOcrText } from "../src/views/popup/copy.ts";

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

describe("GLIM-126 partial on-device OCR note", () => {
	test("names the languages", () => {
		expect(partialOcrText(["Vietnamese"])).toBe(
			"Vietnamese tone marks are often lost when text is read on this device.",
		);
	});
});

describe("GLIM-138 large downloads", () => {
	const row = (lang: string, bytes: number, kind?: "long-tail-model") => ({
		lang: languageCode(lang),
		state: "missing" as const,
		bytes,
		received: null,
		total: null,
		resourceIds: [kind ? "small100" : `bergamot-${lang}en`],
		blockIds: ["b1"],
		...(kind ? { kind } : {}),
	});
	const e2 = (packs: SnipPopupState["packs"]) => errorBody("packMissing", { ...state, packs }, "macos", "en");

	test("the long-tail model row names the model; Bergamot rows are unchanged", () => {
		expect(packRowText("sw", "en", "long-tail-model")).toBe("Swahili needs the More languages model.");
		expect(packRowText("el", "en")).toBe("Greek isn't downloaded yet.");
		expect(packProgressLabel("sw", "en", "long-tail-model")).toBe("Downloading the More languages model");
		expect(packProgressLabel("el", "en")).toBe("Downloading Greek");
	});

	test("the question says what it is, its size and what it's for", () => {
		expect(packConfirmText(row("sw", 618_000_000, "long-tail-model"), "en")).toBe(
			"Download the More languages model (618\u00a0MB)? It translates Swahili and about 100 other languages on this " +
				"device. It's slower than language packs and uses about 1 GB of memory while it translates.",
		);
		expect(packConfirmText(row("el", 250_000_000), "en")).toBe(
			"Download 250\u00a0MB to translate Greek? This is a large download.",
		);
	});

	test("E2: the long-tail model's Download asks first; a Bergamot pack's doesn't", () => {
		const sw = e2([row("sw", 618_000_000, "long-tail-model")]);
		expect(sw.body).toContain("needs the More languages model to translate Swahili");
		expect(sw.buttons[0]).toMatchObject({ action: "download", label: "Download (618 MB)", lang: "sw" });
		expect(sw.buttons[0]?.confirm).toContain("More languages model (618\u00a0MB)");
		const el = e2([row("el", 31_000_000)]);
		expect(el.buttons[0]).toMatchObject({ label: "Download Greek (31 MB)" });
		expect(el.buttons[0]?.confirm).toBeUndefined();
	});
});
