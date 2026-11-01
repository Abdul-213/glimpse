// Roving-tabindex arithmetic shared by Toolbar (horizontal) and BlockList (vertical).
import type { Direction } from "./format.ts";

export type Orientation = "horizontal" | "vertical";

/**
 * Index to focus after `key`, or null if the key isn't a navigation key. Horizontal
 * arrows follow the reading direction (ArrowLeft is "next" in RTL). Toolbars wrap at
 * the ends; block lists stop (`wrap: false`).
 */
export function nextIndex(
	current: number,
	count: number,
	key: string,
	orientation: Orientation,
	options: { dir?: Direction; wrap?: boolean } = {},
): number | null {
	if (count <= 0) return null;
	const rtl = options.dir === "rtl";
	const wrap = options.wrap ?? true;
	const forward = orientation === "vertical" ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
	const back = orientation === "vertical" ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
	switch (key) {
		case forward:
			return wrap ? (current + 1) % count : Math.min(current + 1, count - 1);
		case back:
			return wrap ? (current - 1 + count) % count : Math.max(current - 1, 0);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}
