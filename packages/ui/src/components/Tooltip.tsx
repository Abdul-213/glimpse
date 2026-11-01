import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import type { JSX } from "solid-js";

export interface TooltipProps {
	content: JSX.Element;
	/** The trigger element. Rendered as `as` (default span); buttons pass "button". */
	children: JSX.Element;
	placement?: "top" | "bottom" | "left" | "right";
}

/**
 * DESIGN.md Tooltip: `surface-popup-solid`, `label` type, after 500 ms of hover, at once
 * on keyboard focus. Kobalte handles the a11y wiring (aria-describedby, Esc to close).
 */
export function Tooltip(props: TooltipProps): JSX.Element {
	return (
		<KTooltip openDelay={500} closeDelay={0} skipDelayDuration={300} placement={props.placement ?? "top"} gutter={6}>
			<KTooltip.Trigger as="span" class="inline-flex">
				{props.children}
			</KTooltip.Trigger>
			<KTooltip.Portal>
				<KTooltip.Content class="glim-tooltip">{props.content}</KTooltip.Content>
			</KTooltip.Portal>
		</KTooltip>
	);
}

export { KTooltip };
