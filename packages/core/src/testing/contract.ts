// Shared plumbing for provider contract checks. Checks are plain async functions that
// throw on failure, so core stays free of `bun:test`; a test file turns them into tests:
//
//   for (const check of translationProviderContract(() => new BergamotProvider(...), fixture)) {
//     test(check.name, check.run);
//   }

import { isProviderError, type ProviderErrorCode } from "../providers/errors.ts";
import type { ProviderLifecycle, ProviderState } from "../providers/lifecycle.ts";

export interface ContractCheck {
	readonly name: string;
	readonly run: () => Promise<void>;
}

export class ContractViolation extends Error {
	override name = "ContractViolation";
}

export function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ContractViolation(message);
}

export async function expectProviderError(
	what: string,
	code: ProviderErrorCode,
	run: () => Promise<unknown>,
): Promise<void> {
	try {
		await run();
	} catch (error) {
		check(
			isProviderError(error, code),
			`${what}: expected ProviderError(${code}), got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
		);
		return;
	}
	throw new ContractViolation(`${what}: expected ProviderError(${code}), but it succeeded`);
}

/** Create, init (must reach ready), run, always dispose. */
export async function withReadyProvider<P extends ProviderLifecycle>(
	make: () => P | Promise<P>,
	run: (provider: P) => Promise<void>,
): Promise<void> {
	const provider = await make();
	try {
		const status = await provider.init();
		check(status.state === "ready", `init() should reach ready for the contract fixture, got ${status.state}`);
		await run(provider);
	} finally {
		await provider.dispose();
	}
}

/** Lifecycle checks shared by both provider kinds. */
export function lifecycleChecks<P extends ProviderLifecycle>(make: () => P | Promise<P>): ContractCheck[] {
	return [
		{
			name: "lifecycle: starts idle, init is idempotent and reaches ready",
			run: async () => {
				const provider = await make();
				try {
					const initial: ProviderState = provider.status.state;
					check(initial === "idle", `new provider should be idle, is ${initial}`);
					const seen: string[] = [];
					const unsubscribe = provider.onStatusChange((s) => seen.push(s.state));
					check(typeof unsubscribe === "function", "onStatusChange must return an unsubscribe function");
					const [a, b] = await Promise.all([provider.init(), provider.init()]);
					check(a.state === "ready" && b.state === "ready", `concurrent init() → ${a.state}, ${b.state}`);
					const after: ProviderState = provider.status.state;
					check(after === "ready", "status should be ready after init");
					check(seen.at(-1) === "ready", `listener should have seen ready last, saw ${seen.join(",")}`);
					const again = await provider.init();
					check(again.state === "ready", "init() when ready should resolve ready");
					unsubscribe();
				} finally {
					await provider.dispose();
				}
			},
		},
		{
			name: "lifecycle: init rejects cancelled for an aborted signal",
			run: async () => {
				const provider = await make();
				try {
					const controller = new AbortController();
					controller.abort();
					await expectProviderError("init(aborted)", "cancelled", () => provider.init(controller.signal));
				} finally {
					await provider.dispose();
				}
			},
		},
		{
			name: "lifecycle: dispose is idempotent and terminal",
			run: async () => {
				const provider = await make();
				await provider.init();
				await provider.dispose();
				await provider.dispose();
				check(provider.status.state === "disposed", `after dispose: ${provider.status.state}`);
				const status = await provider.init();
				check(status.state === "disposed", `init() after dispose should stay disposed, got ${status.state}`);
			},
		},
		{
			name: "lifecycle: warmup (if any) works when ready",
			run: () =>
				withReadyProvider(make, async (provider) => {
					await provider.warmup?.();
				}),
		},
	];
}
