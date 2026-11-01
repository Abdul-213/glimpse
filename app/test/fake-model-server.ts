// A local HTTP server for model download tests: serves byte arrays with Range support and can
// misbehave on demand (drop the connection mid-body, ignore Range, stream slowly, fail).
import { createHash } from "node:crypto";
import type { ModelFile } from "@glimpse/core";

export interface Route {
	body: Uint8Array;
	/** Answer Range requests with 206 (default true). */
	ranges?: boolean;
	/** For the next N requests, send only this many bytes and then abort the connection. */
	dropAfter?: { bytes: number; times: number };
	/** Delay between 1 KiB chunks, in ms. */
	slowMs?: number;
	/** Respond with this status instead. */
	status?: number;
}

export interface FakeServer {
	readonly url: (path: string) => string;
	readonly routes: Map<string, Route>;
	readonly requests: { path: string; range: string | null }[];
	stop(): void;
}

export function startFakeServer(): FakeServer {
	const routes = new Map<string, Route>();
	const requests: { path: string; range: string | null }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			const range = req.headers.get("range");
			requests.push({ path, range });
			const route = routes.get(path);
			if (!route) return new Response("not found", { status: 404 });
			if (route.status) return new Response("error", { status: route.status });

			let start = 0;
			const m = range && route.ranges !== false ? /^bytes=(\d+)-$/.exec(range) : null;
			if (m) start = Number(m[1]);
			const slice = route.body.subarray(start);
			let limit = slice.byteLength;
			if (route.dropAfter && route.dropAfter.times > 0) {
				route.dropAfter.times--;
				limit = Math.min(limit, route.dropAfter.bytes);
			}
			const dropping = limit < slice.byteLength;
			const slowMs = route.slowMs ?? 0;
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let i = 0; i < limit; i += 1024) {
						controller.enqueue(slice.slice(i, Math.min(i + 1024, limit)));
						if (slowMs) await Bun.sleep(slowMs);
					}
					// When dropping, closing early under a larger Content-Length cuts the connection
					// short the way a network drop does (the client sees a truncated body or a reset).
					if (dropping) await Bun.sleep(5); // let the bytes reach the client first
					controller.close();
				},
			});
			const headers: Record<string, string> = { "content-length": String(slice.byteLength) };
			if (m) headers["content-range"] = `bytes ${start}-${route.body.byteLength - 1}/${route.body.byteLength}`;
			return new Response(stream, { status: m ? 206 : 200, headers });
		},
	});
	return {
		url: (path) => `http://127.0.0.1:${server.port}${path}`,
		routes,
		requests,
		stop: () => server.stop(true),
	};
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Deterministic pseudo-random bytes (incompressible enough to make zstd non-trivial). */
export function bytes(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	let x = seed;
	for (let i = 0; i < size; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		out[i] = x >> 16;
	}
	return out;
}

/** A plain file served at `path`, and its manifest entry. */
export function plainFile(server: FakeServer, path: string, body: Uint8Array, route: Partial<Route> = {}): ModelFile {
	server.routes.set(path, { body, ...route });
	return {
		name: path.split("/").at(-1) ?? path,
		urls: [server.url(path)],
		sha256: sha256Hex(body),
		size: body.byteLength,
	};
}

/** A zstd-compressed file served at `path` (installed as `path` without `.zst`). */
export function zstdFile(server: FakeServer, path: string, raw: Uint8Array, route: Partial<Route> = {}): ModelFile {
	const zst = new Uint8Array(Bun.zstdCompressSync(raw));
	server.routes.set(path, { body: zst, ...route });
	return {
		name: (path.split("/").at(-1) ?? path).replace(/\.zst$/, ""),
		urls: [server.url(path)],
		sha256: sha256Hex(zst),
		size: zst.byteLength,
		compression: "zstd",
		decompressedSha256: sha256Hex(raw),
		decompressedSize: raw.byteLength,
	};
}
