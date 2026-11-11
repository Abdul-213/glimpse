// A push-to-pull queue shared by the local translation providers: Worker callbacks push
// events, the provider's async generator awaits them.

/** A push-to-pull queue: callbacks push events, the generator awaits them. */
export class Channel<T> implements AsyncIterable<T> {
	readonly #items: T[] = [];
	#waiter: (() => void) | null = null;
	#closed = false;
	#error: { error: unknown } | null = null;

	push(item: T): void {
		this.#items.push(item);
		this.#wake();
	}

	close(): void {
		this.#closed = true;
		this.#wake();
	}

	fail(error: unknown): void {
		this.#error = { error };
		this.#wake();
	}

	#wake(): void {
		const waiter = this.#waiter;
		this.#waiter = null;
		waiter?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (;;) {
			const item = this.#items.shift();
			if (item !== undefined) {
				yield item;
				continue;
			}
			if (this.#error) throw this.#error.error;
			if (this.#closed) return;
			await new Promise<void>((resolve) => {
				this.#waiter = resolve;
			});
		}
	}
}
