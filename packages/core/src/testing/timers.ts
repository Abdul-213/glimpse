// Fake Timers (the Live loop's clock + setTimeout port) on virtual time. `advance(ms)` fires
// due timers in time order and lets the promises they start settle between timers, so an
// async loop (grab -> diff -> OCR fake -> schedule) runs deterministically and instantly.
import type { TimerHandle, Timers } from "../pipeline/live-loop.ts";

interface Pending {
	readonly id: number;
	readonly at: number;
	readonly callback: () => void;
}

/** Let queued promise callbacks (and promises they chain) run. */
export async function flushAsync(rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class ManualTimers implements Timers {
	#t: number;
	#nextId = 1;
	#pending: Pending[] = [];

	constructor(start = 0) {
		this.#t = start;
	}

	readonly now = (): number => this.#t;

	setTimeout(callback: () => void, ms: number): TimerHandle {
		const id = this.#nextId++;
		this.#pending.push({ id, at: this.#t + Math.max(0, ms), callback });
		return id;
	}

	clearTimeout(handle: TimerHandle): void {
		this.#pending = this.#pending.filter((p) => p.id !== handle);
	}

	/** Timers waiting to fire. */
	get pending(): number {
		return this.#pending.length;
	}

	/** When the next timer fires, or null. */
	get nextAt(): number | null {
		let min: number | null = null;
		for (const p of this.#pending) if (min === null || p.at < min) min = p.at;
		return min;
	}

	/** Move time forward by `ms`, firing every timer that falls due on the way. */
	async advance(ms: number): Promise<void> {
		await this.advanceTo(this.#t + ms);
	}

	async advanceTo(target: number): Promise<void> {
		await flushAsync();
		for (;;) {
			const next = this.#pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!next) break;
			this.#pending = this.#pending.filter((p) => p !== next);
			this.#t = Math.max(this.#t, next.at);
			next.callback();
			await flushAsync();
		}
		this.#t = Math.max(this.#t, target);
	}

	/** Jump the clock without firing anything (a system sleep). */
	jump(ms: number): void {
		this.#t += ms;
	}
}
