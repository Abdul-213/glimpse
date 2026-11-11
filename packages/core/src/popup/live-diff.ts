// live-popup.md §5: block identity and diffing between settled Live captures. Pure.
//
// GLIM-157: "same text" means the same *words*: OCR reads an unchanged line slightly differently
// from one capture to the next (a hover highlight, antialiasing, a cursor nearby: a lost full
// stop, a space, a capital), and that must not count as a change. Texts are compared by
// `liveTextKey`: letters, digits and combining marks only, case-folded. A change of punctuation
// alone is not shown; a changed word or number is.
//
// 1. Match each new block to a previous one by equal text key (nearest), else by bbox
//    IoU ≥ 0.5; else it is new. (The spec lists IoU first; text first is what keeps a scrolling
//    chat from marking every line, see below.)
// 2. Matched + same normalised text -> unchanged: no upsert, no mark (even if its box jittered).
// 3. Matched + different text -> changed (neutral / skip blocks update silently).
// 4. New -> added (counts as changed; again, neutral / skip silently).
// 5. Unmatched previous -> removed.
// 6. Order: new blocks go in at their reading-order position; surviving blocks never swap.
// 7. A class flip with the same text (translate <-> skip) is an upsert without a mark.
//
// The change set is every changed and added block of one capture. The first fill marks nothing.

import { normaliseSegment } from "../cache/normalise.ts";
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import type { TextDirection } from "../language/script.ts";
import { iou } from "../pipeline/block-ids.ts";
import type { BlockClass } from "../pipeline/events.ts";

/** One block as the Live popup shows it (live-popup.md §12.4 `LiveBlock`). Plain data. */
export interface LiveBlock {
	/** Stable for the session. */
	readonly id: string;
	/** Position in the popup's list, 0-based. */
	readonly order: number;
	readonly cls: BlockClass;
	readonly lang: LanguageCode | null;
	readonly direction: TextDirection;
	/** Region-local device pixels (the captured image's space), for the frame's linked box. */
	readonly box: Rect;
	readonly source: string;
	/** Final translation; null while pending (and for skip / neutral / target blocks). */
	readonly translation: string | null;
	readonly failed: boolean;
	/** Waiting for a language pack (the pack row lists it). */
	readonly waitingForPack: boolean;
}

/** An upserted block, with whether it is part of the change set (gets the mark). */
export interface LiveBlockUpdate extends LiveBlock {
	readonly changed: boolean;
}

/** What one settled capture produced, before ids are assigned. */
export type LiveBlockInput = Omit<LiveBlock, "id" | "order">;

export interface LiveDiff {
	/** The new shown state, in display order. */
	readonly blocks: readonly LiveBlock[];
	/** Only blocks whose content, class or language changed, or that are new. */
	readonly upserts: readonly LiveBlockUpdate[];
	readonly removes: readonly string[];
	/** Every shown id in display order. */
	readonly order: readonly string[];
	/** Ids to mark; [] keeps the current marks (live-popup.md §2.5). */
	readonly changeSet: readonly string[];
	/** For each input (by index), the id it now has. */
	readonly ids: readonly string[];
}

export interface LiveDiffOptions {
	/** Fresh ids for new blocks. */
	readonly newId: () => string;
	/** The first fill of a session marks nothing (L0). Default: `prev` is empty. */
	readonly first?: boolean;
	readonly minIou?: number;
}

const silent = (cls: BlockClass) => cls === "neutral" || cls === "skip";

/**
 * GLIM-157: what two readings of a block must share to be "the same text": the normalised
 * text's letters, digits and combining marks (tone marks, vowel signs), lower-cased. Text
 * that is only punctuation or symbols ("…", "→") keeps its normalised form.
 */
export function liveTextKey(text: string): string {
	const normalised = normaliseSegment(text);
	const words = normalised.replace(/[^\p{L}\p{N}\p{M}]/gu, "").toLocaleLowerCase("und");
	return words === "" ? normalised : words;
}

export function diffLiveBlocks(
	prev: readonly LiveBlock[],
	next: readonly LiveBlockInput[],
	options: LiveDiffOptions,
): LiveDiff {
	const first = options.first ?? prev.length === 0;
	const minIou = options.minIou ?? 0.5;
	const match: (number | null)[] = next.map(() => null);
	const taken = new Set<number>();

	// 1a. Equal normalised text first, nearest wins (as GLIM-56's BlockIdTracker): in a scrolling
	// chat every line moves into the box of the line above it, and matching by IoU first would
	// mark them all as changed. Then 1b: best IoU for the rest (a line rewritten in place).
	const prevText = prev.map((p) => liveTextKey(p.source));
	const nextText = next.map((n) => liveTextKey(n.source));
	const pairs: { i: number; j: number; score: number }[] = [];
	next.forEach((n, i) => {
		prev.forEach((p, j) => {
			if (nextText[i] !== "" && nextText[i] === prevText[j]) {
				const dist = Math.hypot(n.box.x - p.box.x, n.box.y - p.box.y);
				pairs.push({ i, j, score: 2 + iou(n.box, p.box) - dist / 1e6 });
			} else {
				const s = iou(n.box, p.box);
				if (s >= minIou) pairs.push({ i, j, score: s });
			}
		});
	});
	pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
	for (const { i, j } of pairs) {
		if (match[i] !== null || taken.has(j)) continue;
		match[i] = j;
		taken.add(j);
	}

	const ids: string[] = [];
	const upserts: LiveBlockUpdate[] = [];
	const changeSet: string[] = [];
	const byId = new Map<string, LiveBlock>();
	next.forEach((n, i) => {
		const j = match[i];
		const p = j === null || j === undefined ? undefined : prev[j];
		const id = p?.id ?? options.newId();
		ids.push(id);
		if (p && liveTextKey(p.source) === liveTextKey(n.source)) {
			// Unchanged text: keep what is shown (its text and translation too), take the new box.
			const sameMeta = p.cls === n.cls && p.lang === n.lang;
			const kept: LiveBlock = sameMeta
				? { ...p, box: n.box, waitingForPack: n.waitingForPack }
				: { ...n, id, order: 0, translation: n.translation ?? (p.cls === n.cls ? p.translation : null) };
			byId.set(id, kept);
			if (!sameMeta) upserts.push({ ...kept, changed: false });
			return;
		}
		const block: LiveBlock = { ...n, id, order: 0 };
		byId.set(id, block);
		const changed = !first && !silent(n.cls);
		upserts.push({ ...block, changed });
		if (changed) changeSet.push(id);
	});
	const removes = prev.filter((_, j) => !taken.has(j)).map((p) => p.id);

	// 6. Survivors keep their relative order; new blocks go after the block that precedes them
	// in reading order.
	const survivors = new Set(prev.filter((_, j) => taken.has(j)).map((p) => p.id));
	const order = prev.filter((p) => survivors.has(p.id)).map((p) => p.id);
	ids.forEach((id, i) => {
		if (survivors.has(id)) return;
		let at = 0;
		for (let k = i - 1; k >= 0; k--) {
			const anchor = order.indexOf(ids[k] ?? "");
			if (anchor >= 0) {
				at = anchor + 1;
				break;
			}
		}
		order.splice(at, 0, id);
	});

	const blocks = order.map((id, index) => {
		const b = byId.get(id) as LiveBlock;
		return b.order === index ? b : { ...b, order: index };
	});
	const position = new Map(blocks.map((b) => [b.id, b.order]));
	return {
		blocks,
		upserts: upserts.map((u) => ({ ...u, order: position.get(u.id) ?? u.order })),
		removes,
		order,
		changeSet,
		ids,
	};
}
