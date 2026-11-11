// GLIM-20 cache key: one entry per translated segment (a sentence) and per hop.
//
//   key = H("v1" | normaliserVersion | segmenterVersion | normalisedSegment | src | tgt
//           | providerId | modelRev | optionsHash | contextHash?)
//
// `src` and `tgt` are the codes the provider actually received for that hop (a Bergamot
// `ja → de` request is two keys: `ja → en` and `en → de`). The fingerprint is the hop's
// own, so updating one pack invalidates only the hop it serves.

import type { LanguageCode } from "../language/code.ts";
import { fingerprintKey, hashString, type ProviderFingerprint } from "../providers/provenance.ts";
import { SEGMENTER_VERSION } from "../text/sentences.ts";
import { NORMALISER_VERSION } from "./normalise.ts";

export const CACHE_KEY_VERSION = "v1";

export interface TranslationKey {
	/** Normalised segment: exactly what the provider receives. */
	readonly text: string;
	readonly from: LanguageCode;
	readonly to: LanguageCode;
	readonly fingerprint: ProviderFingerprint;
	/** Only for `contextSensitive` providers: a hash of the context actually passed. */
	readonly contextHash?: string;
}

/** Everything but the text, as one string. Stored with each entry to rule out hash collisions. */
export function keyIdentity(key: TranslationKey): string {
	return [
		CACHE_KEY_VERSION,
		NORMALISER_VERSION,
		SEGMENTER_VERSION,
		key.from,
		key.to,
		fingerprintKey(key.fingerprint),
		key.contextHash ?? "",
	].join("|");
}

/** The in-memory map key: two independent 53-bit hashes of identity + text (not cryptographic). */
export function keyHash(key: TranslationKey): string {
	const material = `${keyIdentity(key)}\u0000${key.text}`;
	return `${hashString(material)}${hashString(material, 0x9e3779b9)}`;
}
