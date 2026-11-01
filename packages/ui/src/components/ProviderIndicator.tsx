import { Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

export interface LocalIndicatorProps {
	label?: string;
	/** "Text was read and translated on this device. Nothing was sent." */
	tooltip?: string;
	/** Compact Live strip: icon only, words in the tooltip and accessible name. */
	compact?: boolean;
}

/** DESIGN.md `local-indicator`: chip icon + "On device", never louder than secondary text. */
export function LocalIndicator(props: LocalIndicatorProps) {
	const label = () => props.label ?? "On device";
	const body = (
		<span class="glim-local">
			<Icon name="chip" />
			<span classList={{ "sr-only": props.compact }}>{label()}</span>
		</span>
	);
	return (
		<Show when={props.tooltip ?? (props.compact ? label() : undefined)} fallback={body}>
			{(t) => <Tooltip content={t()}>{body}</Tooltip>}
		</Show>
	);
}

export interface EgressBadgeProps {
	/** Provider's full name ("Google Cloud Translation"). */
	provider: string;
	/** Registry short name ("Google"), used when the full name doesn't fit the popup. */
	shortName?: string;
	/** Use `shortName` (the parent measured that the full text doesn't fit). */
	short?: boolean;
	/** Cached cloud result (GLIM-22): "Sent to {provider} (remembered)". */
	remembered?: boolean;
	/** Overrides the visible text entirely (i18n). */
	label?: string;
	/** What was sent: "Text sent to {provider} (3 segments)". */
	tooltip?: string;
}

/**
 * DESIGN.md `egress-indicator`: violet pill, cloud icon, "Sent to {provider}". Shown on
 * every cloud-handled result; cannot be dismissed. Never truncated mid-name: the parent
 * wraps it to its own row, then switches to the short name.
 */
export function EgressBadge(props: EgressBadgeProps) {
	const name = () => (props.short && props.shortName ? props.shortName : props.provider);
	const text = () => props.label ?? `Sent to ${name()}${props.remembered ? " (remembered)" : ""}`;
	const full = () => `Sent to ${props.provider}${props.remembered ? " (remembered)" : ""}`;
	const pill = (
		<span class="glim-egress">
			<Icon name="cloud" />
			<span aria-hidden={props.short ? "true" : undefined}>{text()}</span>
			<Show when={props.short}>
				<span class="sr-only">{full()}</span>
			</Show>
		</span>
	);
	return (
		<Show when={props.tooltip ?? (props.short ? full() : undefined)} fallback={pill}>
			{(t) => <Tooltip content={t()}>{pill}</Tooltip>}
		</Show>
	);
}
