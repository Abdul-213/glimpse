// Logical display lists built from the native helpers' own display reports, for running
// the native backends WITHOUT Electrobun (the harness's --native mode on a real
// Windows PC or Mac). The app itself always uses Electrobun's Screen API instead.
import type { Display } from "@glimpse/core";
import type { MacNativeDisplay } from "../../native/macos.ts";
import type { PhysicalDisplay } from "../../native/windows.ts";

/** macOS: CoreGraphics bounds are already global points, i.e. Electrobun's logical space. */
export function displaysFromMac(native: readonly MacNativeDisplay[]): Display[] {
	return native.map((d) => ({
		id: d.id,
		bounds: d.bounds,
		workArea: d.bounds,
		scaleFactor: d.scale > 0 ? d.scale : 1,
		isPrimary: d.primary,
	}));
}

/**
 * Windows: each monitor at physical / (dpi / 96). Exact for the primary monitor (origin
 * 0,0), approximate for the others: Electrobun lays secondary monitors out edge to edge
 * at their own scale, which this doesn't reproduce. Good enough for harness captures
 * that stay on one monitor.
 */
export function displaysFromWindows(native: readonly PhysicalDisplay[]): Display[] {
	return native.map((d) => {
		const s = d.dpi > 0 ? d.dpi / 96 : 1;
		const bounds = { x: d.bounds.x / s, y: d.bounds.y / s, width: d.bounds.width / s, height: d.bounds.height / s };
		return { id: d.id, bounds, workArea: bounds, scaleFactor: s, isPrimary: d.primary };
	});
}
