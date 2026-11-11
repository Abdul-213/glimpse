// After a build: run one OCR call through what the build staged into dist/ (the OCR Worker,
// native/onnxruntime/ and the bundled models), laid out as in the app, in a folder outside the
// repo so nothing falls back on node_modules. desktop.yml runs this on the Windows and macOS
// runners; the release build itself is a compressed self-extracting wrapper, so it checks the
// same files before they are packed.
//
//   bun scripts/bundle-smoke.ts
//
// Fails unless the text is read, every onnxruntime library came from the bundle, on Windows the
// Visual C++ runtime DLLs in use are the app-local copies (GLIM-111), and ONNX Runtime created no
// telemetry device id or event store (GLIM-112). ORT skips telemetry by itself when it sees a CI
// variable, so the OCR call runs with those blanked, as on a user's machine.
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ORT_CI_VARIABLES, ortTelemetryPaths } from "../src/bun/services/ocr/ort-telemetry.ts";
import { OCR_WORKER_FILE } from "../src/bun/services/ocr/paddle-worker.ts";

const dist = resolve(import.meta.dir, "..", "dist");
const appDir = mkdtempSync(join(tmpdir(), "glimpse-bundle-smoke-"));
const fail = (msg: string): never => {
	throw new Error(msg);
};

try {
	cpSync(join(dist, "workers", OCR_WORKER_FILE), join(appDir, "bun", OCR_WORKER_FILE));
	cpSync(join(dist, "onnxruntime"), join(appDir, "native", "onnxruntime"), { recursive: true });
	cpSync(join(dist, "models"), join(appDir, "models"), { recursive: true });

	const telemetry = ortTelemetryPaths(process.platform, process.env, homedir());
	const before = telemetry.filter((p) => existsSync(p));
	if (before.length > 0) console.log(`note: ORT telemetry folders existed before the run: ${before.join(", ")}`);
	const userEnv = {
		...process.env,
		...Object.fromEntries(ORT_CI_VARIABLES.map((v) => [v, ""])),
		ORT_DISABLE_TELEMETRY: "",
	};
	const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "ocr-smoke.ts"), appDir], {
		stdout: "pipe",
		stderr: "pipe",
		env: userEnv,
	});
	if (p.exitCode !== 0) fail(`ocr-smoke failed:\n${p.stderr.toString()}`);
	const out = JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}") as {
		text: string[];
		ms: number;
		ortLibs: string[];
		crtLibs: string[];
	};
	console.log(JSON.stringify(out, null, 2));

	// Compare against the path as created and as resolved (macOS: /var is a link to /private/var).
	const roots = [appDir, realpathSync(appDir)].map((d) => join(d, "native", "onnxruntime").toLowerCase());
	const inside = (lib: string) => roots.some((r) => lib.toLowerCase().startsWith(r));
	if (!out.text.join("\n").includes("Die Datei konnte nicht gespeichert werden.")) fail("expected text not read");
	if (out.ortLibs.length < 2) fail("onnxruntime libraries not found in the module list");
	for (const lib of out.ortLibs) if (!inside(lib)) fail(`onnxruntime loaded from outside the bundle: ${lib}`);
	if (process.platform === "win32") {
		if (out.crtLibs.length === 0) fail("no Visual C++ runtime DLLs in the module list");
		const outside = out.crtLibs.filter((l) => !inside(l));
		// Copies already loaded by the process (a newer system runtime) are fine; report them.
		if (outside.length > 0) console.log(`note: Visual C++ runtime DLLs loaded from elsewhere: ${outside.join(", ")}`);
		if (!out.crtLibs.some(inside)) fail("none of the app-local Visual C++ runtime DLLs was used");
	}
	for (const path of telemetry) {
		if (!before.includes(path) && existsSync(path)) fail(`onnxruntime created its telemetry folder ${path}`);
	}
	if (process.platform === "win32") {
		const key = "HKCU\\SOFTWARE\\Microsoft\\DeveloperTools\\.onnxruntime";
		const reg = Bun.spawnSync(["reg", "query", key], { stdout: "pipe", stderr: "pipe" });
		if (reg.exitCode === 0) fail(`onnxruntime wrote its device id to ${key}:\n${reg.stdout.toString()}`);
	}
	console.log("bundle-smoke: ok");
} catch (error) {
	console.error(`bundle-smoke: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	rmSync(appDir, { recursive: true, force: true });
}
