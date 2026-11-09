import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { type JSX, Show, splitProps } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

export interface ToggleButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
	icon: IconName;
	/** The short visible label ("On screen"). */
	text: string;
	/** What pressing it does now, for the tooltip ("Show translations on screen"). */
	tooltip: string;
	/** Shortcut shown in the tooltip, already formatted for the OS ("Ctrl+Shift+T", "⌘⇧T"). */
	shortcut?: string;
	pressed: boolean;
	/**
	 * GLIM-163: shown but not usable. Unlike the native `disabled`, the button stays
	 * focusable and hoverable (`aria-disabled`), so its tooltip can say why; clicks do nothing.
	 */
	unavailable?: boolean;
}

/**
 * DESIGN.md `button-toggle` (GLIM-158): a labelled on/off button for a mode that has to be
 * found without hovering (Show translations on screen). 24px tall like `button-icon`, icon +
 * `label` text, a `border-control` edge at rest; pressed fills `overlay-selected`, the text
 * goes `text-primary` and the icon `accent`. The accessible name is the visible text, so a
 * screen reader hears "On screen, toggle button, pressed"; the tooltip adds the action and key.
 */
export function ToggleButton(props: ToggleButtonProps): JSX.Element {
	const [local, rest] = splitProps(props, [
		"icon",
		"text",
		"tooltip",
		"shortcut",
		"pressed",
		"class",
		"unavailable",
		"onClick",
	]);
	const onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (e) => {
		if (local.unavailable) {
			e.preventDefault();
			return;
		}
		const h = local.onClick;
		if (typeof h === "function") h(e);
		else if (Array.isArray(h)) h[0](h[1], e);
	};
	return (
		<KTooltip openDelay={500} closeDelay={0} skipDelayDuration={300} placement="top" gutter={6}>
			<KTooltip.Trigger
				as="button"
				type="button"
				class={["glim-toggle-btn", local.class ?? ""].join(" ").trim()}
				aria-pressed={local.pressed && !local.unavailable ? "true" : "false"}
				aria-disabled={local.unavailable ? "true" : undefined}
				aria-keyshortcuts={local.unavailable ? undefined : local.shortcut}
				onClick={onClick}
				{...rest}
			>
				<Icon name={local.icon} class="glim-toggle-btn-icon" />
				<span class="glim-toggle-btn-text">{local.text}</span>
			</KTooltip.Trigger>
			<KTooltip.Portal>
				<KTooltip.Content class="glim-tooltip">
					{local.tooltip}
					<Show when={local.shortcut && !local.unavailable}>
						<span class="text-text-secondary"> ({local.shortcut})</span>
					</Show>
				</KTooltip.Content>
			</KTooltip.Portal>
		</KTooltip>
	);
}
