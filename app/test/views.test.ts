// Builds the real webviews with the production pipeline (Bun bundler + Solid +
// Tailwind + Electrobun devkit alias) into a temp dir and checks the output.
// Needs the devkit: run `hutch electrobun sync` in app/ once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViews } from "../scripts/build-views.ts";

const outDir = mkdtempSync(join(tmpdir(), "glimpse-views-"));
const read = (path: string) => Bun.file(join(outDir, path)).text();

beforeAll(async () => {
	await buildViews({ outDir, views: ["settings"] });
}, 60_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("settings view build", () => {
	test("html references the bundled script and stylesheet relatively", async () => {
		const html = await read("settings/index.html");
		expect(html).toContain('src="./index.js"');
		expect(html).toContain('href="./index.css"');
	});

	test("JSX is compiled by Solid, not left for a React-style runtime", async () => {
		const js = await read("settings/index.js");
		expect(js).toContain("<nav"); // Solid's template() strings carry the static HTML
		expect(js).not.toContain("jsxDEV");
		expect(js).not.toContain("react");
	});

	test("electrobun/view is bundled from the devkit", async () => {
		const js = await read("settings/index.js");
		expect(js).toContain("__electrobunWebviewId");
	});

	test("Tailwind emits DESIGN.md token utilities", async () => {
		const css = await read("settings/index.css");
		expect(css).toContain("--color-surface-popup-solid");
		expect(css).toMatch(/\.bg-surface-popup-solid\s*\{/);
		expect(css).toMatch(/\.rounded-control\s*\{/);
		expect(css).toMatch(/\[data-os="?windows"?\]/);
		// The default Tailwind palette is switched off: only DESIGN.md colours exist.
		expect(css).not.toContain("--color-red-500");
	});
});
