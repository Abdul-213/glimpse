// The Bergamot inference Worker: owns one WASM runtime and the packs loaded into it, so
// the synchronous ~50 ms-per-sentence WASM calls never block the app's Bun worker
// (ARCHITECTURE.md "Process model"). Protocol in protocol.ts.
//
// Requests run one at a time in arrival order. A translate does one sentence per macrotask
// and posts it straight away, so the host can stream results and a `cancel` gets through
// between sentences.
import type { HostMessage, LoadResult, WorkerMessage, WorkerStats } from "./protocol.ts";
import { type BergamotModule, loadPack, loadRuntime, type TranslationModel, Translator } from "./runtime.ts";

declare const self: Worker;

let mod: BergamotModule | null = null;
let translator: Translator | null = null;
const models = new Map<string, TranslationModel>();
const cancelled = new Set<number>();
const queue: HostMessage[] = [];
let running = false;

const post = (message: WorkerMessage): void => self.postMessage(message);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function model(key: string): TranslationModel {
	const m = models.get(key);
	if (!m) throw new Error(`pack ${key} is not loaded`);
	return m;
}

function ready(): Translator {
	if (!translator) throw new Error("runtime not initialised");
	return translator;
}

/** One-word dummy translation: the first call per pack costs 0.3-0.8 s (GLIM-17). */
const WARMUP_TEXT = "Hello.";

async function handle(m: HostMessage): Promise<void> {
	switch (m.type) {
		case "init": {
			if (!mod) {
				const t0 = performance.now();
				mod = await loadRuntime(m.runtimeDir);
				translator = new Translator(mod);
				post({ type: "ok", id: m.id, result: { ms: performance.now() - t0 } });
			} else post({ type: "ok", id: m.id, result: { ms: 0 } });
			return;
		}
		case "load": {
			const tr = ready();
			if (!mod) throw new Error("runtime not initialised");
			const t0 = performance.now();
			const loaded = models.get(m.key) ?? loadPack(mod, m.dir);
			models.set(m.key, loaded);
			const t1 = performance.now();
			tr.translate([WARMUP_TEXT], loaded);
			const result: LoadResult = { loadMs: t1 - t0, warmupMs: performance.now() - t1 };
			post({ type: "ok", id: m.id, result });
			return;
		}
		case "unload": {
			models.get(m.key)?.delete();
			models.delete(m.key);
			post({ type: "ok", id: m.id });
			return;
		}
		case "translate": {
			const tr = ready();
			const [a, b] = m.route.map(model);
			if (!a || m.route.length > 2) throw new Error(`bad route ${m.route.join(" > ")}`);
			const t0 = performance.now();
			for (let i = 0; i < m.sentences.length; i++) {
				if (cancelled.has(m.id)) break;
				const sentence = m.sentences[i] ?? "";
				const [text] = tr.translate([sentence], a, b);
				post({ type: "sentence", id: m.id, index: i, text: text ?? "" });
				if (i < m.sentences.length - 1) await tick();
			}
			cancelled.delete(m.id);
			post({ type: "ok", id: m.id, result: { ms: performance.now() - t0 } });
			return;
		}
		case "stats": {
			const result: WorkerStats = { wasmHeapBytes: mod?.HEAP8?.buffer.byteLength ?? 0, loaded: [...models.keys()] };
			post({ type: "ok", id: m.id, result });
			return;
		}
		case "cancel":
			return;
	}
}

async function drain(): Promise<void> {
	if (running) return;
	running = true;
	try {
		for (let m = queue.shift(); m; m = queue.shift()) {
			if (cancelled.has(m.id) && m.type === "translate") {
				cancelled.delete(m.id);
				post({ type: "ok", id: m.id, result: { ms: 0 } });
				continue;
			}
			try {
				await handle(m);
			} catch (err) {
				if (m.type === "translate") cancelled.delete(m.id);
				post({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
			}
		}
	} finally {
		running = false;
	}
}

self.onmessage = (event: MessageEvent<HostMessage>) => {
	const m = event.data;
	if (m.type === "cancel") {
		cancelled.add(m.id);
		return;
	}
	queue.push(m);
	void drain();
};
