// GLIM-158: the overlay toggle has to work and be findable. 0.0.3 shipped the Snip footer
// toggle with its intents never wired to RPC (the button and Ctrl/⌘⇧T did nothing), so this
// checks that every view → main message of both popups is actually sent by the view entry.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { overlayHintText, overlayHintVisible } from "../src/views/popup/copy.ts";

const src = (p: string) => Bun.file(join(import.meta.dir, "../src", p)).text();

/** The message names in the `bun:` half of an RPC schema file. */
async function bunMessages(file: string): Promise<string[]> {
	const text = await src(file);
	const bun = text.slice(text.indexOf("bun: RPCSchema"), text.indexOf("webview: RPCSchema"));
	const messages = bun.slice(bun.indexOf("messages: {"));
	return [...messages.matchAll(/^\t{3}(\w+): /gm)].map((m) => m[1] as string);
}

describe("view → main messages are all sent (GLIM-158)", () => {
	test("Snip popup: snipOverlay, snipPeek and the rest", async () => {
		const names = await bunMessages("shared/popup-rpc.ts");
		expect(names).toContain("snipOverlay");
		expect(names).toContain("snipPeek");
		expect(names).toContain("snipOverlayHintSeen");
		const view = await src("views/popup/index.tsx");
		for (const n of names) expect(view, n).toContain(`rpc.send.${n}(`);
	});

	test("Live popup: overlayToggled and the rest", async () => {
		const names = await bunMessages("shared/live-rpc.ts");
		expect(names).toContain("overlayToggled");
		const view = await src("views/live/index.tsx");
		for (const n of names) expect(view, n).toContain(`rpc.send.${n}(`);
	});
});

describe("the one-time On screen hint (GLIM-158)", () => {
	const base = { offered: true, shownFor: null, requestId: "r1", canOverlay: true, overlayOn: false };

	test("shows on the first Snip with something to put on screen", () => {
		expect(overlayHintVisible(base)).toBe(true);
		expect(overlayHintVisible({ ...base, shownFor: "r1" })).toBe(true);
	});

	test("never after it was seen, on a later Snip, or once the toggle was used", () => {
		expect(overlayHintVisible({ ...base, offered: false })).toBe(false);
		expect(overlayHintVisible({ ...base, shownFor: "r1", requestId: "r2" })).toBe(false);
		expect(overlayHintVisible({ ...base, shownFor: "" })).toBe(false);
	});

	test("not while the overlay is on or there is nothing to translate", () => {
		expect(overlayHintVisible({ ...base, overlayOn: true })).toBe(false);
		expect(overlayHintVisible({ ...base, canOverlay: false })).toBe(false);
	});

	test("names the toggle and its key", () => {
		expect(overlayHintText("Ctrl+Shift+T")).toBe("Tip: On screen (Ctrl+Shift+T) puts translations over the text.");
	});
});
