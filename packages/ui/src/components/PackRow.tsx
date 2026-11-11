import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { Button } from "./Button.tsx";
import { ProgressBar } from "./ProgressBar.tsx";

/** One row as the popups show it (core `SnipPackRow` / `LivePackRow`, structurally). */
export interface PackRowItem {
	readonly lang: string;
	readonly state: "missing" | "downloading" | "offline" | "failed";
	readonly bytes: number;
	readonly received: number | null;
	readonly total: number | null;
	/** Core `PackKind`: what the download is. Absent = a language pack. */
	readonly kind?: "language-pack" | "long-tail-model";
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
	/**
	 * GLIM-138: rows this returns true for (large downloads) ask once before `onDownload`. The
	 * row's text is replaced by `confirmText`, with `confirmLabel` (primary) and `cancelLabel`.
	 */
	needsConfirm?: (row: PackRowItem) => boolean;
	confirmText?: (row: PackRowItem) => string;
	confirmLabel?: (row: PackRowItem) => string;
	cancelLabel?: string;
	class?: string;
}

/**
 * Missing language-pack rows at the top of a popup's block list (snip-popup.md §2.2, shared
 * by Snip and Live L12): `body` text in `text-secondary` and a secondary "Download ({size})"
 * button; while downloading a linear progress bar with a `numeric` line. The row disappears
 * when the pack lands (the caller drops it). A large download first turns the row into a
 * question with "Download ({size})" and "Not now" (GLIM-138).
 */
export function PackRows(props: PackRowsProps): JSX.Element {
	// The language whose row is asking; one at a time.
	const [confirming, setConfirming] = createSignal<string | null>(null);
	const press = (row: PackRowItem, el: HTMLElement | undefined) => {
		if (props.needsConfirm?.(row) && props.confirmText) {
			setConfirming(row.lang);
			queueMicrotask(() => el?.querySelector<HTMLButtonElement>("[data-pack-confirm]")?.focus());
			return;
		}
		props.onDownload(row);
	};
	return (
		<div class={["glim-packs", props.class].filter(Boolean).join(" ")}>
			<For each={props.rows}>
				{(row) => {
					let el: HTMLDivElement | undefined;
					const questionId = createUniqueId();
					const asking = () =>
						confirming() === row.lang && (row.state === "missing" || row.state === "failed") && !!props.confirmText;
					const cancel = () => {
						setConfirming(null);
						queueMicrotask(() => el?.querySelector<HTMLButtonElement>("[data-pack-download]")?.focus());
					};
					return (
						<div class="glim-pack" ref={el} data-pack-kind={row.kind ?? "language-pack"}>
							<Show
								when={asking()}
								fallback={
									<>
										<p class="m-0 max-w-measure text-body text-text-secondary">
											{props.text(row)}
											<Show when={row.state === "offline"}> {props.offlineText}</Show>
											<Show when={row.state === "failed"}> {props.failedText}</Show>
										</p>
										<Show
											when={row.state === "downloading"}
											fallback={
												<Show when={row.state !== "offline"}>
													<Button variant="secondary" data-pack-download="" onClick={() => press(row, el)}>
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
									</>
								}
							>
								<p id={questionId} class="m-0 max-w-measure text-body text-text-primary">
									{props.confirmText?.(row)}
								</p>
								<div class="glim-pack-actions">
									<Button
										variant="primary"
										data-pack-confirm=""
										aria-describedby={questionId}
										onClick={() => {
											setConfirming(null);
											props.onDownload(row);
										}}
									>
										{props.confirmLabel?.(row) ?? props.downloadLabel(row)}
									</Button>
									<Button variant="secondary" onClick={cancel}>
										{props.cancelLabel ?? "Not now"}
									</Button>
								</div>
							</Show>
						</div>
					);
				}}
			</For>
		</div>
	);
}
