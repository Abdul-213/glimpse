// Results-layer screenshots (GLIM-115, GLIM-152): builds the picker preview and renders its
// confirmed-Snip states with headless Chromium into docs/design/screens/results-layer.
//
//   bun app/scripts/results-shots.ts [--out docs/design/screens/results-layer]
//
// Needs Playwright's Chromium headless shell (`bunx playwright-core install --only-shell chromium`).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";
import { serve } from "./gallery.ts";
import { solidPlugin } from "./solid-plugin.ts";

interface Shot {
	readonly name: string;
	readonly query: string;
	readonly colorScheme: "light" | "dark";
	/** Crop (CSS px) around the comic page. */
	readonly clip?: { x: number; y: number; width: number; height: number };
}

const PAGE = { x: 16, y: 16, width: 688, height: 768 };
export const RESULTS_SHOTS: readonly Shot[] = [
	{ name: "results-linked-macos-light", query: "os=macos&state=results", colorScheme: "light" },
	{ name: "results-windows-dark", query: "os=windows&state=results&linked=0", colorScheme: "dark" },
	{ name: "comic-badges-macos-light", query: "os=macos&state=comic", colorScheme: "light", clip: PAGE },
	{ name: "comic-overlay-macos-light", query: "os=macos&state=comic-overlay", colorScheme: "light", clip: PAGE },
	{ name: "comic-overlay-windows-dark", query: "os=windows&state=comic-overlay", colorScheme: "dark", clip: PAGE },
	{
		name: "comic-overlay-peek-macos-light",
		query: "os=macos&state=comic-overlay&peek=1",
		colorScheme: "light",
		clip: PAGE,
	},
];

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { out: { type: "string", default: join(import.meta.dir, "../../docs/design/screens/results-layer") } },
	});
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-results-"));
	const outDir = resolve(values.out as string);
	mkdirSync(outDir, { recursive: true });
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "picker-preview", "index.html")],
		outdir: tmp,
		target: "browser",
		format: "esm",
		plugins: [solidPlugin(), tailwind],
	});
	if (!built.success) {
		for (const log of built.logs) console.error(log);
		throw new Error("picker preview build failed");
	}
	const server = await serve(tmp, 0);
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch();
	const problems: string[] = [];
	try {
		for (const s of RESULTS_SHOTS) {
			const page = await browser.newPage({
				viewport: { width: 1280, height: 800 },
				deviceScaleFactor: 2,
				colorScheme: s.colorScheme,
				reducedMotion: "reduce",
			});
			page.on("pageerror", (e) => problems.push(`${s.name}: ${e.message}`));
			await page.goto(`http://localhost:${server.port}/?${s.query}`, { waitUntil: "networkidle" });
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(300);
			await page.screenshot({ path: join(outDir, `${s.name}.png`), ...(s.clip ? { clip: s.clip } : {}) });
			await page.close();
		}
	} finally {
		await browser.close();
		server.stop(true);
		rmSync(tmp, { recursive: true, force: true });
	}
	console.log(`results layer: wrote ${RESULTS_SHOTS.length} screenshots to ${outDir}`);
	if (problems.length > 0) {
		for (const p of problems) console.error(p);
		process.exitCode = 1;
	}
}
