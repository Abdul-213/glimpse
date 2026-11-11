// Dev-only component gallery (GLIM-42, GLIM-51): builds app/src/views/gallery and either
// serves it for a plain browser or renders every variant to PNG with headless Chromium.
//
//   bun scripts/gallery.ts                 serve on http://localhost:4317 (Ctrl+C to stop)
//   bun scripts/gallery.ts --shots <dir>   write <variant>.png files, fail on console errors
//
// Screenshots need Playwright's Chromium headless shell matching playwright-core
// (`bunx playwright-core install --only-shell chromium`). It is a dev dependency only.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildViews } from "./build-views.ts";

export interface GalleryVariant {
	name: string;
	query: string;
	colorScheme: "light" | "dark";
	width: number;
	/** Viewport height (default 900). */
	height?: number;
	/** Capture the whole page (default) or just the viewport. */
	fullPage?: boolean;
}

/** The committed set: both OSes in both appearances, RTL UI, Windows 10, the script matrix. */
export const VARIANTS: GalleryVariant[] = [
	{ name: "components-macos-light", query: "os=macos", colorScheme: "light", width: 1320 },
	{ name: "components-macos-dark", query: "os=macos", colorScheme: "dark", width: 1320 },
	{ name: "components-windows-light", query: "os=windows", colorScheme: "light", width: 1320 },
	{ name: "components-windows-dark", query: "os=windows", colorScheme: "dark", width: 1320 },
	{ name: "components-macos-light-rtl", query: "os=macos&dir=rtl", colorScheme: "light", width: 1320 },
	{ name: "components-win10-light", query: "os=win10", colorScheme: "light", width: 1320 },
	{ name: "scripts-macos-light", query: "os=macos&page=scripts", colorScheme: "light", width: 1320 },
	{ name: "scripts-windows-dark", query: "os=windows&page=scripts", colorScheme: "dark", width: 1320 },
	{ name: "scripts-macos-light-rtl", query: "os=macos&page=scripts&dir=rtl", colorScheme: "light", width: 1320 },
];

export async function serve(dir: string, port: number) {
	return Bun.serve({
		port,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const file = Bun.file(join(dir, path === "/" ? "index.html" : path.slice(1)));
			return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
		},
	});
}

export async function shoot(baseUrl: string, outDir: string, variants: GalleryVariant[]): Promise<string[]> {
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch();
	const problems: string[] = [];
	try {
		for (const v of variants) {
			const page = await browser.newPage({
				viewport: { width: v.width, height: v.height ?? 900 },
				deviceScaleFactor: 1,
				colorScheme: v.colorScheme,
				// Freeze motion so stills are deterministic (the flash specimen holds its own frame).
				reducedMotion: "reduce",
			});
			page.on("console", (m) => {
				if (m.type() === "error" || m.type() === "warning")
					problems.push(`${v.name}: console ${m.type()}: ${m.text()}`);
			});
			page.on("pageerror", (e) => problems.push(`${v.name}: ${e.message}`));
			page.on("requestfailed", (r) => problems.push(`${v.name}: request failed ${r.url()}`));
			await page.goto(`${baseUrl}/?${v.query}`, { waitUntil: "networkidle" });
			await page.evaluate(() => document.fonts.ready);
			const blank = await page.evaluate(() => (document.getElementById("root")?.textContent ?? "").trim().length === 0);
			if (blank) problems.push(`${v.name}: rendered nothing`);
			await page.screenshot({ path: join(outDir, `${v.name}.png`), fullPage: v.fullPage ?? true });
			await page.close();
		}
	} finally {
		await browser.close();
	}
	return problems;
}

if (import.meta.main) {
	const shotsIndex = process.argv.indexOf("--shots");
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-gallery-"));
	await buildViews({ dev: true, outDir: tmp, views: ["gallery"] });
	const dir = join(tmp, "gallery");

	if (shotsIndex < 0) {
		const server = await serve(dir, 4317);
		console.log(
			`gallery: http://localhost:${server.port}/  (?os=windows|win10 &dir=rtl &material=native &page=scripts; appearance follows the browser)`,
		);
	} else {
		const outArg = process.argv[shotsIndex + 1];
		if (!outArg) throw new Error("--shots needs an output directory");
		const outDir = resolve(outArg);
		mkdirSync(outDir, { recursive: true });
		const server = await serve(dir, 0);
		try {
			const problems = await shoot(`http://localhost:${server.port}`, outDir, VARIANTS);
			console.log(`gallery: wrote ${VARIANTS.length} screenshots to ${outDir}`);
			if (problems.length > 0) {
				for (const p of problems) console.error(p);
				process.exitCode = 1;
			}
		} finally {
			server.stop(true);
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}
