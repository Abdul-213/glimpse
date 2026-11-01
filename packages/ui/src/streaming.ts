// Streaming text (snip-popup.md §8): if a provider streams tokens, they append to the block
// at most once per animation frame, with no per-token animation and no caret.
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

export interface FrameScheduler {
	request(cb: () => void): number;
	cancel(handle: number): void;
}

const rafScheduler: FrameScheduler = {
	request: (cb) => requestAnimationFrame(cb),
	cancel: (h) => cancelAnimationFrame(h),
};

/**
 * Follows `source`, but publishes at most one new value per frame. The first value is
 * published at once so the first text paints in the same frame it arrives.
 */
export function createFrameText(source: Accessor<string>, scheduler: FrameScheduler = rafScheduler): Accessor<string> {
	const [shown, setShown] = createSignal(source());
	let pending: number | null = null;
	createEffect(() => {
		source();
		if (pending !== null) return;
		pending = scheduler.request(() => {
			pending = null;
			setShown(source());
		});
	});
	onCleanup(() => {
		if (pending !== null) scheduler.cancel(pending);
	});
	return shown;
}
