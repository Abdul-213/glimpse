// GLIM-88: recognition results cached by crop content. Live mode re-runs detection on every
// changed frame, but most lines are pixel-identical to the previous frame; their crops hash the
// same, so their text is reused and only changed lines pay for recognition (~50 ms each on CPU,
// spikes/inference/FINDINGS.md). A bounded LRU, keyed by recogniser + crop hash.

import type { OcrRecognizer } from "@glimpse/core";
import type { Raster } from "./image.ts";

export interface CachedReading {
	readonly text: string;
	readonly score: number;
}

/** 64-bit content hash of a packed crop (plus its size), as a string key. */
export type CropHasher = (crop: Raster) => string;

/** FNV-1a over 32-bit words, two lanes. Portable fallback; the worker uses `Bun.hash`. */
export const fnvCropHash: CropHasher = (crop) => {
	const { data, width, height } = crop;
	let h1 = 0x811c9dc5 ^ width;
	let h2 = 0x01000193 ^ height;
	const words = Math.floor(data.byteLength / 4);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let i = 0; i < words; i++) {
		const w = view.getUint32(i * 4, true);
		h1 = Math.imul(h1 ^ w, 16777619);
		h2 = Math.imul(h2 ^ (w >>> 7), 2246822507);
	}
	for (let i = words * 4; i < data.byteLength; i++) h1 = Math.imul(h1 ^ (data[i] as number), 16777619);
	return `${width}x${height}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
};

export class RecCache {
	readonly #max: number;
	readonly #map = new Map<string, CachedReading>();
	hits = 0;
	misses = 0;

	constructor(maxEntries: number) {
		this.#max = Math.max(0, Math.floor(maxEntries));
	}

	get size(): number {
		return this.#map.size;
	}

	get(recognizer: OcrRecognizer, cropKey: string): CachedReading | undefined {
		if (this.#max === 0) return undefined;
		const key = `${recognizer}|${cropKey}`;
		const hit = this.#map.get(key);
		if (hit) {
			// Refresh recency.
			this.#map.delete(key);
			this.#map.set(key, hit);
			this.hits++;
		} else this.misses++;
		return hit;
	}

	set(recognizer: OcrRecognizer, cropKey: string, reading: CachedReading): void {
		if (this.#max === 0) return;
		const key = `${recognizer}|${cropKey}`;
		this.#map.delete(key);
		this.#map.set(key, reading);
		while (this.#map.size > this.#max) {
			const oldest = this.#map.keys().next();
			if (oldest.done) break;
			this.#map.delete(oldest.value);
		}
	}

	clear(): void {
		this.#map.clear();
	}
}
