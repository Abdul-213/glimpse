// A scriptable `fetch` for Google provider tests (here and in the app). Never use in
// production code. Routes match on method + URL prefix; each answers with a recorded JSON
// reply, a function of the request, a network failure, or a hang that only an abort ends.

import type { FetchLike } from "./common.ts";

export interface FakeCall {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	/** Parsed JSON body, or null. */
	readonly body: unknown;
}

export type FakeReply =
	| { readonly status?: number; readonly json: unknown; readonly headers?: Readonly<Record<string, string>> }
	| { readonly network: "offline" | "reset" }
	| { readonly hang: true };

export type FakeHandler = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

export class FakeFetch {
	readonly calls: FakeCall[] = [];
	readonly #routes: { readonly method: string; readonly prefix: string; handler: FakeHandler }[] = [];

	/** Answer `method` requests whose URL starts with `prefix`. Later routes win. */
	on(method: "GET" | "POST", prefix: string, handler: FakeHandler): this {
		this.#routes.unshift({ method, prefix, handler });
		return this;
	}

	readonly fetch: FetchLike = async (url, init) => {
		const method = init.method ?? "GET";
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((v, k) => {
			headers[k] = v;
		});
		let body: unknown = null;
		if (typeof init.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		const call: FakeCall = { method, url, headers, body };
		this.calls.push(call);
		const signal = init.signal ?? undefined;
		if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
		const route = this.#routes.find((r) => r.method === method && url.startsWith(r.prefix));
		if (!route)
			return new Response(JSON.stringify({ error: { code: 404, message: "no fake route" } }), { status: 404 });
		const reply = typeof route.handler === "function" ? await route.handler(call) : route.handler;
		if ("hang" in reply) {
			return new Promise<Response>((_, reject) => {
				const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if ("network" in reply) {
			const error = new Error(
				reply.network === "offline" ? "Unable to connect. Is the computer able to access the url?" : "socket hang up",
			);
			(error as Error & { code: string }).code = reply.network === "offline" ? "ConnectionRefused" : "ECONNRESET";
			throw error;
		}
		return new Response(JSON.stringify(reply.json), {
			status: reply.status ?? 200,
			headers: { "content-type": "application/json; charset=UTF-8", ...reply.headers },
		});
	};
}
