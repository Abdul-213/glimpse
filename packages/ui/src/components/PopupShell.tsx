import { type JSX, splitProps } from "solid-js";
import type { Direction } from "../format.ts";

export type PopupKind = "snip" | "live";
/** The popup's edge that faces the region; the enter animation grows from it. */
export type PopupFacing = "top" | "bottom" | "inline-start" | "inline-end";

export interface PopupShellProps extends JSX.HTMLAttributes<HTMLDivElement> {
	kind: PopupKind;
	/** UI direction for the chrome; block text sets its own. */
	dir?: Direction;
	facing?: PopupFacing;
	/** Play the enter animation (set when the pre-created window is shown). */
	entering?: boolean;
}

function origin(facing: PopupFacing, dir: Direction): string {
	switch (facing) {
		case "top":
			return "top center";
		case "bottom":
			return "bottom center";
		case "inline-start":
			return dir === "rtl" ? "right center" : "left center";
		case "inline-end":
			return dir === "rtl" ? "left center" : "right center";
	}
}

/**
 * The veil a Snip or Live popup paints over the native material (DESIGN.md Elevation &
 * Depth). Translucent `surface-popup` under `data-material="native"`, solid otherwise;
 * radius per platform (square on Windows 10); inner hairline; no shadow of its own (the
 * OS draws the window shadow). Snip is a dialog; Live is a region that never takes focus
 * by itself (live-popup.md §7).
 */
export function PopupShell(props: PopupShellProps): JSX.Element {
	const [local, rest] = splitProps(props, ["kind", "dir", "facing", "entering", "class", "style", "children"]);
	const dir = () => local.dir ?? "ltr";
	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dialog whenever aria-modal is set (Snip); Live is a region without it.
		<div
			role={local.kind === "snip" ? "dialog" : "region"}
			aria-modal={local.kind === "snip" ? "true" : undefined}
			dir={dir()}
			data-kind={local.kind}
			data-entering={local.entering ? "" : undefined}
			class={["glim-popup", local.class ?? ""].join(" ").trim()}
			style={{ "transform-origin": origin(local.facing ?? "top", dir()) }}
			{...rest}
		>
			{local.children}
		</div>
	);
}
