// GLIM-52: the design-detector report and the surface list it (and GLIM-83's checker) scan.
import { describe, expect, test } from "bun:test";
import { renderReport } from "../scripts/design-detect.ts";
import { surfacePages } from "../scripts/preview-surfaces.ts";

describe("preview surfaces", () => {
	test("every surface has pages, names are unique per surface", () => {
		const pages = surfacePages();
		for (const s of ["gallery", "settings", "onboarding", "snip-popup", "live-popup", "picker"]) {
			expect(pages.some((p) => p.surface === s)).toBe(true);
		}
		const keys = pages.map((p) => `${p.surface}/${p.name}`);
		expect(new Set(keys).size).toBe(keys.length);
		// RTL UI is covered on the popups and the gallery.
		expect(pages.some((p) => p.surface === "live-popup" && p.path.includes("dir=rtl"))).toBe(true);
		expect(pages.some((p) => p.surface === "snip-popup" && p.path.includes("dir=rtl"))).toBe(true);
	});
});

describe("design detector report", () => {
	test("counts by rule, lists source and rendered findings, keeps advisories apart", () => {
		const page = surfacePages()[0];
		if (!page) throw new Error("no pages");
		const md = renderReport(
			[
				{
					antipattern: "design-system-font",
					name: "Font",
					severity: "warning",
					file: "/x/a.css",
					line: 3,
					snippet: "font X",
				},
			],
			[
				{
					page,
					url: "http://localhost/",
					findings: [
						{
							antipattern: "low-contrast",
							name: "c",
							severity: "warning",
							file: "http://localhost/",
							snippet: "2.9:1",
						},
						{ antipattern: "straggler", name: "s", severity: "advisory", file: "http://localhost/", advisory: true },
					],
				},
			],
			["a note"],
		);
		expect(md).toContain("Source: 1 findings (0 advisory)");
		expect(md).toContain("Rendered: 1 pages, 1 findings.");
		expect(md).toContain("| low-contrast | 1 |");
		expect(md).toContain("| straggler (advisory) | 1 |");
		expect(md).toContain("[design-system-font] font X");
		expect(md).toContain("> a note");
	});
});
