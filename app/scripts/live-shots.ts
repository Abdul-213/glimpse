// Live popup preview and screenshots (GLIM-79..92): builds scripts/live-preview (the real
// LivePopup view over scenario states folded through the real reducer) and either serves it
// or renders each scenario to PNG with headless Chromium, like popup-shots.ts.
//
//   bun app/scripts/live-shots.ts --serve                 http://localhost:4319/?os=windows
//   bun app/scripts/live-shots.ts --shots docs/design/screens/live-popup
//
// Needs Playwright's Chromium headless shell (`bunx playwright-core install --only-shell chromium`).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";
import { LIVE_SCENARIOS } from "./live-preview/scenarios.ts";
import { solidPlugin } from "./solid-plugin.ts";

interface ShotVariant {
	readonly suffix: string;
	readonly query: string;
	readonly colorScheme: "light" | "dark";
	readonly only?: readonly string[];
}

/** Every state on macOS dark (Live sits over games and video); the main path elsewhere. */
const VARIANTS: readonly ShotVariant[] = [
	{ suffix: "macos-dark", query: "os=macos", colorScheme: "dark" },
	{
		suffix: "macos-light",
		query: "os=macos",
		colorScheme: "light",
		only: ["l1-running", "l4-changed", "l5-paused", "l9-cloud", "l10-consent", "l22-moved", "l23-unpinned"],
	},
	{
		suffix: "windows-dark",
		query: "os=windows",
		colorScheme: "dark",
		only: [
			"l1-running",
			"l4-changed",
			"l5-paused",
			"l10-consent",
			"l16-ocr-stopped",
			"l21-compact",
			"l20-chat-side",
			"l11-skipped-expanded",
			"l12-pack-missing",
			"l22-moved",
			"l23-unpinned",
			"l24-moved-compact",
		],
	},
	{ suffix: "macos-dark-rtl-ui", query: "os=macos&dir=rtl", colorScheme: "dark", only: ["l4-changed"] },
	{ suffix: "win10-light", query: "os=win10", colorScheme: "light", only: ["l4-changed"] },
];

async function build(outDir: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [join(import.meta.dir, "live-preview", "index.html")],
		outdir: outDir,
		target: "browser",
		format: "esm",
		plugins: [solidPlugin(), tailwind],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("live preview build failed");
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
			for (const s of LIVE_SCENARIOS) {
				if (v.only && !v.only.includes(s.name)) continue;
				const name = `${s.name}-${v.suffix}`;
				const page = await browser.newPage({
					viewport: { width: 720, height: 700 },
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
				await page.waitForFunction(() => document.body.dataset["painted"] === "1");
				if (s.click) await page.locator(s.click).first().click();
				await page.waitForTimeout(80);
				const box = await page.locator(".preview-frame").boundingBox();
				if (!box || box.height < 40) problems.push(`${name}: popup did not render`);
				if (box) {
					const file = join(outDir, `${name}.png`);
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
		options: { serve: { type: "boolean" }, shots: { type: "string" }, port: { type: "string", default: "4319" } },
	});
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-live-"));
	await build(tmp);
	if (values.serve || !values.shots) {
		const server = serve(tmp, Number(values.port));
		console.log(`live preview: http://localhost:${server.port}/  (?scenario=l4-changed &os=windows|win10 &dir=rtl)`);
	} else {
		const outDir = resolve(values.shots);
		mkdirSync(outDir, { recursive: true });
		const server = serve(tmp, 0);
		try {
			const { files, problems } = await shoot(`http://localhost:${server.port}`, outDir);
			console.log(`live: wrote ${files.length} screenshots to ${outDir}`);
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
