// When Live must ask before it sends anything to a cloud provider (live-popup.md L10, flows
// C1, GLIM-22). Snip needs no per-use question: choosing a cloud provider in Settings (with
// its own confirm) is the consent, and every result says where it went.
//
// Defaults chosen for the open questions in GLIM-94 #16 (the owner can override):
// - Live asks once, in the popup, before the first session that uses a cloud translator.
//   "Don't ask again for Live" is remembered **per provider** (`settings.cloud.liveConsent`),
//   so a new cloud provider asks again.
// - Cloud OCR in Live (an image of the region on every change, the expensive case in
//   GLIM-22) asks **every session** and offers no "Don't ask again".

import type { ProviderRef } from "./provenance.ts";

export interface LiveConsentInput {
	/** The OCR provider Live will use. */
	readonly ocr: ProviderRef | null;
	/** The translator Live will try first (the head of the chain). */
	readonly translation: ProviderRef | null;
	/** `settings.cloud.liveConsent`. */
	readonly remembered: readonly string[];
}

export type LiveConsent =
	| { readonly ask: false }
	| {
			readonly ask: true;
			/** The cloud providers this session would send to, OCR first. */
			readonly providers: readonly ProviderRef[];
			/** Offer "Don't ask again for Live" (false when cloud OCR is involved). */
			readonly canRemember: boolean;
			/** `cloud-ocr`: an image goes out on every change. `cloud-translation`: text does. */
			readonly reason: "cloud-ocr" | "cloud-translation";
	  };

export function liveCloudConsent(input: LiveConsentInput): LiveConsent {
	const cloud = [input.ocr, input.translation].filter((p): p is ProviderRef => p?.kind === "cloud");
	if (cloud.length === 0) return { ask: false };
	if (input.ocr?.kind === "cloud") return { ask: true, providers: cloud, canRemember: false, reason: "cloud-ocr" };
	const translator = input.translation;
	if (translator && input.remembered.includes(translator.id)) return { ask: false };
	return { ask: true, providers: cloud, canRemember: true, reason: "cloud-translation" };
}
