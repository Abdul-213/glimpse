// Electrobun 2.x is driven by Hutch (https://hutch.blackboard.sh), which downloads the
// matching Bun, the prebuilt Electrobun core and the SDK devkit into app/.hutch/.
//
// Pinned to 2.0.6-beta.2 (docs/decisions/GLIM-26-stack.md): the first build whose
// transparent Windows windows use WS_EX_NOREDIRECTIONBITMAP, so WebView2 content shows
// (spikes/overlay/FINDINGS.md section 2). Move to the first stable release with the fix.
// If you change it, also change src/bun/electrobun-version.ts (a test checks).
//
// Dependencies are installed by Bun at the repo root (Bun workspace), not by Hutch.
export default {
	packageManager: "bun",
	electrobun: {
		version: "2.0.6-beta.2",
	},
};
