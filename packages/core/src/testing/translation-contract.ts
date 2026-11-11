// Contract checks every TranslationProvider must pass (GLIM-33). See contract.ts for usage.

import type { LanguageCode } from "../language.ts";
import { isProviderId, sameFingerprint } from "../providers/provenance.ts";
import {
	collectTranslations,
	routeFingerprint,
	routeVia,
	type TranslationEvent,
	type TranslationProvider,
	type TranslationRequest,
} from "../providers/translation.ts";
import { type ContractCheck, check, expectProviderError, lifecycleChecks, withReadyProvider } from "./contract.ts";

export interface TranslationContractFixture {
	/** A pair the provider serves once ready (packs installed / key present). */
	readonly pair: { readonly from: LanguageCode; readonly to: LanguageCode };
	/** Short texts in `pair.from`; at least two. Default English-ish samples. */
	readonly texts?: readonly string[];
	/** A pair the provider can never serve, if one exists. */
	readonly unsupportedPair?: { readonly from: LanguageCode; readonly to: LanguageCode };
}

async function drain(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
	const events: TranslationEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function requestFor(fixture: TranslationContractFixture, prefix = "s"): TranslationRequest {
	const texts = fixture.texts ?? ["Hello.", "Good morning.", "Press any key to continue."];
	check(texts.length >= 2, "fixture.texts needs at least two texts");
	return {
		to: fixture.pair.to,
		segments: texts.map((text, i) => ({ id: `${prefix}${i}`, text, from: fixture.pair.from })),
	};
}

/** Check the event-stream rules for one request; returns the terminal events by id. */
function checkStream(
	provider: TranslationProvider,
	request: TranslationRequest,
	events: readonly TranslationEvent[],
): Map<string, TranslationEvent> {
	const ids = new Set(request.segments.map((s) => s.id));
	const terminal = new Map<string, TranslationEvent>();
	for (const event of events) {
		check(ids.has(event.id), `event for unknown segment id ${JSON.stringify(event.id)}`);
		check(!terminal.has(event.id), `event after the terminal event for ${event.id}`);
		if (event.type === "partial") {
			check(provider.capabilities.streaming, "non-streaming provider emitted a partial");
			check(typeof event.text === "string", "partial text must be a string");
		} else terminal.set(event.id, event);
	}
	for (const id of ids) check(terminal.has(id), `segment ${id} got no done/error event`);
	return terminal;
}

export function translationProviderContract(
	make: () => TranslationProvider | Promise<TranslationProvider>,
	fixture: TranslationContractFixture,
): ContractCheck[] {
	const { from, to } = fixture.pair;
	return [
		...lifecycleChecks(make),
		{
			name: "info and capabilities are consistent",
			run: async () => {
				const p = await make();
				try {
					check(p.info.task === "translation", `info.task is ${p.info.task}`);
					check(isProviderId(p.info.id), `invalid provider id ${JSON.stringify(p.info.id)}`);
					check(p.info.name.trim() !== "", "info.name must not be empty");
					check(p.info.kind === p.capabilities.kind, "info.kind and capabilities.kind differ");
					if (p.info.kind === "cloud") {
						check(p.capabilities.needsNetwork, "cloud providers need the network");
						check(p.info.vendor !== null, "cloud providers must name their vendor (GLIM-22 indicator)");
					}
					for (const limit of [
						p.capabilities.maxCharsPerRequest,
						p.capabilities.maxCharsPerSegment,
						p.capabilities.maxSegmentsPerRequest,
					]) {
						check(limit === null || (Number.isInteger(limit) && limit > 0), `bad limit ${limit}`);
					}
				} finally {
					await p.dispose();
				}
			},
		},
		{
			name: "pairSupport: fixture pair is ready with a connected route",
			run: () =>
				withReadyProvider(make, async (p) => {
					const support = p.pairSupport(from, to);
					check(support.status === "ready", `pairSupport(${from}, ${to}) is ${support.status}`);
					const { hops } = support;
					check(hops.length >= 1, "a ready route has at least one hop");
					check(hops[0]?.from === from && hops.at(-1)?.to === to, "route must start at from and end at to");
					hops.forEach((hop, i) => {
						check(hop.fingerprint.providerId === p.info.id, "hop fingerprint must carry the provider id");
						const next = hops[i + 1];
						if (next) check(hop.to === next.from, "hops must connect");
					});
					if (hops.length > 1) {
						check(p.capabilities.pivot !== null, "multi-hop route without a declared pivot");
						for (const hop of hops.slice(1)) check(hop.from === p.capabilities.pivot, "pivot hop not via pivot");
					}
					const again = p.pairSupport(from, to);
					check(again.status === "ready", "pairSupport must be stable");
					check(
						again.hops.every((h, i) => {
							const prev = hops[i];
							return prev !== undefined && sameFingerprint(prev.fingerprint, h.fingerprint);
						}),
						"pairSupport fingerprints must be stable",
					);
				}),
		},
		{
			name: "translate: exactly one terminal event per segment, partials before it",
			run: () =>
				withReadyProvider(make, async (p) => {
					const request = requestFor(fixture);
					const terminal = checkStream(p, request, await drain(p.translate(request)));
					for (const event of terminal.values()) {
						check(event.type === "done", `fixture segment failed: ${JSON.stringify(event)}`);
					}
				}),
		},
		{
			name: "translate: results carry provenance matching the route",
			run: () =>
				withReadyProvider(make, async (p) => {
					const support = p.pairSupport(from, to);
					check(support.status === "ready", "fixture pair not ready");
					const expected = routeFingerprint(support.hops);
					const request = requestFor(fixture);
					const results = await collectTranslations(p, request);
					for (const segment of request.segments) {
						const outcome = results.get(segment.id);
						check(outcome?.ok, `segment ${segment.id} failed`);
						const t = outcome.translation;
						check(typeof t.text === "string" && t.text.trim() !== "", "translation text must be non-empty");
						check(t.from === segment.from && t.to === request.to, "translation from/to must match the request");
						check(
							JSON.stringify(t.via) === JSON.stringify(routeVia(support.hops)),
							`via ${JSON.stringify(t.via)} does not match the route`,
						);
						check(t.provider.id === p.info.id && t.provider.kind === p.info.kind, "provenance id/kind mismatch");
						check(t.provider.name === p.info.name, "provenance name mismatch");
						check(sameFingerprint(t.provider, expected), "provenance fingerprint must equal routeFingerprint(hops)");
						check(t.provider.remembered === undefined, "providers never set `remembered` (the cache does)");
					}
				}),
		},
		{
			name: "translate: an empty request yields nothing",
			run: () =>
				withReadyProvider(make, async (p) => {
					const events = await drain(p.translate({ to, segments: [] }));
					check(events.length === 0, `expected no events, got ${events.length}`);
				}),
		},
		{
			name: "translate: duplicate segment ids reject invalid-request",
			run: () =>
				withReadyProvider(make, async (p) => {
					const request: TranslationRequest = {
						to,
						segments: [
							{ id: "x", text: "a", from },
							{ id: "x", text: "b", from },
						],
					};
					await expectProviderError("duplicate ids", "invalid-request", () => drain(p.translate(request)));
				}),
		},
		{
			name: "translate: an already-aborted signal rejects cancelled with no events",
			run: () =>
				withReadyProvider(make, async (p) => {
					const controller = new AbortController();
					controller.abort();
					const events: TranslationEvent[] = [];
					await expectProviderError("aborted translate", "cancelled", async () => {
						for await (const e of p.translate(requestFor(fixture), { signal: controller.signal })) events.push(e);
					});
					check(events.length === 0, "no events may be yielded for an aborted signal");
				}),
		},
		{
			name: "translate: aborting mid-stream stops it with cancelled",
			run: () =>
				withReadyProvider(make, async (p) => {
					const controller = new AbortController();
					const iterator = p.translate(requestFor(fixture), { signal: controller.signal })[Symbol.asyncIterator]();
					const first = await iterator.next();
					check(!first.done, "expected at least one event");
					controller.abort();
					await expectProviderError("next() after abort", "cancelled", () => iterator.next());
				}),
		},
		{
			name: "translate: unsupported pair gives per-segment errors, not a throw",
			run: () =>
				withReadyProvider(make, async (p) => {
					const pair = fixture.unsupportedPair;
					if (!pair) return;
					check(p.pairSupport(pair.from, pair.to).status === "unsupported", "fixture.unsupportedPair is supported");
					const request: TranslationRequest = {
						to: pair.to,
						segments: [{ id: "u0", text: "x", from: pair.from }],
					};
					const terminal = checkStream(p, request, await drain(p.translate(request)));
					const event = terminal.get("u0");
					check(event?.type === "error", "unsupported segment must get an error event");
					check(event.error.code === "unsupported-language", `error code ${event.error.code}`);
					check(event.error.providerId === p.info.id, "error must name the provider");
				}),
		},
		{
			name: "translate: segments over maxCharsPerSegment get input-too-large",
			run: () =>
				withReadyProvider(make, async (p) => {
					const max = p.capabilities.maxCharsPerSegment;
					if (max === null) return;
					const request: TranslationRequest = { to, segments: [{ id: "big", text: "a ".repeat(max), from }] };
					const terminal = checkStream(p, request, await drain(p.translate(request)));
					const event = terminal.get("big");
					check(event?.type === "error" && event.error.code === "input-too-large", "expected input-too-large");
				}),
		},
		{
			name: "translate: after dispose every segment errors not-ready",
			run: async () => {
				const p = await make();
				await p.init();
				await p.dispose();
				const request = requestFor(fixture);
				const terminal = checkStream(p, request, await drain(p.translate(request)));
				for (const event of terminal.values()) {
					check(event.type === "error" && event.error.code === "not-ready", "expected not-ready after dispose");
				}
			},
		},
	];
}
