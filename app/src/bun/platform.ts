import type { Platform } from "../shared/rpc.ts";

/** Map Node/Bun's platform string to Glimpse's. Linux is a dev/CI target only. */
export function toPlatform(nodePlatform: string): Platform {
	switch (nodePlatform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "linux";
	}
}

export const platform: Platform = toPlatform(process.platform);
