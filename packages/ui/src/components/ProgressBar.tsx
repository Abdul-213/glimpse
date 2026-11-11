import { type JSX, Show } from "solid-js";
import { progressLine } from "../format.ts";

export interface ProgressBarProps {
	/** Accessible name ("Downloading Japanese"). */
	label: string;
	/** Bytes done and total. Omit `total` (or pass 0) for the indeterminate state. */
	done: number;
	total?: number;
	etaSeconds?: number;
	/** Overrides the numeric line ("412 MB of 1.2 GB · about 3 min left"). */
	line?: string;
	/** Shown instead of a bar while the size isn't known yet. */
	preparingLabel?: string;
}

/**
 * Model download progress (DESIGN.md): `progress-track` + linear `progress-fill` and a
 * `numeric` line. Real progress only: with no total there is no bar, just "Preparing download".
 */
export function ProgressBar(props: ProgressBarProps): JSX.Element {
	const total = () => props.total ?? 0;
	const pct = () => (total() > 0 ? Math.min(100, Math.max(0, (props.done / total()) * 100)) : 0);
	const line = () => props.line ?? progressLine(props.done, total(), props.etaSeconds);
	return (
		<Show
			when={total() > 0}
			fallback={
				<p class="m-0 text-numeric text-text-secondary" role="status">
					{props.preparingLabel ?? "Preparing download"}
				</p>
			}
		>
			<div class="flex flex-col gap-1.5">
				<div
					role="progressbar"
					aria-label={props.label}
					aria-valuemin={0}
					aria-valuemax={total()}
					aria-valuenow={Math.min(props.done, total())}
					aria-valuetext={line()}
					class="glim-progress-track"
				>
					<div class="glim-progress-fill" style={{ width: `${pct()}%` }} />
				</div>
				<p class="m-0 text-numeric text-text-secondary tabular-nums">{line()}</p>
			</div>
		</Show>
	);
}
