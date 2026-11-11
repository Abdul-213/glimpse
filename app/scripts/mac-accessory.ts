// GLIM-106: Glimpse is a menu-bar app on macOS, so it runs with the accessory activation
// policy: no Dock icon, no app menu, and its picker overlays can join another app's
// fullscreen Space (spikes/overlay/FINDINGS.md §3, region-picker spec §9.1).
//
// `LSUIElement = YES` in Info.plist makes LaunchServices start the app as an accessory, so
// the Dock icon never appears, not even for the moment before the main process runs. The app
// also calls `Utils.setDockIconVisible(false)` at startup (src/bun/index.ts) as a backstop.
//
// Electrobun has no Info.plist option for it, so scripts/postbuild.ts (the postBuild and
// postWrap hooks) adds the key to every bundle it finds: postBuild sees the real app in
// ELECTROBUN_BUILD_DIR before Electrobun packs it into the self-extracting wrapper's
// tarball; postWrap gets the wrapper itself in ELECTROBUN_WRAPPER_BUNDLE_PATH, so the
// extractor doesn't flash a Dock icon on first launch either.
//
// Pure planning (which plists, which plutil calls) is here and tested on Linux.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Keys every Glimpse bundle carries on macOS. */
export const ACCESSORY_KEYS = { LSUIElement: true } as const;

export interface HookEnv {
	readonly ELECTROBUN_OS?: string | undefined;
	readonly ELECTROBUN_BUILD_DIR?: string | undefined;
	readonly ELECTROBUN_WRAPPER_BUNDLE_PATH?: string | undefined;
}

export const isMacBuild = (env: HookEnv, hostPlatform: string = process.platform): boolean =>
	env.ELECTROBUN_OS === "macos" || env.ELECTROBUN_OS === "darwin" || (!env.ELECTROBUN_OS && hostPlatform === "darwin");

/**
 * The Info.plist files to patch for this hook run: the wrapper bundle when Electrobun passes
 * one (postWrap), otherwise every `*.app` directly inside the build folder (postBuild).
 */
export function infoPlistTargets(env: HookEnv, exists: (path: string) => boolean = existsSync): string[] {
	const bundles: string[] = [];
	const wrapper = env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
	if (wrapper?.endsWith(".app")) bundles.push(wrapper);
	else if (env.ELECTROBUN_BUILD_DIR && exists(env.ELECTROBUN_BUILD_DIR)) {
		for (const entry of readdirSync(env.ELECTROBUN_BUILD_DIR, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.endsWith(".app")) bundles.push(join(env.ELECTROBUN_BUILD_DIR, entry.name));
		}
	}
	return bundles.map((b) => join(b, "Contents", "Info.plist")).filter((p) => exists(p));
}

/** `plutil` argument lists that set every accessory key in `plist` (replace = add or overwrite). */
export function plutilCommands(plist: string): string[][] {
	return Object.entries(ACCESSORY_KEYS).map(([key, value]) => [
		"plutil",
		"-replace",
		key,
		"-bool",
		value ? "YES" : "NO",
		plist,
	]);
}
