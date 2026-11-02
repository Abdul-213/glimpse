import { For, type JSX, Show } from "solid-js";
import { Button } from "./Button.tsx";
import { ProgressBar } from "./ProgressBar.tsx";

/** One row as the popups show it (core `SnipPackRow` / `LivePackRow`, structurally). */
export interface PackRowItem {
	readonly lang: string;
	readonly state: "missing" | "downloading" | "offline" | "failed";
	readonly bytes: number;
	readonly received: number | null;
	readonly total: number | null;
}

export interface PackRowsProps {
	rows: readonly PackRowItem[];
	/** "{language} isn't downloaded yet." */
	text: (row: PackRowItem) => string;
	/** "Download ({size})". */
	downloadLabel: (row: PackRowItem) => string;
	/** Appended to the text while offline / after a failed download. */
	offlineText: string;
	failedText: string;
	/** Accessible name of the bar ("Downloading Japanese"). */
	progressLabel: (row: PackRowItem) => string;
	/** "{done} of {total}". */
	progressText: (done: number, total: number) => string;
	onDownload: (row: PackRowItem) => void;
	class?: string;
}

/**
 * Missing language-pack rows at the top of a popup's block list (snip-popup.md §2.2, shared
 * by Snip and Live L12): `body` text in `text-secondary` and a secondary "Download ({size})"
 * button; while downloading a linear progress bar with a `numeric` line. The row disappears
 * when the pack lands (the caller drops it).
 */
export function PackRows(props: PackRowsProps): JSX.Element {
	return (
		<div class={["glim-packs", props.class].filter(Boolean).join(" ")}>
			<For each={props.rows}>
				{(row) => (
					<div class="glim-pack">
						<p class="m-0 max-w-measure text-body text-text-secondary">
							{props.text(row)}
							<Show when={row.state === "offline"}> {props.offlineText}</Show>
							<Show when={row.state === "failed"}> {props.failedText}</Show>
						</p>
						<Show
							when={row.state === "downloading"}
							fallback={
								<Show when={row.state !== "offline"}>
									<Button variant="secondary" onClick={() => props.onDownload(row)}>
										{props.downloadLabel(row)}
									</Button>
								</Show>
							}
						>
							<ProgressBar
								label={props.progressLabel(row)}
								done={row.received ?? 0}
								total={row.total ?? 0}
								line={props.progressText(row.received ?? 0, row.total ?? 0)}
							/>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
