// Builds every webview under src/views/<name>/ into dist/views/<name>/ with Bun's
// bundler: index.html is the entrypoint, Solid JSX goes through babel-preset-solid,
// CSS through Tailwind v4. electrobun.config.ts copies dist/views into the app, where
// windows load it as views://<name>/index.html.
//
// Why not Electrobun's own `build.views`: Hutch bundles those with esbuild and offers
// no plugin hook, so it cannot run the Solid compiler or Tailwind.
//
//   bun scripts/build-views.ts           production build (minified), no dev-only views
//   bun scripts/build-views.ts --dev     unminified, inline source maps, plus the gallery
//   bun scripts/gallery.ts               gallery only, served locally (see that file)
//
// scripts/prebuild.ts runs it as Electrobun's preBuild hook (electrobun.config.ts), so
// `hutch electrobun build|dev` always ships fresh views.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";
import { solidPlugin } from "./solid-plugin.ts";

export const appRoot = resolve(import.meta.dir, "..");
export const viewsSrc = join(appRoot, "src", "views");
export const viewsOut = join(appRoot, "dist", "views");
const devkitRoot = join(appRoot, ".hutch", "devkit");

/**
 * Resolve `electrobun/view` (and any other `electrobun/*` import) to the devkit Hutch
 * projected into .hutch/devkit, the same mapping Electrobun's own Vite helper uses.
 */
export function electrobunDevkitPlugin(root = devkitRoot): BunPlugin {
	return {
		name: "electrobun-devkit",
		async setup(build) {
			const manifestPath = join(root, "package.json");
			if (!existsSync(manifestPath)) {
				throw new Error(`Electrobun devkit missing at ${root}. Run: hutch electrobun sync (in app/)`);
			}
			const manifest = (await Bun.file(manifestPath).json()) as { exports: Record<string, string> };
			build.onResolve({ filter: /^electrobun(\/.*)?$/ }, ({ path }) => {
				const subpath = path === "electrobun" ? "." : `./${path.slice("electrobun/".length)}`;
				const target = manifest.exports[subpath];
				if (!target) throw new Error(`Electrobun devkit does not export ${path}`);
				return { path: join(root, target) };
			});
		},
	};
}

/**
 * Views that only exist for development: the component gallery and font/RTL test page
 * (GLIM-42, GLIM-51), and the Settings preview with fake data (GLIM-69). Built by dev builds and `--gallery`, never shipped in canary/stable.
 */
export const DEV_ONLY_VIEWS: ReadonlySet<string> = new Set(["gallery", "settings-preview", "onboarding-preview"]);

export function listViews(options: { includeDevOnly?: boolean } = {}): string[] {
	return readdirSync(viewsSrc, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(viewsSrc, d.name, "index.html")))
		.map((d) => d.name)
		.filter((name) => options.includeDevOnly || !DEV_ONLY_VIEWS.has(name))
		.sort();
}

export interface BuildViewsOptions {
	dev?: boolean;
	outDir?: string;
	views?: string[];
}

export async function buildViews(options: BuildViewsOptions = {}): Promise<string[]> {
	const dev = options.dev ?? false;
	const outDir = options.outDir ?? viewsOut;
	const views = options.views ?? listViews({ includeDevOnly: dev });
	rmSync(outDir, { recursive: true, force: true });

	for (const name of views) {
		const result = await Bun.build({
			entrypoints: [join(viewsSrc, name, "index.html")],
			outdir: join(outDir, name),
			target: "browser",
			format: "esm",
			minify: !dev,
			sourcemap: dev ? "inline" : "none",
			// Hashless names keep views://<name>/index.html stable and the output diffable.
			naming: { entry: "[name].[ext]", chunk: "[name].[ext]", asset: "[name].[ext]" },
			define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
			plugins: [electrobunDevkitPlugin(), solidPlugin({ dev }), tailwind],
			throw: false,
		});
		if (!result.success) {
			for (const log of result.logs) console.error(log);
			throw new Error(`view "${name}" failed to build`);
		}
	}
	return views;
}

if (import.meta.main) {
	const dev = process.argv.includes("--dev");
	const built = await buildViews({ dev });
	console.log(`built views (${dev ? "dev" : "prod"}): ${built.join(", ")} -> ${viewsOut}`);
}
