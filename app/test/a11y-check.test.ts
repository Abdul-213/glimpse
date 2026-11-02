// GLIM-83: the accessibility report (the checks themselves run headless in CI).
import { describe, expect, test } from "bun:test";
import { type PageResult, renderA11yReport } from "../scripts/a11y-check.ts";
import { surfacePages } from "../scripts/preview-surfaces.ts";

describe("accessibility report", () => {
	test("summarises per surface and lists every finding", () => {
		const [a, b] = surfacePages().filter((p) => p.surface === "snip-popup");
		if (!a || !b) throw new Error("no pages");
		const results: PageResult[] = [
			{
				page: a,
				axe: [
					{
						id: "list",
						impact: "serious",
						help: "Lists",
						nodes: [{ target: "#x", html: "<ul>", summary: "div in ul" }],
					},
				],
				contrastUndecided: 3,
				keyboard: { stops: ['button "Close"'], invisible: ['button "Close"'], unreachable: ['button "Retry"'] },
				motion: ["slide on div.x"],
			},
			{ page: b, axe: [], keyboard: { stops: [], invisible: [], unreachable: [] }, motion: [] },
		];
		const md = renderA11yReport(results);
		expect(md).toContain("| snip-popup | 2 | list | 3 | 1 | 1 | 1 |");
		expect(md).toContain("axe `list` (serious)");
		expect(md).toContain('focus without a visible ring: button "Close"');
		expect(md).toContain('not reachable with Tab: button "Retry"');
		expect(md).toContain("moves under reduced motion: slide on div.x");
		expect(md).not.toContain(`**snip-popup / ${b.name}**`);
	});
});
