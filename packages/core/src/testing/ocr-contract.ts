// Contract checks every OcrProvider must pass (GLIM-32). See contract.ts for usage.

import type { LanguageCode } from "../language.ts";
import type { OcrImage, OcrProgress, OcrProvider } from "../providers/ocr.ts";
import { isProviderId, sameFingerprint } from "../providers/provenance.ts";
import { type ContractCheck, check, expectProviderError, lifecycleChecks, withReadyProvider } from "./contract.ts";

export interface OcrContractFixture {
	/** An image with readable text in it. */
	readonly image: OcrImage;
	/** A substring that some recognised block must contain, if the engine is real. */
	readonly expectText?: string;
	/** The language of the text in `image`; the provider must report it ready after init. */
	readonly language?: LanguageCode;
}

export function ocrProviderContract(
	make: () => OcrProvider | Promise<OcrProvider>,
	fixture: OcrContractFixture,
): ContractCheck[] {
	return [
		...lifecycleChecks(make),
		{
			name: "info and capabilities are consistent",
			run: async () => {
				const p = await make();
				try {
					check(p.info.task === "ocr", `info.task is ${p.info.task}`);
					check(isProviderId(p.info.id), `invalid provider id ${JSON.stringify(p.info.id)}`);
					check(p.info.kind === p.capabilities.kind, "info.kind and capabilities.kind differ");
					if (p.info.kind === "cloud") {
						check(p.capabilities.needsNetwork, "cloud providers need the network");
						check(p.info.vendor !== null, "cloud providers must name their vendor");
					}
				} finally {
					await p.dispose();
				}
			},
		},
		{
			name: "recognise: blocks are well-formed and inside the image",
			run: () =>
				withReadyProvider(make, async (p) => {
					const { image } = fixture;
					const result = await p.recognise({ image });
					const ids = new Set<string>();
					for (const b of result.blocks) {
						check(!ids.has(b.id), `duplicate block id ${b.id}`);
						ids.add(b.id);
						check(typeof b.text === "string", "block text must be a string");
						check(b.confidence >= 0 && b.confidence <= 1, `confidence ${b.confidence} outside 0..1`);
						const { x, y, width, height } = b.box;
						check(width >= 0 && height >= 0, "box size must be non-negative");
						check(
							x >= 0 && y >= 0 && x + width <= image.width && y + height <= image.height,
							`box ${JSON.stringify(b.box)} outside the ${image.width}x${image.height} image`,
						);
					}
					if (fixture.expectText) {
						const want = fixture.expectText;
						check(
							result.blocks.some((b) => b.text.includes(want)),
							`no block contains ${JSON.stringify(want)}`,
						);
					}
				}),
		},
		{
			name: "recognise: result carries provenance matching fingerprint()",
			run: () =>
				withReadyProvider(make, async (p) => {
					const result = await p.recognise({ image: fixture.image });
					check(result.provider.id === p.info.id && result.provider.kind === p.info.kind, "provenance mismatch");
					check(sameFingerprint(result.provider, p.fingerprint()), "provenance must equal fingerprint()");
					check(sameFingerprint(p.fingerprint(), p.fingerprint()), "fingerprint() must be stable");
				}),
		},
		{
			name: "recognise: progress events only when progressive, and consistent with the result",
			run: () =>
				withReadyProvider(make, async (p) => {
					const events: OcrProgress[] = [];
					const result = await p.recognise({ image: fixture.image }, { onProgress: (e) => events.push(e) });
					if (!p.capabilities.progressive) {
						check(events.length === 0, "non-progressive provider emitted progress");
						return;
					}
					const ids = new Set(result.blocks.map((b) => b.id));
					for (const e of events) {
						if (e.type === "block") check(ids.has(e.block.id), "progress block missing from the final result");
					}
				}),
		},
		{
			name: "languageSupport: unsupported before init, ready for the fixture language after",
			run: async () => {
				const lang = fixture.language;
				if (!lang) return;
				const p = await make();
				try {
					check(p.languageSupport(lang).status === "unsupported", "languageSupport before init must be unsupported");
					await p.init();
					const s = p.languageSupport(lang);
					check(s.status === "ready", `languageSupport(${lang}) after init is ${s.status}`);
				} finally {
					await p.dispose();
				}
			},
		},
		{
			name: "recognise: an already-aborted signal rejects cancelled",
			run: () =>
				withReadyProvider(make, async (p) => {
					const controller = new AbortController();
					controller.abort();
					await expectProviderError("aborted recognise", "cancelled", () =>
						p.recognise({ image: fixture.image }, { signal: controller.signal }),
					);
				}),
		},
		{
			name: "recognise: a malformed image rejects invalid-request",
			run: () =>
				withReadyProvider(make, async (p) => {
					const bad: OcrImage = { width: 10, height: 10, stride: 40, format: "rgba8", data: new Uint8Array(8) };
					await expectProviderError("malformed image", "invalid-request", () => p.recognise({ image: bad }));
				}),
		},
		{
			name: "recognise: images over maxImagePixels reject input-too-large",
			run: () =>
				withReadyProvider(make, async (p) => {
					const max = p.capabilities.maxImagePixels;
					if (max === null || max > 64_000_000) return;
					const width = max + 1;
					const big: OcrImage = { width, height: 1, stride: width, format: "gray8", data: new Uint8Array(width) };
					await expectProviderError("oversize image", "input-too-large", () => p.recognise({ image: big }));
				}),
		},
		{
			name: "recognise: after dispose rejects not-ready",
			run: async () => {
				const p = await make();
				await p.init();
				await p.dispose();
				await expectProviderError("recognise after dispose", "not-ready", () => p.recognise({ image: fixture.image }));
			},
		},
	];
}
