// Fakes for the region picker's OS ports (core/picker/ports.ts).
import type { Point } from "../geometry.ts";
import type { FocusKeeper, LoupePatch, PixelSampler, ScreenWindow, WindowListSource } from "../picker/ports.ts";

/** A fixed window list. `fail` makes `list()` reject (the picker must cope). */
export class StaticWindowList implements WindowListSource {
	calls = 0;
	constructor(
		public windows: readonly ScreenWindow[] = [],
		public fail = false,
	) {}

	async list(): Promise<readonly ScreenWindow[]> {
		this.calls++;
		if (this.fail) throw new Error("window list unavailable");
		return [...this.windows].sort((a, b) => a.z - b.z);
	}
}

/** Records save/restore calls. `restorable` decides what `restore()` reports. */
export class RecordingFocusKeeper implements FocusKeeper {
	readonly calls: ("save" | "restore")[] = [];
	constructor(public restorable = true) {}

	save(): void {
		this.calls.push("save");
	}

	restore(): boolean {
		this.calls.push("restore");
		return this.restorable;
	}
}

/** A sampler that paints every cell with `paint(centre)`, counting calls. */
export class SolidPixelSampler implements PixelSampler {
	samples: Point[] = [];
	stopped = 0;
	private seq = 0;

	constructor(
		private readonly paint: (centre: Point) => readonly [number, number, number] | null = () => [128, 128, 128],
		private readonly displayId = 1,
	) {}

	async sample(centre: Point, size: number): Promise<LoupePatch | null> {
		this.samples.push(centre);
		const rgb = this.paint(centre);
		if (!rgb) return null;
		const rgba = new Uint8Array(size * size * 4);
		for (let i = 0; i < size * size; i++) rgba.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
		return { centre, displayId: this.displayId, size, rgba, sequence: ++this.seq };
	}

	stop(): void {
		this.stopped++;
	}
}
