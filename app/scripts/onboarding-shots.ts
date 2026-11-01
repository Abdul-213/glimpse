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

const SA = "mode=screen-access";

export const ONBOARDING_VARIANTS: GalleryVariant[] = [
	// First-run setup (GLIM-76)
	v("setup-welcome-macos-light", "os=macos&step=welcome&scenario=pick", "light"),
	v("setup-welcome-windows-light", "os=windows&step=welcome&scenario=pick", "light"),
	v("setup-screen-access-macos-light", "os=macos&step=screen-access", "light"),
	v("setup-screen-access-macos-dark-restart", "os=macos&step=screen-access&access=denied-opened", "dark"),
	v("setup-language-macos-light", "os=macos&step=language&access=granted", "light"),
	v("setup-language-windows-dark", "os=windows&step=language", "dark"),
	v("setup-downloads-macos-light-pick", "os=macos&step=downloads&scenario=pick&access=granted", "light"),
	v("setup-downloads-macos-light-downloading", "os=macos&step=downloads&scenario=downloading&access=granted", "light"),
	v("setup-downloads-windows-dark-downloading", "os=windows&step=downloads&scenario=downloading", "dark"),
	v("setup-downloads-macos-light-offline", "os=macos&step=downloads&scenario=offline&access=granted", "light"),
	v("setup-downloads-macos-light-failed", "os=macos&step=downloads&scenario=failed&access=granted", "light"),
	v(
		"setup-downloads-macos-light-resumed",
		"os=macos&step=downloads&scenario=downloading&resumed=1&access=granted",
		"light",
	),
	v("setup-shortcuts-macos-light", "os=macos&step=shortcuts&access=granted", "light"),
	v("setup-shortcuts-windows-light-conflict", "os=windows&step=shortcuts&scenario=conflict", "light"),
	v("setup-done-macos-light", "os=macos&step=done&access=granted", "light"),
	v("setup-done-windows-dark", "os=windows&step=done", "dark"),
	v("setup-language-macos-light-rtl", "os=macos&step=language&access=granted&dir=rtl", "light"),
	// Screen access alone (GLIM-45)
	v("access-not-determined-macos-light", `${SA}&os=macos&access=not-determined`, "light"),
	v("access-not-determined-macos-dark", `${SA}&os=macos&access=not-determined`, "dark"),
	v("access-denied-macos-light", `${SA}&os=macos&access=denied`, "light"),
	v("access-restart-macos-light", `${SA}&os=macos&access=denied-opened`, "light"),
	v("access-lost-macos-light", `${SA}&os=macos&access=lost`, "light"),
	v("access-lost-macos-dark", `${SA}&os=macos&access=lost-opened`, "dark"),
	v("access-granted-macos-light", `${SA}&os=macos&access=granted`, "light"),
	v("access-lost-macos-light-rtl", `${SA}&os=macos&access=lost&dir=rtl`, "light"),
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
