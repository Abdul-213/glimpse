// The one place a webview opens its RPC channel to the Bun main process.
// Each view calls connect<SurfaceRPC>() once at startup with its handlers for
// main -> view requests and messages, and gets a typed `rpc.request` / `rpc.send`.
import { type ElectrobunRPCSchema, Electroview } from "electrobun/view";

type Handlers<S extends ElectrobunRPCSchema> = Parameters<typeof Electroview.defineRPC<S>>[0]["handlers"];

export function connect<S extends ElectrobunRPCSchema>(handlers: Handlers<S>, maxRequestTime = 5_000) {
	const rpc = Electroview.defineRPC<S>({ maxRequestTime, handlers });
	new Electroview({ rpc });
	return rpc;
}
