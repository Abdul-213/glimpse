// One PaddleOCR call through a bundled OCR Worker (GLIM-103), as the built app runs it:
//
//   bun scripts/ocr-smoke.ts <app resources dir> [image.png]
//
// <app resources dir> is the folder holding bun/ocr-worker.js, native/onnxruntime/ and models/
// (in a Linux build: build/<env>-linux-x64/<App>/Resources/app). Prints one JSON line:
// { text, ms, ortLibs } where ortLibs are the onnxruntime files this process mapped (Linux:
// /proc/self/maps), so a caller can check they came from inside the bundle. Exits 1 on failure.
// Run it in its own process: a process that already loaded onnxruntime-node from node_modules
// would map that copy instead.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OcrImage } from "@glimpse/core";
import { PaddleOcrProvider } from "@glimpse/providers/ocr/paddle";
import { decodePng } from "../src/bun/services/capture/png.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { paddleModelSource } from "../src/bun/services/ocr/paddle-models.ts";
import { OCR_WORKER_FILE, ocrSpawner } from "../src/bun/services/ocr/paddle-worker.ts";

const appDir = resolve(process.argv[2] ?? "");
const imagePath = resolve(
	process.argv[3] ?? join(import.meta.dir, "..", "test", "fixtures", "capture", "mixed-ja-de", "mixed-ja-de.png"),
);
const bunDir = join(appDir, "bun");
if (!existsSync(join(bunDir, OCR_WORKER_FILE))) {
	console.error(`no ${OCR_WORKER_FILE} in ${bunDir}`);
	process.exit(1);
}

const { spawn } = ocrSpawner(bunDir, {});
if (!spawn) throw new Error("no spawner");
// Only the bundled models: an empty download root, the bundle's models/ as the bundled folder.
const manager = new ModelManager({ root: join(appDir, ".smoke-models"), bundledDir: join(appDir, "models") });
await manager.scan();
const provider = new PaddleOcrProvider({ threads: 2 }, { models: paddleModelSource(manager), spawnWorker: spawn });
try {
	const status = await provider.init();
	if (status.state !== "ready") throw new Error(`PaddleOCR is ${status.state}: ${JSON.stringify(status)}`);
	const png = decodePng(readFileSync(imagePath));
	const image: OcrImage = {
		width: png.width,
		height: png.height,
		stride: png.width * 4,
		format: "rgba8",
		data: png.data,
	};
	const t0 = performance.now();
	const result = await provider.recognise({ image });
	const ms = Math.round(performance.now() - t0);
	const maps = process.platform === "linux" ? readFileSync("/proc/self/maps", "utf8") : "";
	const ortLibs = [
		...new Set(maps.split("\n").flatMap((l) => l.match(/\/\S*onnxruntime\S*\.(?:so[.\d]*|node|dylib|dll)$/g) ?? [])),
	];
	console.log(JSON.stringify({ text: result.blocks.map((b) => b.text), ms, ortLibs }));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await provider.dispose();
}
