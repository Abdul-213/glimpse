// Electrobun preBuild hook (electrobun.config.ts `scripts.preBuild`). Hutch imports
// this file from a runner, so `import.meta.main` is false here: do the work at top level.
// Hutch sets ELECTROBUN_BUILD_ENV (dev | canary | stable) and ELECTROBUN_OS.
import { buildViews, viewsOut } from "./build-views.ts";

const dev = process.env["ELECTROBUN_BUILD_ENV"] === "dev";
const built = await buildViews({ dev });
console.log(`[prebuild] views (${dev ? "dev" : "prod"}): ${built.join(", ")} -> ${viewsOut}`);
