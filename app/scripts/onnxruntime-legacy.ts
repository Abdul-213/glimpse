// Intel Mac inference (GLIM-89, docs/decisions/GLIM-89-intel-mac-onnxruntime.md).
//
// onnxruntime-node >= 1.24 ships no darwin-x64 binary; the last one is 1.23.2. Its native
// binding is not compatible with the 1.31.1 JavaScript (`initOrtOnce` takes an extra argument
// and `loadModel` became async in 1.24+), so a darwin-x64 build uses 1.23.2 as a whole: its JS,
// its onnxruntime-common 1.23.2 and its darwin/x64 binding + runtime. The public API the OCR
// Worker uses (InferenceSession.create with these SessionOptions, Tensor, run) is the same.
//
// It is not an npm dependency (that would add ~250 MB to every install for one target). The
// build fetches the two tarballs from the npm registry, pinned by their sha512 integrity, and
// extracts only what darwin-x64 needs (~40 MB) into a cache:
//
//   <cache>/node_modules/onnxruntime-node/{package.json,dist/,bin/napi-v6/darwin/x64/}
//   <cache>/node_modules/onnxruntime-common/{package.json,dist/}
//
// `build-workers.ts` then resolves `onnxruntime-node` for the OCR Worker from there, and
// `onnxruntime.ts` stages the binding + libonnxruntime.1.23.2.dylib from there. The build-time
// switch is the target: `ortPackageFor()` (host, or GLIMPSE_ORT_TARGET); GLIMPSE_ORT_LEGACY_DIR
// points at an already prepared cache (offline builds).
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface PinnedTarball {
	readonly name: "onnxruntime-node" | "onnxruntime-common";
	readonly url: string;
	/** npm `dist.integrity` (SRI, sha512). */
	readonly integrity: string;
	/** Members to extract (tar paths); everything else in the tarball is skipped. */
	readonly members: readonly string[];
}

export const ORT_LEGACY_VERSION = "1.23.2";

export const ORT_LEGACY_TARBALLS: readonly PinnedTarball[] = [
	{
		name: "onnxruntime-node",
		url: "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.23.2.tgz",
		integrity: "sha512-OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw==",
		members: ["package/package.json", "package/dist", "package/bin/napi-v6/darwin/x64"],
	},
	{
		name: "onnxruntime-common",
		url: "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.23.2.tgz",
		integrity: "sha512-5LFsC9Dukzp2WV6kNHYLNzp8sT6V02IubLCbzw2Xd6X5GOlr65gAX6xiJwyi2URJol/s71gaQLC5F2C25AAR2w==",
		members: ["package/package.json", "package/dist"],
	},
];

/** Targets that need the pinned legacy onnxruntime-node (no build in the current one). */
const LEGACY_TARGETS: ReadonlySet<string> = new Set(["darwin-x64"]);

export type OrtPackage = { readonly kind: "current" } | { readonly kind: "legacy"; readonly version: string };

/** Which onnxruntime-node a build for `target` bundles. */
export function ortPackageFor(target: { readonly os: string; readonly arch: string }): OrtPackage {
	return LEGACY_TARGETS.has(`${target.os}-${target.arch}`)
		? { kind: "legacy", version: ORT_LEGACY_VERSION }
		: { kind: "current" };
}

/** The legacy cache root: GLIMPSE_ORT_LEGACY_DIR, else ~/.cache/glimpse/onnxruntime-node-1.23.2. */
export function legacyOrtRoot(env: Record<string, string | undefined> = process.env): string {
	return (
		env["GLIMPSE_ORT_LEGACY_DIR"] ?? join(homedir(), ".cache", "glimpse", `onnxruntime-node-${ORT_LEGACY_VERSION}`)
	);
}

/** The prepared package folder (`.../node_modules/onnxruntime-node`) under a cache root. */
export const legacyOrtPackageDir = (root: string) => join(root, "node_modules", "onnxruntime-node");

/** True when `bytes` match an npm SRI string (`sha512-<base64>`). */
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
	const [algo, expected] = integrity.split("-", 2);
	if (algo !== "sha512" || !expected) return false;
	const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
	return actual === expected;
}

const MARKER = ".glimpse-complete";

export interface EnsureLegacyOptions {
	readonly root?: string;
	readonly fetch?: (url: string) => Promise<Response>;
	readonly log?: (line: string) => void;
	readonly tarballs?: readonly PinnedTarball[];
}

/**
 * Make sure the legacy onnxruntime-node is prepared under `root`; returns its package folder.
 * Downloads and verifies each tarball, extracts its members with the system `tar` (macOS and
 * Linux ship one), and marks the cache complete only once everything is in place.
 */
export async function ensureLegacyOrt(options: EnsureLegacyOptions = {}): Promise<string> {
	const root = options.root ?? legacyOrtRoot();
	const pkgDir = legacyOrtPackageDir(root);
	if (existsSync(join(root, MARKER))) return pkgDir;
	const doFetch = options.fetch ?? ((url: string) => fetch(url));
	const log = options.log ?? (() => {});
	const work = mkdtempSync(join(tmpdir(), "glimpse-ort-legacy-"));
	try {
		const staged = join(work, "node_modules");
		mkdirSync(staged, { recursive: true });
		for (const t of options.tarballs ?? ORT_LEGACY_TARBALLS) {
			log(`fetching ${t.url}`);
			const res = await doFetch(t.url);
			if (!res.ok) throw new Error(`${t.url}: HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (!matchesIntegrity(bytes, t.integrity)) throw new Error(`${t.url}: integrity mismatch`);
			const file = join(work, `${t.name}.tgz`);
			writeFileSync(file, bytes);
			const out = join(work, `x-${t.name}`);
			mkdirSync(out);
			const tar = Bun.spawnSync(["tar", "-xzf", file, "-C", out, ...t.members]);
			if (tar.exitCode !== 0) throw new Error(`tar failed for ${t.name}: ${tar.stderr.toString()}`);
			renameSync(join(out, "package"), join(staged, t.name));
		}
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		// cp, not rename: the temp folder may be on another file system.
		cpSync(staged, join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, MARKER), `${ORT_LEGACY_VERSION}\n`);
		log(`onnxruntime-node ${ORT_LEGACY_VERSION} ready in ${root}`);
		return pkgDir;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
