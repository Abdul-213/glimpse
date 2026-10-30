// Electrobun 2.x projects are driven by Hutch (https://hutch.blackboard.sh).
// Pinned to 2.0.6-beta.2: it is the first published build that creates
// transparent Windows windows with WS_EX_NOREDIRECTIONBITMAP instead of
// WS_EX_LAYERED (electrobun commit d072fc1e5, whose message says a layered
// window hides WebView2's composition content). See FINDINGS.md.
export default {
	scripts: {
		install: ["hutch", "install"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
		"build-dev": ["hutch", "electrobun", "build", "--env=dev"],
		test: ["bun", "test"],
		typecheck: ["bunx", "tsc", "--noEmit", "-p", "."],
	},
	electrobun: {
		version: "2.0.6-beta.2",
	},
};
