// Live popup copy that needs @glimpse/ui (which loads Solid's browser build): a DOM first.
import "../../packages/ui/test/dom.ts";
import { describe, expect, test } from "bun:test";
import { errorCopy } from "../src/views/live/copy.ts";

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
