// Typed RPC contracts between the Bun main process and each webview.
// One schema per surface. Types only: imported with `import type` on both sides, so
// nothing from electrobun/view leaks into the main bundle or vice versa.
//
// Convention (ARCHITECTURE.md "Views and RPC"):
//   bun.requests      view -> main, awaited       (view calls rpc.request.<name>)
//   bun.messages      view -> main, fire-and-forget (rpc.send.<name>)
//   webview.requests  main -> view, awaited
//   webview.messages  main -> view, fire-and-forget (pushes: state, theme changes)
// Payloads are plain JSON data. Domain types come from @glimpse/core.

import type { RPCSchema } from "electrobun/view";

export type Platform = "macos" | "windows" | "linux";

export interface AppInfo {
	name: string;
	version: string;
	platform: Platform;
	electrobun: string;
	bun: string;
}

export type SettingsRPC = {
	bun: RPCSchema<{
		requests: {
			getAppInfo: { params: undefined; response: AppInfo };
		};
		messages: {
			closeSettings: undefined;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: Record<never, never>;
	}>;
};
