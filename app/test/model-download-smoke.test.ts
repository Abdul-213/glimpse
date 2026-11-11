// Real download from Mozilla Remote Settings: the smallest desktop Bergamot pack (~13 MB).
// Skipped unless GLIMPSE_SMOKE_DOWNLOAD=1, so normal test runs and CI never touch the network.
//   GLIMPSE_SMOKE_DOWNLOAD=1 bun test app/test/model-download-smoke.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDownloadSize } from "@glimpse/core";
import { loadBergamotCatalogue, packInstallable } from "../src/bun/services/models/catalogue.ts";
import { hashFile } from "../src/bun/services/models/download.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";

const enabled = process.env["GLIMPSE_SMOKE_DOWNLOAD"] === "1";

test.skipIf(!enabled)(
	"downloads, verifies and installs the smallest real Bergamot pack",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "glimpse-smoke-"));
		try {
			const catalogue = await loadBergamotCatalogue({ cacheFile: join(dir, "catalogue.json") });
			expect(catalogue.source).toBe("network");
			expect(catalogue.packs.length).toBeGreaterThan(50);
			const pack = [...catalogue.packs].sort((a, b) => packDownloadSize(a) - packDownloadSize(b))[0];
			if (!pack) throw new Error("empty catalogue");
			console.log(`smoke: ${pack.id} ${pack.version} ${(packDownloadSize(pack) / 1e6).toFixed(1)} MB`);

			const manager = new ModelManager({ root: join(dir, "models") });
			await manager.scan();
			const state = await manager.install(packInstallable(pack));
			expect(state).toEqual({ status: "installed", version: pack.version, bundled: false });
			const installed = manager.modelDir(pack.id);
			if (!installed) throw new Error("not installed");
			for (const f of pack.files) {
				expect(await hashFile(join(installed, f.name))).toBe(f.decompressedSha256 ?? f.sha256);
				expect(existsSync(join(installed, `${f.name}.part`))).toBe(false);
			}
			const descriptor = JSON.parse(readFileSync(join(installed, "pack.json"), "utf8"));
			expect(descriptor.version).toBe(pack.version);
			expect(descriptor.files.model).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	300_000,
);
