import { type JSX, splitProps } from "solid-js";
import { createRoving } from "./roving.ts";

export interface ToolbarProps extends JSX.HTMLAttributes<HTMLDivElement> {
	/** Accessible name ("Live controls", "Translation actions"). */
	label: string;
}

/**
 * A row of icon buttons, 4px apart (popup footers, the Live strip). One Tab stop; ← →
 * (mirrored in RTL), Home and End move between buttons, per the ARIA toolbar pattern.
 */
export function Toolbar(props: ToolbarProps): JSX.Element {
	const [local, rest] = splitProps(props, ["label", "class", "children"]);
	let el: HTMLDivElement | undefined;
	const roving = createRoving(() => el, { selector: "button", orientation: "horizontal", wrap: true });
	return (
		<div
			ref={el}
			role="toolbar"
			aria-label={local.label}
			aria-orientation="horizontal"
			class={["flex items-center gap-1", local.class ?? ""].join(" ").trim()}
			onKeyDown={roving.onKeyDown}
			onFocusIn={roving.onFocusIn}
			{...rest}
		>
			{local.children}
		</div>
	);
}
