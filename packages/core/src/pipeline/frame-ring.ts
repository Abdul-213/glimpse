// GLIM-20 "OCR reuse, per Live session": a ring of the last 8 frame hashes -> OCR result. It
// catches A -> B -> A toggling (blinking prompts, alternating menu states): when a settled
// frame is pixel-for-pixel one the session already read, its result is reused instead of
// running OCR again. Exact only: the key is a 64-bit hash (two independent 32-bit FNV-1a
// lanes) plus the size, over every byte of RGB.

/** Exact identity of an RGBA8 image: `WxH:hash`. Alpha is ignored (always 255 in captures). */
export function frameKey(img: { readonly width: number; readonly height: number; readonly data: Uint8Array }): string {
	const d = img.data;
	let h1 = 0x811c9dc5;
	let h2 = 0x050c5d1f;
	for (let i = 0; i + 2 < d.length; i += 4) {
		const r = d[i] ?? 0;
		const g = d[i + 1] ?? 0;
		const b = d[i + 2] ?? 0;
		h1 = Math.imul(h1 ^ r, 0x01000193);
		h1 = Math.imul(h1 ^ g, 0x01000193);
		h1 = Math.imul(h1 ^ b, 0x01000193);
		h2 = Math.imul(h2 ^ (b | (r << 8)), 0x01000193);
		h2 = Math.imul(h2 ^ g, 0x01000193);
	}
	return `${img.width}x${img.height}:${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export const FRAME_RING_SIZE = 8;

/** The last `capacity` distinct frames -> value, most recently used last. */
export class FrameRing<T> {
	readonly #capacity: number;
	readonly #entries = new Map<string, T>();

	constructor(capacity = FRAME_RING_SIZE) {
		this.#capacity = Math.max(1, capacity);
	}

	get size(): number {
		return this.#entries.size;
	}

	/** The value for `key`, which becomes the most recent entry. */
	get(key: string): T | undefined {
		const v = this.#entries.get(key);
		if (v === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, v);
		return v;
	}

	set(key: string, value: T): void {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		while (this.#entries.size > this.#capacity) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	clear(): void {
		this.#entries.clear();
	}
}
