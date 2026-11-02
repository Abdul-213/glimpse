// An in-process stand-in for the SMaLL-100 Worker, speaking the real protocol. For tests only:
// it lets the host (engine, idle stop, cancellation, streaming) and the provider run on Linux CI
// without onnxruntime or the 0.6 GB model. Output per sentence: `text [src>tgt]` (M2M codes).
import type {
	Small100HostMessage,
	Small100WorkerMessage,
	Small100WorkerPort,
	Small100WorkerSpawner,
} from "./protocol.ts";

export interface FakeSmall100Options {
	/** Delay per sentence in ms (a macrotask either way). Default 0. */
	readonly sentenceMs?: number;
	/** Fail `init` with this message (a damaged model). */
	readonly failInit?: string;
	/** Throw an uncaught error (a "crash") when a sentence contains this text. */
	readonly crashOn?: string;
}

export interface FakeSmall100Log {
	readonly messages: Small100HostMessage[];
	readonly spawned: number;
	readonly terminated: number;
	/** Model folders `init` was called with. */
	readonly inits: string[];
}

export function fakeSmall100Worker(options: FakeSmall100Options = {}): {
	spawn: Small100WorkerSpawner;
	log: FakeSmall100Log;
} {
	const log = { messages: [] as Small100HostMessage[], spawned: 0, terminated: 0, inits: [] as string[] };
	const spawn: Small100WorkerSpawner = () => {
		log.spawned++;
		const cancelled = new Set<number>();
		let alive = true;
		let ready = false;
		let chain = Promise.resolve();
		const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
		const port: Small100WorkerPort = {
			onmessage: null,
			onerror: null,
			postMessage(message) {
				log.messages.push(message);
				if (message.type === "cancel") {
					cancelled.add(message.id);
					return;
				}
				chain = chain.then(() => handle(message));
			},
			terminate() {
				if (alive) log.terminated++;
				alive = false;
			},
		};
		const reply = (message: Small100WorkerMessage) => {
			if (alive) port.onmessage?.({ data: message } as MessageEvent<Small100WorkerMessage>);
		};
		async function handle(message: Exclude<Small100HostMessage, { type: "cancel" }>): Promise<void> {
			await wait(0);
			if (!alive) return;
			switch (message.type) {
				case "init":
					log.inits.push(message.modelDir);
					if (options.failInit) {
						reply({ type: "error", id: message.id, message: options.failInit });
						return;
					}
					ready = true;
					reply({ type: "ok", id: message.id, result: { loadMs: 1, languages: ["en", "ja", "sw"] } });
					return;
				case "warmup":
					reply(ready ? { type: "ok", id: message.id, result: { ms: 1 } } : notReady(message.id));
					return;
				case "translate": {
					if (!ready) {
						reply(notReady(message.id));
						return;
					}
					for (const [index, sentence] of message.sentences.entries()) {
						await wait(options.sentenceMs ?? 0);
						if (!alive) return;
						if (cancelled.has(message.id)) {
							reply({ type: "error", id: message.id, message: "cancelled", cancelled: true });
							return;
						}
						if (options.crashOn && sentence.includes(options.crashOn)) {
							alive = false;
							port.onerror?.({ message: "fake crash", preventDefault() {} } as ErrorEvent);
							return;
						}
						reply({
							type: "sentence",
							id: message.id,
							index,
							text: `${sentence} [${message.from}>${message.to}]`,
							timing: { encodeMs: 1, decodeMs: 1, tokens: 1 },
						});
					}
					reply({ type: "ok", id: message.id, result: { ms: 1 } });
					return;
				}
			}
		}
		return port;
	};
	return { spawn, log };
}

const notReady = (id: number): Small100WorkerMessage => ({
	type: "error",
	id,
	message: "SMaLL-100 worker not initialised",
});
