// Screenshots of the onboarding window (GLIM-45, GLIM-76) over fake data, with the gallery's
// headless Chromium tooling. Builds the dev-only onboarding-preview view and renders each
// state per OS and appearance at the window's size (560 x 480).
//
//   bun scripts/onboarding-shots.ts                 serve on http://localhost:4319
//   bun scripts/onboarding-shots.ts --shots <dir>   write <variant>.png, fail on console errors
//
// Committed set: docs/design/screens/onboarding/ (regenerate after changing onboarding).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildViews } from "./build-views.ts";
import { type GalleryVariant, serve, shoot } from "./gallery.ts";

const v = (name: string, query: string, colorScheme: "light" | "dark"): GalleryVariant => ({
	name,
	query,
	colorScheme,
	width: 560,
	height: 480,
	fullPage: false,
});

export const ONBOARDING_VARIANTS: GalleryVariant[] = [
	v("access-not-determined-macos-light", "os=macos&access=not-determined", "light"),
	v("access-not-determined-macos-dark", "os=macos&access=not-determined", "dark"),
	v("access-denied-macos-light", "os=macos&access=denied", "light"),
	v("access-restart-macos-light", "os=macos&access=denied-opened", "light"),
	v("access-lost-macos-light", "os=macos&access=lost", "light"),
	v("access-lost-macos-dark", "os=macos&access=lost-opened", "dark"),
	v("access-granted-macos-light", "os=macos&access=granted", "light"),
	v("access-lost-macos-light-rtl", "os=macos&access=lost&dir=rtl", "light"),
];

if (import.meta.main) {
	const shotsIndex = process.argv.indexOf("--shots");
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-onboarding-"));
	await buildViews({ dev: true, outDir: tmp, views: ["onboarding-preview"] });
	const dir = join(tmp, "onboarding-preview");
	if (shotsIndex < 0) {
		const server = await serve(dir, 4319);
		console.log(`onboarding preview: http://localhost:${server.port}/?os=macos&access=not-determined`);
	} else {
		const outArg = process.argv[shotsIndex + 1];
		if (!outArg) throw new Error("--shots needs an output directory");
		const outDir = resolve(outArg);
		mkdirSync(outDir, { recursive: true });
		const server = await serve(dir, 0);
		try {
			const problems = await shoot(`http://localhost:${server.port}`, outDir, ONBOARDING_VARIANTS);
			console.log(`onboarding: wrote ${ONBOARDING_VARIANTS.length} screenshots to ${outDir}`);
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
