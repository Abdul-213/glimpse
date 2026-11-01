// Builds the picker preview (scripts/picker-preview/, a dev tool) and serves it:
//
//   bun app/scripts/picker-preview.ts [--port 8791] [--out dir]
//   open http://127.0.0.1:8791/?state=drag&os=macos
//
// Same bundler setup as the real views (Solid + Tailwind), without Electrobun: the page
// runs PickerSession itself.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";
import { solidPlugin } from "./solid-plugin.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { port: { type: "string", default: "8791" }, out: { type: "string" }, "build-only": { type: "boolean" } },
});
const outDir = resolve(values.out ?? join(import.meta.dir, "..", "dist", "picker-preview"));
const result = await Bun.build({
	entrypoints: [join(import.meta.dir, "picker-preview", "index.html")],
	outdir: outDir,
	target: "browser",
	format: "esm",
	plugins: [solidPlugin(), tailwind],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`built picker preview -> ${outDir}`);
if (!values["build-only"]) {
	const server = Bun.serve({
		port: Number(values.port),
		hostname: "127.0.0.1",
		fetch(req) {
			const path = new URL(req.url).pathname;
			return new Response(Bun.file(join(outDir, path === "/" ? "index.html" : path)));
		},
	});
	console.log(`serving http://${server.hostname}:${server.port}/`);
}
