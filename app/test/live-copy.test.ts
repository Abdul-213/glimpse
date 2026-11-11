// Live popup copy that needs @glimpse/ui (which loads Solid's browser build): a DOM first.
import "../../packages/ui/test/dom.ts";
import { describe, expect, test } from "bun:test";
import { errorCopy, moveAnnouncement, moveHint } from "../src/views/live/copy.ts";
import { liveKey, liveMoveKey } from "../src/views/live/keys.ts";

describe("Live error copy", () => {
	test("spend guard (GLIM-120): Continue this month first, then Stop", () => {
		const c = errorCopy({ kind: "spendCap", message: "paused" });
		expect(c.title).toBe("Cloud use is paused for this month");
		expect(c.body).toContain("Continuing may cost money");
		expect(c.actions.map((a) => [a.action, a.primary])).toEqual([
			["continueCloud", true],
			["stop", false],
		]);
	});
});
describe("Live view: move keys and copy (GLIM-151)", () => {
	const k = (key: string, mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
		key,
		altKey: false,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		...mods,
	});
	test("Alt/Option+arrows, Shift for large steps; plain arrows and Ctrl/⌘ combos are not moves", () => {
		expect(liveMoveKey(k("ArrowLeft", { altKey: true }))).toEqual({ direction: "left", large: false });
		expect(liveMoveKey(k("ArrowDown", { altKey: true, shiftKey: true }))).toEqual({ direction: "down", large: true });
		expect(liveMoveKey(k("ArrowUp"))).toBeNull();
		expect(liveMoveKey(k("ArrowUp", { altKey: true, metaKey: true }))).toBeNull();
		expect(liveMoveKey(k("ArrowUp", { altKey: true, ctrlKey: true }))).toBeNull();
		expect(liveMoveKey(k("a", { altKey: true }))).toBeNull();
		// The popup's own keys never take Alt, so the two maps can't collide.
		expect(liveKey(k("ArrowLeft", { altKey: true }), false)).toBeNull();
	});

	test("announcements and the hint", () => {
		expect(moveAnnouncement("moved", [])).toBe("Popup moved");
		expect(moveAnnouncement("moved", ["left", "top"])).toBe("Popup at the left and top edge of the screen");
		expect(moveAnnouncement("docked", [])).toBe("Popup docked next to the area");
		expect(moveHint(true)).toContain("Option+arrow");
		expect(moveHint(false)).toContain("Alt+arrow");
	});
});
