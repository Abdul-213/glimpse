// Electrobun postBuild and postWrap hook (electrobun.config.ts `scripts`). Like prebuild.ts,
// Hutch imports this from a runner, so the work happens at top level.
//
// macOS only: mark every bundle as an accessory app (LSUIElement, GLIM-106; see
// mac-accessory.ts). Other OSes: nothing to do.
import { type HookEnv, infoPlistTargets, isMacBuild, plutilCommands } from "./mac-accessory.ts";

const env: HookEnv = {
	ELECTROBUN_OS: process.env["ELECTROBUN_OS"],
	ELECTROBUN_BUILD_DIR: process.env["ELECTROBUN_BUILD_DIR"],
	ELECTROBUN_WRAPPER_BUNDLE_PATH: process.env["ELECTROBUN_WRAPPER_BUNDLE_PATH"],
};
if (isMacBuild(env)) {
	const plists = infoPlistTargets(env);
	if (plists.length === 0) {
		console.warn(
			"[postbuild] WARNING: no .app bundle found; Glimpse will show a Dock icon until it starts (GLIM-106).",
		);
	}
	for (const plist of plists) {
		for (const cmd of plutilCommands(plist)) {
			const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
			if (r.exitCode !== 0) throw new Error(`[postbuild] ${cmd.join(" ")} failed (${r.exitCode})`);
		}
		console.log(`[postbuild] LSUIElement=YES -> ${plist}`);
	}
}
