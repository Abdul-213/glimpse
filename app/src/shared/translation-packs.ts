// Language-pack state over RPC (GLIM-57), shared by the Snip and Live surfaces. The popup
// RPC schemas (GLIM-65 snip, live popup) include these as their `pack` push message and the
// `downloadPack` / `cancelPackDownload` intents (snip-popup.md §2.2 and §13.2, live-popup.md
// L12). Types only; plain JSON.
//
//   main → view  packChanged         one row per missing source language; "done" removes it
//   view → main  downloadPack        the user pressed "Download ({size})": this is the consent
//   view → main  cancelPackDownload

export type PackRowStateName = "missing" | "downloading" | "offline" | "failed" | "done";

export interface PackChangedMessage {
	/** Snip request id or Live session id; the view drops rows for an older one. */
	readonly requestId: string;
	/** Source language (BCP-47) the row is about. */
	readonly lang: string;
	/** Display name in the UI language, for "{language} isn't downloaded yet." */
	readonly langName: string;
	readonly state: PackRowStateName;
	/** Download size in bytes, for "Download ({size})". */
	readonly bytes: number;
	/** Bytes done / total while downloading ("{done} of {total}"). */
	readonly done?: number;
	readonly total?: number;
	/** Block ids waiting on this pack; they translate in place when the row turns "done". */
	readonly blockIds: readonly string[];
	/** Set for "failed": the install error kind (network, checksum, disk-full, ...). */
	readonly error?: string;
}

export interface DownloadPackIntent {
	readonly requestId: string;
	readonly lang: string;
}

/** Messages and requests to merge into a surface's RPC schema. */
export type PackRPCMessagesToView = { packChanged: PackChangedMessage };
export type PackRPCMessagesToBun = { downloadPack: DownloadPackIntent; cancelPackDownload: DownloadPackIntent };
