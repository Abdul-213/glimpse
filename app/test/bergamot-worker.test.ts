// GLIM-101: the Bergamot Worker as its own bundle entry, and how the app finds it.
//
// Always: the resolver, the copy rule, and a real Bun.build of the Worker entry that is then
// started as a Worker and answers the protocol (so the bundle is self-contained).
// With GLIMPSE_REAL_PACKS=1 (packs in ~/.cache/glimpse/test-installs): the bundled Worker
// translates through the real provider, and so does the one inside a built app
// (app/build/<env>-linux-x64/..., when `bun run build` has been run).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectTranslations, languageCode } from "@glimpse/core";
import { BergamotTranslationProvider, type WorkerMessage } from "@glimpse/providers/translation/bergamot";
import config from "../electrobun.config.ts";
import { buildWorkers } from "../scripts/build-workers.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { ModelManagerPackSource } from "../src/bun/services/translation/bergamot-packs.ts";
import {
	BERGAMOT_WORKER_FILE,
	bergamotSpawner,
	resolveBergamotWorker,
} from "../src/bun/services/translation/bergamot-worker.ts";
import { defaultPackRoot } from "../src/harness/providers.ts";

const out = mkdtempSync(join(tmpdir(), "glimpse-workers-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("resolveBergamotWorker", () => {
	test("override, then the bundled file next to the main bundle, else the provider default", () => {
		expect(resolveBergamotWorker("/app/bun", { GLIMPSE_BERGAMOT_WORKER: "/x/w.js" }, () => false)).toBe(
			resolve("/x/w.js"),
		);
		expect(resolveBergamotWorker("/app/bun", {}, (p) => p === resolve("/app/bun/bergamot-worker.js"))).toBe(
			resolve("/app/bun/bergamot-worker.js"),
		);
		expect(resolveBergamotWorker("/app/src/bun", {}, () => false)).toBeNull();
		expect(bergamotSpawner("/app/src/bun", {}, () => false).spawn).toBeUndefined();
	});

	test("electrobun.config.ts copies the bundled Worker next to bun/index.js", () => {
		const copy = config.build.copy as Record<string, string>;
		expect(copy["dist/workers/bergamot-worker.js"]).toBe(`bun/${BERGAMOT_WORKER_FILE}`);
	});
});

describe("bundled Bergamot Worker", () => {
	test("builds as one self-contained file that runs as a Worker and speaks the protocol", async () => {
		const built = await buildWorkers({ dev: false, outDir: out });
		expect(built).toContain(BERGAMOT_WORKER_FILE);
		const file = join(out, BERGAMOT_WORKER_FILE);
		const source = readFileSync(file, "utf8");
		// Nothing left to resolve at runtime but Node/Bun built-ins.
		const imports = [...source.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
		expect(imports.filter((i) => !/^(node:|bun:)|^(fs|path|vm)$/.test(i))).toEqual([]);

		const worker = new Worker(file);
		try {
			const reply = await new Promise<WorkerMessage>((done, fail) => {
				const timer = setTimeout(() => fail(new Error("no reply from the bundled Worker")), 10_000);
				worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
					clearTimeout(timer);
					done(e.data);
				};
				worker.postMessage({ type: "init", id: 7, runtimeDir: join(out, "no-runtime-here") });
			});
			expect(reply).toMatchObject({ type: "error", id: 7 });
		} finally {
			worker.terminate();
		}
	}, 30_000);
});

const real = process.env["GLIMPSE_REAL_PACKS"] === "1";

/** The Worker inside a built Linux app, if `bun run build` has produced one. */
function builtAppWorker(): string | null {
	const buildDir = resolve(import.meta.dir, "..", "build");
	if (!existsSync(buildDir)) return null;
	for (const env of readdirSync(buildDir).filter((d) => d.endsWith("-linux-x64"))) {
		const dir = join(buildDir, env);
		for (const app of readdirSync(dir)) {
			const file = join(dir, app, "Resources", "app", "bun", BERGAMOT_WORKER_FILE);
			if (existsSync(file)) return file;
		}
	}
	return null;
}

describe.skipIf(!real)("bundled Worker on real packs", () => {
	const translateWith = async (workerFile: string) => {
		const manager = new ModelManager({ root: defaultPackRoot() });
		await manager.scan();
		const packs = new ModelManagerPackSource(manager);
		const { spawn } = bergamotSpawner("/nowhere", { GLIMPSE_BERGAMOT_WORKER: workerFile });
		if (!spawn) throw new Error("no spawner");
		const provider = new BergamotTranslationProvider({ packs, spawn, idleMs: 0 });
		try {
			expect((await provider.init()).state).toBe("ready");
			const r = await collectTranslations(provider, {
				to: languageCode("de"),
				segments: [{ id: "a", text: "明日の会議は午後三時に始まります。", from: languageCode("ja") }],
			});
			const o = r.get("a");
			if (!o?.ok) throw new Error(`failed: ${JSON.stringify(o)}`);
			return o.translation.text;
		} finally {
			await provider.dispose();
			packs.dispose();
		}
	};

	test("the freshly bundled Worker translates ja→de", async () => {
		await buildWorkers({ dev: false, outDir: out });
		expect(await translateWith(join(out, BERGAMOT_WORKER_FILE))).toMatch(/Treffen|Sitzung|Besprechung/);
	}, 120_000);

	const built = builtAppWorker();
	test.skipIf(!built)(
		"the Worker inside the built Linux app translates ja→de",
		async () => {
			expect(await translateWith(built as string)).toMatch(/Treffen|Sitzung|Besprechung/);
		},
		120_000,
	);
});
