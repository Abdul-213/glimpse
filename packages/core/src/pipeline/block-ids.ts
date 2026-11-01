// GLIM-56: block ids that stay stable across Live frames. A block that is still where it was
// (box overlap), or that moved but kept its text (scrolling), keeps its id; everything else
// gets a fresh one. The Live popup updates blocks in place by id (GLIM-79), and the per-block
// language hysteresis (GLIM-49) and translation reuse (GLIM-67) key on it. Pure, deterministic.

import type { BlockId, OcrBlock } from "../block.ts";
import { area, intersection, type Rect } from "../geometry.ts";

export interface BlockIdOptions {
	/** Minimum intersection-over-union to count as the same place. */
	readonly minIou: number;
	/** A same-text block may move this far (x its height) and keep its id. */
	readonly maxTextMove: number;
	readonly prefix: string;
}

export const BLOCK_ID_DEFAULTS: BlockIdOptions = { minIou: 0.5, maxTextMove: 20, prefix: "k" };

export function iou(a: Rect, b: Rect): number {
	const i = intersection(a, b);
	if (!i) return 0;
	const inter = area(i);
	return inter / (area(a) + area(b) - inter);
}

const normalise = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();

export class BlockIdTracker {
	readonly #o: BlockIdOptions;
	#previous: readonly OcrBlock[] = [];
	#next = 1;

	constructor(options: Partial<BlockIdOptions> = {}) {
		this.#o = { ...BLOCK_ID_DEFAULTS, ...options };
	}

	/** Forget the previous frame (new region, Live restarted). Ids keep counting up. */
	reset(): void {
		this.#previous = [];
	}

	/** Re-id `blocks` (one frame, any ids) against the previous frame, and remember them. */
	assign(blocks: readonly OcrBlock[]): OcrBlock[] {
		const prev = this.#previous;
		const ids: (BlockId | null)[] = blocks.map(() => null);
		const taken = new Set<number>();

		// Same text first (strongest evidence; handles scrolling), nearest wins.
		const pairs: { i: number; j: number; score: number }[] = [];
		blocks.forEach((b, i) => {
			const text = normalise(b.text);
			prev.forEach((p, j) => {
				const overlap = iou(b.box, p.box);
				if (text !== "" && normalise(p.text) === text) {
					const dist = Math.hypot(b.box.x - p.box.x, b.box.y - p.box.y);
					if (dist <= this.#o.maxTextMove * Math.max(1, p.box.height))
						pairs.push({ i, j, score: 2 + overlap - dist / 1e6 });
				} else if (overlap >= this.#o.minIou) pairs.push({ i, j, score: overlap });
			});
		});
		pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
		for (const { i, j } of pairs) {
			if (ids[i] !== null || taken.has(j)) continue;
			ids[i] = prev[j]?.id ?? null;
			taken.add(j);
		}
		const out = blocks.map((b, i) => ({ ...b, id: ids[i] ?? `${this.#o.prefix}${this.#next++}` }));
		this.#previous = out;
		return out;
	}
}
