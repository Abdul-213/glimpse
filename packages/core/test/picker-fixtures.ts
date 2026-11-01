// Display layouts for picker tests (region-picker spec 9.5), from spikes/overlay/test.
import { type Display, rect, withNativeBounds } from "../src/index.ts";

export const display = (
	id: number,
	bounds: ReturnType<typeof rect>,
	scaleFactor: number,
	isPrimary = false,
	workArea = bounds,
): Display => ({ id, bounds, workArea, scaleFactor, isPrimary });

/** macOS: Retina laptop (1512 x 982 pt @2x, menu bar 25 pt) main; 1x external to the right, 200 pt lower. */
export const macDisplays: Display[] = [
	display(1, rect(0, 0, 1512, 982), 2, true, rect(0, 25, 1512, 957)),
	display(2, rect(1512, 200, 1920, 1080), 1),
];

/**
 * Windows: 4K @150 % primary (2560 x 1440 DIP), 1080p @100 % to its right. Electrobun's
 * Chromium-style layout puts the second monitor at logical x 2560 but physical x 3840.
 */
export const winDisplays: Display[] = [
	display(65537, rect(0, 0, 2560, 1440), 1.5, true, rect(0, 0, 2560, 1392)),
	display(65539, rect(2560, 0, 1920, 1080), 1, false, rect(2560, 0, 1920, 1040)),
];
export const winPhysical = [
	{ id: 65537, name: "\\\\.\\DISPLAY1", bounds: rect(0, 0, 3840, 2160), dpi: 144, primary: true },
	{ id: 65539, name: "\\\\.\\DISPLAY2", bounds: rect(3840, 0, 1920, 1080), dpi: 96, primary: false },
];
export const winNative = withNativeBounds(winDisplays, winPhysical);

/** A 125 % monitor at negative x, left of a 100 % primary. */
export const negDisplays: Display[] = [
	display(10, rect(0, 0, 1920, 1080), 1, true),
	display(11, rect(-1536, 0, 1536, 864), 1.25),
];
