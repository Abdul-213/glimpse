// Regenerates packages/ui/src/styles/tokens.css from DESIGN.md.
//   bun run tokens            write the file
//   bun run tokens --check    exit 1 if the file is stale (used by tests/CI)
import { join } from "node:path";
import { generateTokensCss, type MotionToken, parseDesignFrontmatter } from "./tokens.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");
export const tokensCssPath = join(import.meta.dir, "..", "src", "styles", "tokens.css");

export async function renderTokens(): Promise<string> {
	const design = parseDesignFrontmatter(await Bun.file(join(repoRoot, "DESIGN.md")).text());
	const sidecar = (await Bun.file(join(repoRoot, ".impeccable", "design.json")).json()) as {
		extensions?: { motion?: MotionToken[] };
	};
	return generateTokensCss(design, sidecar.extensions?.motion ?? []);
}

if (import.meta.main) {
	const css = await renderTokens();
	if (process.argv.includes("--check")) {
		const current = await Bun.file(tokensCssPath)
			.text()
			.catch(() => "");
		if (current !== css) {
			console.error("tokens.css is out of date with DESIGN.md. Run: bun run tokens");
			process.exit(1);
		}
		console.log("tokens.css is up to date");
	} else {
		await Bun.write(tokensCssPath, css);
		console.log(`wrote ${tokensCssPath}`);
	}
}
