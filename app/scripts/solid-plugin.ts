// Bun bundler plugin that compiles Solid JSX (.tsx/.jsx) with babel-preset-solid.
// Bun's own JSX transform targets React-style runtimes; Solid needs its compiler
// to turn JSX into fine-grained DOM updates. Everything else stays with Bun.
import { transformAsync } from "@babel/core";
// babel-preset-solid and @babel/preset-typescript ship no types.
// @ts-expect-error untyped module
import presetTypeScript from "@babel/preset-typescript";
// @ts-expect-error untyped module
import presetSolid from "babel-preset-solid";
import type { BunPlugin } from "bun";

export interface SolidPluginOptions {
	/** "dom" for webviews (default). "ssr" is unused for now. */
	generate?: "dom" | "ssr";
	dev?: boolean;
}

export function solidPlugin(options: SolidPluginOptions = {}): BunPlugin {
	return {
		name: "glimpse-solid",
		setup(build) {
			build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
				const source = await Bun.file(path).text();
				const result = await transformAsync(source, {
					filename: path,
					babelrc: false,
					configFile: false,
					sourceMaps: options.dev ? "inline" : false,
					presets: [
						[presetSolid, { generate: options.generate ?? "dom", hydratable: false, dev: options.dev ?? false }],
						[presetTypeScript, { onlyRemoveTypeImports: true }],
					],
				});
				if (!result?.code) throw new Error(`Solid compile produced no output for ${path}`);
				return { contents: result.code, loader: "js" };
			});
		},
	};
}
