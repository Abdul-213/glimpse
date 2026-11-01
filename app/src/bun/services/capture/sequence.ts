/**
 * Folds per-piece backend sequences into one session sequence: it moves only when at
 * least one piece reported new content, so "same sequence" keeps meaning "same pixels"
 * for a rect that spans displays.
 */
export class SequenceTracker {
	private last: readonly number[] = [];
	private value = 0;

	update(pieceSequences: readonly number[]): number {
		const changed =
			this.value === 0 ||
			pieceSequences.length !== this.last.length ||
			pieceSequences.some((s, i) => s !== this.last[i]);
		if (changed) this.value++;
		this.last = [...pieceSequences];
		return this.value;
	}

	/** Force the next update to count as new content (backend switched, plan changed). */
	invalidate(): void {
		this.last = [];
	}
}

/** Monotonic counter for one-shot captures, which never share a sequence. */
export function oneShotCounter(): () => number {
	let n = 0;
	return () => ++n;
}
