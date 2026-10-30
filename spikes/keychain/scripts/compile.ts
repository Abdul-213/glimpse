// Build dist/glimpse-keychain-cli with a fresh GLIM_BUILD_ID, so every run of
// `bun run compile` produces a binary with a different hash (and, on macOS, a
// different ad-hoc cdhash). Stand-in for "Glimpse's own native code that
// changes on every release", e.g. a Rust sidecar.
const out = process.platform === "win32" ? "dist/glimpse-keychain-cli.exe" : "dist/glimpse-keychain-cli";
const id = `${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
const r = Bun.spawnSync([process.execPath, "build", "--compile", `--define=GLIM_BUILD_ID=${JSON.stringify(id)}`, "src/cli.ts", "--outfile", out], {
	stdout: "inherit",
	stderr: "inherit",
});
if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
console.log(`built ${out} build=${id}`);
