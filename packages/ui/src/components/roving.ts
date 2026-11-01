// DOM half of roving tabindex: exactly one item in the container is tabbable, arrows move
// focus, and items added later (streamed blocks) are kept in line by a MutationObserver.
import { onCleanup, onMount } from "solid-js";
import { nextIndex, type Orientation } from "../roving.ts";

export interface RovingOptions {
	selector: string;
	orientation: Orientation;
	wrap: boolean;
}

export function createRoving(container: () => HTMLElement | undefined, options: RovingOptions) {
	let active = 0;

	const items = (): HTMLElement[] => {
		const root = container();
		if (!root) return [];
		return [...root.querySelectorAll<HTMLElement>(options.selector)].filter(
			(el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-hidden") !== "true",
		);
	};

	const sync = () => {
		const list = items();
		if (list.length === 0) return;
		active = Math.min(active, list.length - 1);
		list.forEach((el, i) => {
			const want = i === active ? "0" : "-1";
			if (el.getAttribute("tabindex") !== want) el.setAttribute("tabindex", want);
		});
	};

	onMount(() => {
		sync();
		const root = container();
		if (!root) return;
		const observer = new MutationObserver(sync);
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
		onCleanup(() => observer.disconnect());
	});

	const onFocusIn = (e: FocusEvent) => {
		const i = items().indexOf(e.target as HTMLElement);
		if (i >= 0 && i !== active) {
			active = i;
			sync();
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const list = items();
		const current = list.indexOf(document.activeElement as HTMLElement);
		const root = container();
		const dir = root && getComputedStyle(root).direction === "rtl" ? "rtl" : "ltr";
		let next = nextIndex(Math.max(current, 0), list.length, e.key, options.orientation, { dir, wrap: options.wrap });
		if (next === null) return;
		// Focus parked on the container itself (Snip opens that way): any arrow enters at the
		// first item; End still goes to the last.
		if (current < 0 && e.key !== "End") next = 0;
		e.preventDefault();
		active = next;
		sync();
		list[next]?.focus();
	};

	return { onFocusIn, onKeyDown, sync };
}
