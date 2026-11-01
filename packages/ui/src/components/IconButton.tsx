import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { type JSX, Show, splitProps } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
	type?: "button" | "submit" | "reset";
	icon: IconName;
	/** Accessible name and tooltip text ("Copy translation"). */
	label: string;
	/** Shortcut shown in the tooltip, already formatted for the OS ("Ctrl+C", "⌘C"). */
	shortcut?: string;
	/** Toggle buttons (Show original, Private): sets aria-pressed and the pressed look. */
	pressed?: boolean;
}

/**
 * DESIGN.md `button-icon`: 24px, `text-secondary` at rest, `overlay-hover` + `text-primary`
 * on hover, `overlay-selected` when pressed. Always has a tooltip naming the action and key.
 */
export function IconButton(props: IconButtonProps): JSX.Element {
	const [local, rest] = splitProps(props, ["icon", "label", "shortcut", "pressed", "class", "type"]);
	return (
		<KTooltip openDelay={500} closeDelay={0} skipDelayDuration={300} placement="top" gutter={6}>
			<KTooltip.Trigger
				as="button"
				type={local.type ?? "button"}
				class={["glim-icon-btn", local.class ?? ""].join(" ").trim()}
				aria-label={local.label}
				aria-keyshortcuts={local.shortcut}
				aria-pressed={local.pressed === undefined ? undefined : local.pressed ? "true" : "false"}
				{...rest}
			>
				<Icon name={local.icon} />
			</KTooltip.Trigger>
			<KTooltip.Portal>
				<KTooltip.Content class="glim-tooltip">
					{local.label}
					<Show when={local.shortcut}>
						<span class="text-text-secondary"> ({local.shortcut})</span>
					</Show>
				</KTooltip.Content>
			</KTooltip.Portal>
		</KTooltip>
	);
}
