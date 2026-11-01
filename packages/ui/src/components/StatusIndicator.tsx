import { type JSX, Show } from "solid-js";
import { Icon } from "./Icon.tsx";

/** Live session status (live-popup.md §2.2): running/updating = accent, paused/consent = hollow, error = danger. */
export type LiveStatus = "running" | "updating" | "paused" | "consent" | "error";

export interface StatusIndicatorProps {
	status: LiveStatus;
	/** "Live", "Updating", "Paused", "Live · Private". */
	label: string;
}

/** The status dot and label at the start of the Live strip. The dot never pulses. */
export function StatusIndicator(props: StatusIndicatorProps): JSX.Element {
	return (
		<span class="inline-flex min-w-0 items-center gap-1.5 text-label text-text-secondary">
			<span class="glim-dot" data-status={props.status} aria-hidden="true" />
			<span class="truncate">{props.label}</span>
		</span>
	);
}

export interface StateMessageProps {
	/** Errors and consent get a heading; paused/stale/empty lines don't. */
	title?: string;
	tone?: "danger" | "neutral";
	/** Body copy, `body` type, `text-secondary`. */
	children?: JSX.Element;
	/** Up to two (Snip) or three (Live consent) buttons; the recovery is primary. */
	actions?: JSX.Element;
	headingLevel?: 2 | 3;
	id?: string;
}

/**
 * The Snip error body and the Live state row (snip-popup.md §4.1, live-popup.md §2.3).
 * A `heading` title with a 16px status icon, a `body` paragraph, then buttons 8px apart.
 * Without a title it is the single quiet line used for paused, stale and empty states.
 */
export function StateMessage(props: StateMessageProps): JSX.Element {
	const icon = () => (props.tone === "danger" ? "alert" : "info");
	return (
		<div id={props.id} class="flex flex-col gap-1 px-2">
			<Show when={props.title}>
				<div class="flex items-center gap-2">
					<Icon name={icon()} class={props.tone === "danger" ? "text-danger" : "text-text-secondary"} />
					<Show when={props.headingLevel === 3} fallback={<h2 class="m-0 text-heading">{props.title}</h2>}>
						<h3 class="m-0 text-heading">{props.title}</h3>
					</Show>
				</div>
			</Show>
			<Show when={props.children}>
				<p class="m-0 text-body text-text-secondary">{props.children}</p>
			</Show>
			<Show when={props.actions}>
				<div class="mt-2 flex flex-wrap gap-2">{props.actions}</div>
			</Show>
		</div>
	);
}
