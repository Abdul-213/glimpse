// An in-process stand-in for the Bergamot Worker, speaking the real protocol. For tests
// only: it lets the host (engine, LRU, cancellation, streaming) and the provider run on
// Linux CI without the WASM runtime or packs. Output per hop: `text [src>tgt]`, where the
// codes come from the pack key (`bergamot-ja-en@1`).
import type { HostMessage, WorkerMessage, WorkerPort, WorkerSpawner } from "./protocol.ts";

export interface FakeWorkerOptions {
	/** Delay per sentence in ms (a macrotask either way). Default 0. */
	readonly sentenceMs?: number;
	/** Fail `init` with this message. */
	readonly failInit?: string;
	/** Fail `load` for keys matching this. */
	readonly failLoad?: RegExp;
	/** Throw an uncaught error (a "crash") when a sentence contains this text. */
	readonly crashOn?: string;
}

export interface FakeWorkerLog {
	readonly messages: HostMessage[];
	readonly spawned: number;
	readonly terminated: number;
	/** Keys loaded in the current fake worker. */
	readonly loaded: ReadonlySet<string>;
	/** Most packs loaded at once in any fake worker. */
	readonly peakLoaded: number;
}

const codes = (key: string): [string, string] => {
	const m = /^bergamot-(.+?)-([a-z]{2,3}(?:_[a-z]+)?)@/i.exec(key);
	return m?.[1] && m[2] ? [m[1], m[2]] : ["?", "?"];
};

export function fakeBergamotWorker(options: FakeWorkerOptions = {}): { spawn: WorkerSpawner; log: FakeWorkerLog } {
	const log = {
		messages: [] as HostMessage[],
		spawned: 0,
		terminated: 0,
		loaded: new Set<string>(),
		peakLoaded: 0,
	};
	const spawn: WorkerSpawner = () => {
		log.spawned++;
		log.loaded = new Set();
		const loaded = log.loaded;
		const cancelled = new Set<number>();
		let alive = true;
		let chain = Promise.resolve();
		const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
		const port: WorkerPort = {
			onmessage: null,
			onerror: null,
			postMessage(message: HostMessage) {
				log.messages.push(message);
				if (message.type === "cancel") {
					cancelled.add(message.id);
					return;
				}
				chain = chain.then(() => handle(message)).catch(() => undefined);
			},
			terminate() {
				alive = false;
				log.terminated++;
			},
		};
		const post = (message: WorkerMessage) => {
			if (alive) port.onmessage?.({ data: message } as MessageEvent<WorkerMessage>);
		};
		async function handle(m: HostMessage): Promise<void> {
			await wait(0);
			if (!alive) return;
			switch (m.type) {
				case "init":
					if (options.failInit) post({ type: "error", id: m.id, message: options.failInit });
					else post({ type: "ok", id: m.id, result: { ms: 1 } });
					return;
				case "load":
					if (options.failLoad?.test(m.key)) {
						post({ type: "error", id: m.id, message: `cannot load ${m.key}` });
						return;
					}
					loaded.add(m.key);
					log.peakLoaded = Math.max(log.peakLoaded, loaded.size);
					post({ type: "ok", id: m.id, result: { loadMs: 1, warmupMs: 1 } });
					return;
				case "unload":
					loaded.delete(m.key);
					post({ type: "ok", id: m.id });
					return;
				case "stats":
					post({ type: "ok", id: m.id, result: { wasmHeapBytes: 0, loaded: [...loaded] } });
					return;
				case "translate": {
					for (const key of m.route) {
						if (!loaded.has(key)) {
							post({ type: "error", id: m.id, message: `pack ${key} is not loaded` });
							return;
						}
					}
					for (let i = 0; i < m.sentences.length; i++) {
						if (cancelled.has(m.id) || !alive) break;
						const sentence = m.sentences[i] ?? "";
						if (options.crashOn && sentence.includes(options.crashOn)) {
							port.onerror?.({ message: "crash", preventDefault() {} } as ErrorEvent);
							return;
						}
						const text = m.route.reduce((acc, key) => {
							const [src, tgt] = codes(key);
							return `${acc} [${src}>${tgt}]`;
						}, sentence);
						post({ type: "sentence", id: m.id, index: i, text });
						await wait(options.sentenceMs ?? 0);
					}
					post({ type: "ok", id: m.id, result: { ms: 1 } });
					return;
				}
				case "cancel":
					return;
			}
		}
		return port;
	};
	return { spawn, log };
}
