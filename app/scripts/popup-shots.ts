// Snip popup preview and screenshots (GLIM-65..74): builds scripts/popup-preview (the real
// SnipPopup view over scenario states folded through the real reducer) and either serves it
// or renders each scenario to PNG with headless Chromium, like gallery.ts.
//
//   bun app/scripts/popup-shots.ts --serve                 http://localhost:4318/?os=windows
//   bun app/scripts/popup-shots.ts --shots docs/design/screens/snip-popup
//
// Needs Playwright's Chromium headless shell (`bunx playwright-core install --only-shell chromium`).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";
import { ALL_SCENARIOS as SCENARIOS } from "./popup-preview/scenarios.ts";
import { solidPlugin } from "./solid-plugin.ts";

export interface ShotVariant {
	/** File-name suffix. */
	readonly suffix: string;
	readonly query: string;
	readonly colorScheme: "light" | "dark";
	/** Scenarios to shoot in this variant (default: all). */
	readonly only?: readonly string[];
}

/** Every state on macOS light; the main path and the edge cases on Windows dark, RTL UI and Windows 10. */
export const VARIANTS: readonly ShotVariant[] = [
	{ suffix: "macos-light", query: "os=macos", colorScheme: "light" },
	{
		suffix: "windows-dark",
		query: "os=windows",
		colorScheme: "dark",
		only: [
			"s0-opened",
			"s3-streaming",
			"s4-done",
			"s7-skipped-expanded",
			"s9-rtl-source",
			"s12-long",
			"s14-cloud",
			"e1-no-text",
			"e2-pack-missing",
			"e3-offline",
			"e4w-capture-blank",
			"s16-partial-pack-row",
			"s6-original-view",
		],
	},
	{ suffix: "macos-dark", query: "os=macos", colorScheme: "dark", only: ["s4-done", "s8-mixed-languages"] },
	{
		suffix: "macos-light-rtl-ui",
		query: "os=macos&dir=rtl",
		colorScheme: "light",
		only: ["s10-rtl-target", "s6-original-view"],
	},
	{ suffix: "win10-light", query: "os=win10", colorScheme: "light", only: ["s4-done"] },
];

async function build(outDir: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [join(import.meta.dir, "popup-preview", "index.html")],
		outdir: outDir,
		target: "browser",
		format: "esm",
		plugins: [solidPlugin(), tailwind],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("popup preview build failed");
	}
}

function serve(dir: string, port: number) {
	return Bun.serve({
		port,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const file = Bun.file(join(dir, path === "/" ? "index.html" : path.slice(1)));
			return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
		},
	});
}

async function shoot(baseUrl: string, outDir: string): Promise<{ files: string[]; problems: string[] }> {
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch();
	const problems: string[] = [];
	const files: string[] = [];
	try {
		for (const v of VARIANTS) {
			for (const s of SCENARIOS) {
				if (v.only && !v.only.includes(s.name)) continue;
				const name = `${s.name}-${v.suffix}`;
				const page = await browser.newPage({
					viewport: { width: 640, height: 900 },
					deviceScaleFactor: 2,
					colorScheme: v.colorScheme,
					reducedMotion: "reduce",
				});
				page.on("console", (m) => {
					if (m.type() === "error" || m.type() === "warning")
						problems.push(`${name}: console ${m.type()}: ${m.text()}`);
				});
				page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
				await page.goto(`${baseUrl}/?${v.query}&scenario=${s.name}`, { waitUntil: "networkidle" });
				await page.evaluate(() => document.fonts.ready);
				// Painted (two frames) and resized to its content, like the real window before it shows.
				await page.waitForFunction(() => document.body.dataset["painted"] === "1");
				await page.waitForTimeout(50);
				const frame = page.locator(".preview-frame");
				const box = await frame.boundingBox();
				if (!box || box.height < 40) problems.push(`${name}: popup did not render`);
				const file = join(outDir, `${name}.png`);
				// 16px of desktop around the popup.
				if (box) {
					await page.screenshot({
						path: file,
						clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 },
					});
					files.push(file);
				}
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}
	return { files, problems };
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { serve: { type: "boolean" }, shots: { type: "string" }, port: { type: "string", default: "4318" } },
	});
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-popup-"));
	await build(tmp);
	if (values.serve || !values.shots) {
		const server = serve(tmp, Number(values.port));
		console.log(`popup preview: http://localhost:${server.port}/  (?scenario=s4-done &os=windows|win10 &dir=rtl)`);
	} else {
		const outDir = resolve(values.shots);
		mkdirSync(outDir, { recursive: true });
		const server = serve(tmp, 0);
		try {
			const { files, problems } = await shoot(`http://localhost:${server.port}`, outDir);
			console.log(`popup: wrote ${files.length} screenshots to ${outDir}`);
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
