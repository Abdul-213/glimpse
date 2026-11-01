import { type JSX, splitProps } from "solid-js";
import { createRoving } from "./roving.ts";

export interface BlockListProps extends JSX.HTMLAttributes<HTMLUListElement> {
	ref?: (el: HTMLUListElement) => void;
}

/**
 * The scrolling list of TextBlocks (snip-popup.md §2.2, §11). One Tab stop; ↑ ↓ Home End
 * move between blocks, including the skipped line and its expanded blocks. The container
 * itself takes focus when the popup opens (tabindex −1, no ring).
 */
export function BlockList(props: BlockListProps): JSX.Element {
	const [local, rest] = splitProps(props, ["class", "children", "ref"]);
	let el: HTMLUListElement | undefined;
	const roving = createRoving(() => el, {
		selector: "[data-block], [data-roving]",
		orientation: "vertical",
		wrap: false,
	});
	return (
		<ul
			ref={(node) => {
				el = node;
				local.ref?.(node);
			}}
			tabindex={-1}
			class={["glim-block-list", local.class ?? ""].join(" ").trim()}
			onKeyDown={roving.onKeyDown}
			onFocusIn={roving.onFocusIn}
			{...rest}
		>
			{local.children}
		</ul>
	);
}
