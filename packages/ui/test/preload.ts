// bun test preload (bunfig.toml). Two things Bun doesn't do for Solid on its own:
//
// 1. Compile .tsx with babel-preset-solid. Bun's JSX transform is React-style; Solid
//    needs its compiler (the view build uses app/scripts/solid-plugin.ts for the same reason).
// 2. Resolve solid-js to its browser build. Bun matches the "node" export condition, which
//    is Solid's server renderer (no reactivity, no DOM). Component tests run in happy-dom,
//    so they need the client build, as the webviews get from Bun.build's "browser" target.
//
// It only registers a plugin; tests that need a DOM import ./dom.ts first.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { transformAsync } from "@babel/core";
import { plugin } from "bun";

// @ts-expect-error babel-preset-solid ships no types
const presetSolid = (await import("babel-preset-solid")).default;
// @ts-expect-error @babel/preset-typescript ships no types
const presetTypeScript = (await import("@babel/preset-typescript")).default;

const require = createRequire(import.meta.url);
const solidRoot = dirname(require.resolve("solid-js/package.json"));
const browserBuilds: Record<string, string> = {
	"solid-js": join(solidRoot, "dist", "solid.js"),
	"solid-js/web": join(solidRoot, "web", "dist", "web.js"),
	"solid-js/store": join(solidRoot, "store", "dist", "store.js"),
};

plugin({
	name: "glimpse-solid-test",
	setup(build) {
		// Bun's runtime resolver ignores onResolve for bare package specifiers, so swap the
		// server files' contents for the browser builds at load time instead.
		build.onLoad({ filter: /solid-js[/\\](web[/\\]|store[/\\])?dist[/\\]server\.js$/ }, async ({ path }) => {
			const sub = /[/\\](web|store)[/\\]dist[/\\]server\.js$/.exec(path)?.[1];
			const target = browserBuilds[sub ? `solid-js/${sub}` : "solid-js"];
			if (!target) throw new Error(`no browser build for ${path}`);
			return { contents: await Bun.file(target).text(), loader: "js" };
		});
		build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const result = await transformAsync(source, {
				filename: path,
				babelrc: false,
				configFile: false,
				presets: [
					[presetSolid, { generate: "dom", hydratable: false }],
					[presetTypeScript, { onlyRemoveTypeImports: true }],
				],
			});
			if (!result?.code) throw new Error(`Solid compile produced no output for ${path}`);
			return { contents: result.code, loader: "js" };
		});
	},
});
