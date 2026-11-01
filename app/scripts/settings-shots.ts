// Screenshots of the Settings window (GLIM-69) over fake data, with the gallery's headless
// Chromium tooling. Builds the dev-only settings-preview view and renders each pane per OS
// and appearance.
//
//   bun scripts/settings-shots.ts                 serve on http://localhost:4318
//   bun scripts/settings-shots.ts --shots <dir>   write <variant>.png, fail on console errors
//
// Committed set: docs/design/screens/settings/ (regenerate after changing Settings).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildViews } from "./build-views.ts";
import { type GalleryVariant, serve, shoot } from "./gallery.ts";

const W = 760;
const H = 820;

const v = (name: string, query: string, colorScheme: "light" | "dark", height = H): GalleryVariant => ({
	name,
	query,
	colorScheme,
	width: W,
	height,
	fullPage: false,
});

export const SETTINGS_VARIANTS: GalleryVariant[] = [
	v("general-macos-light", "os=macos&pane=general", "light", 1100),
	v("general-macos-dark", "os=macos&pane=general", "dark", 1100),
	v("general-windows-light", "os=windows&pane=general", "light", 1100),
	v("languages-macos-light", "os=macos&pane=languages", "light"),
	v("languages-windows-dark", "os=windows&pane=languages", "dark"),
	v("shortcuts-macos-light-conflict", "os=macos&pane=shortcuts&scenario=conflict", "light"),
	v("shortcuts-windows-light", "os=windows&pane=shortcuts", "light"),
	v("providers-macos-light", "os=macos&pane=providers", "light", 1180),
	v("providers-windows-dark", "os=windows&pane=providers", "dark", 1180),
	v("providers-macos-light-cloud", "os=macos&pane=providers&scenario=cloud", "light", 1180),
	v("providers-windows-light-cloud", "os=windows&pane=providers&scenario=cloud", "light", 1180),
	v("providers-macos-dark-cloud", "os=macos&pane=providers&scenario=cloud", "dark", 1180),
	v("providers-windows-light-no-keychain", "os=windows&pane=providers&scenario=no-keychain", "light", 760),
	v("models-macos-light", "os=macos&pane=models", "light", 1100),
	v("models-windows-dark", "os=windows&pane=models", "dark", 1100),
	v("models-macos-light-catalogue-idle", "os=macos&pane=models&scenario=idle", "light", 1100),
	v("privacy-macos-light", "os=macos&pane=privacy", "light"),
	v("privacy-windows-light", "os=windows&pane=privacy", "light"),
	v("about-macos-light", "os=macos&pane=about", "light", 560),
	v("about-windows-dark", "os=windows&pane=about", "dark", 560),
	v("languages-macos-light-rtl", "os=macos&pane=languages&dir=rtl", "light"),
];

if (import.meta.main) {
	const shotsIndex = process.argv.indexOf("--shots");
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-settings-"));
	await buildViews({ dev: true, outDir: tmp, views: ["settings-preview"] });
	const dir = join(tmp, "settings-preview");
	if (shotsIndex < 0) {
		const server = await serve(dir, 4318);
		console.log(`settings preview: http://localhost:${server.port}/?os=macos&pane=general`);
	} else {
		const outArg = process.argv[shotsIndex + 1];
		if (!outArg) throw new Error("--shots needs an output directory");
		const outDir = resolve(outArg);
		mkdirSync(outDir, { recursive: true });
		const server = await serve(dir, 0);
		try {
			const problems = await shoot(`http://localhost:${server.port}`, outDir, SETTINGS_VARIANTS);
			console.log(`settings: wrote ${SETTINGS_VARIANTS.length} screenshots to ${outDir}`);
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
