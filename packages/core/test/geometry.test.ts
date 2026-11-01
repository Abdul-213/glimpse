import { describe, expect, test } from "bun:test";
import {
	area,
	contains,
	type Display,
	intersection,
	isEmpty,
	rect,
	rectFromPoints,
	regionOnDisplay,
	regionToDisplayPixels,
	scaleToPixels,
} from "../src/index.ts";

describe("geometry", () => {
	test("rectFromPoints is order-independent", () => {
		expect(rectFromPoints({ x: 50, y: 10 }, { x: 10, y: 40 })).toEqual(rect(10, 10, 40, 30));
		expect(rectFromPoints({ x: 10, y: 40 }, { x: 50, y: 10 })).toEqual(rect(10, 10, 40, 30));
	});

	test("area, isEmpty, contains", () => {
		expect(area(rect(0, 0, 3, 4))).toBe(12);
		expect(isEmpty(rect(5, 5, 0, 10))).toBe(true);
		expect(contains(rect(0, 0, 10, 10), { x: 9.9, y: 0 })).toBe(true);
		expect(contains(rect(0, 0, 10, 10), { x: 10, y: 5 })).toBe(false);
	});

	test("intersection", () => {
		expect(intersection(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(rect(5, 5, 5, 5));
		expect(intersection(rect(0, 0, 10, 10), rect(10, 0, 5, 5))).toBeNull();
	});

	test("scaleToPixels snaps outward", () => {
		expect(scaleToPixels(rect(10.3, 10.3, 5.2, 5.2), 1)).toEqual(rect(10, 10, 6, 6));
		expect(scaleToPixels(rect(1, 1, 3, 3), 1.5)).toEqual(rect(1, 1, 5, 5));
	});
});

describe("region", () => {
	const secondary: Display = {
		id: 2,
		bounds: rect(1920, 0, 1280, 800),
		workArea: rect(1920, 25, 1280, 775),
		scaleFactor: 2,
		isPrimary: false,
	};

	test("clips a selection to a display", () => {
		expect(regionOnDisplay(rect(1800, 100, 300, 100), secondary)).toEqual({
			displayId: 2,
			bounds: rect(1920, 100, 180, 100),
		});
		expect(regionOnDisplay(rect(0, 0, 100, 100), secondary)).toBeNull();
	});

	test("converts to display-local device pixels", () => {
		const region = { displayId: 2, bounds: rect(1930, 20, 100, 50) };
		expect(regionToDisplayPixels(region, secondary)).toEqual(rect(20, 40, 200, 100));
	});

	test("refuses a region from another display", () => {
		expect(() => regionToDisplayPixels({ displayId: 1, bounds: rect(0, 0, 1, 1) }, secondary)).toThrow();
	});
});
