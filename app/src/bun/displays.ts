// Adapter: Electrobun's Screen API -> @glimpse/core Display. The shape is the same
// today; keeping the copy here means core never depends on Electrobun's types.
import { type Display, rect } from "@glimpse/core";
import { Screen } from "electrobun/main";

interface ShellRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ShellDisplay {
	id: number;
	bounds: ShellRect;
	workArea: ShellRect;
	scaleFactor: number;
	isPrimary: boolean;
}

const toRect = (r: ShellRect) => rect(r.x, r.y, r.width, r.height);

export function toCoreDisplay(d: ShellDisplay): Display {
	return {
		id: d.id,
		bounds: toRect(d.bounds),
		workArea: toRect(d.workArea),
		scaleFactor: d.scaleFactor > 0 ? d.scaleFactor : 1,
		isPrimary: d.isPrimary,
	};
}

/** Current displays. Re-read on demand: Electrobun has no display-change event. */
export function readDisplays(): Display[] {
	return Screen.getAllDisplays().map(toCoreDisplay);
}
