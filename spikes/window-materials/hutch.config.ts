// Electrobun 2.x projects are driven by Hutch (https://hutch.blackboard.sh).
// Pinned to 2.0.6-beta.2 for the same reason as the GLIM-13 overlay spike:
// 2.0.5 creates transparent Windows windows with WS_EX_LAYERED, which hides
// WebView2's composition content. beta.2 (electrobun d072fc1e5) uses
// WS_EX_NOREDIRECTIONBITMAP instead. See FINDINGS.md.
export default {
	scripts: {
		install: ["hutch", "install"],
		// macOS only: builds native/macos/build/libglimmaterial.dylib (needs Xcode CLT).
		"native:mac": ["bash", "native/macos/build.sh"],
		start: ["hutch", "electrobun", "dev"],
		build: ["hutch", "electrobun", "build", "--env=dev"],
		test: ["hutch", "test", "test/"],
		typecheck: ["hutch", "node_modules/typescript/lib/tsc.js", "--noEmit", "-p", "."],
	},
	electrobun: {
		version: "2.0.6-beta.2",
	},
};
