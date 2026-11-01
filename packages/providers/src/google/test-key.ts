// "Test key" for the shared Google Cloud key (GLIM-75, flows settings.html P2). Checks both
// APIs the key is meant for without sending any screen content and, as far as Google's
// pricing pages say, without a billable unit:
// - Cloud Translation: `GET /v2/languages` (the supported-languages list).
// - Cloud Vision: `images:annotate` with an empty request list. The API gateway checks the
//   key, the API being enabled and billing before the method runs, so those errors come back
//   as usual; anything the method itself says about an empty batch (200, or 400
//   INVALID_ARGUMENT without a key reason) means the key works. Unverified against the live
//   API (no key during GLIM-75): if Vision ever bills or rejects this differently, switch to a
//   1x1 blank image.

import { isProviderError } from "@glimpse/core";
import { VISION_ENDPOINT } from "../ocr/google-vision/provider.ts";
import { LANGUAGES_V2_ENDPOINT } from "../translation/google-v2/provider.ts";
import {
	callGoogle,
	type FetchLike,
	type GoogleApi,
	GoogleError,
	type GoogleProblem,
	googleProblemCopy,
} from "./common.ts";

export type GoogleKeyCheck =
	| { readonly api: GoogleApi; readonly ok: true }
	| { readonly api: GoogleApi; readonly ok: false; readonly problem: GoogleProblem; readonly message: string };

export interface GoogleKeyTest {
	/** Every API accepted the key. */
	readonly ok: boolean;
	readonly checks: readonly GoogleKeyCheck[];
}

const PROVIDER_ID = "cloud:google-key-test";

async function check(api: GoogleApi, run: () => Promise<unknown>, acceptBadRequest: boolean): Promise<GoogleKeyCheck> {
	try {
		await run();
		return { api, ok: true };
	} catch (error) {
		if (error instanceof GoogleError) {
			if (acceptBadRequest && error.problem === "bad-request") return { api, ok: true };
			return { api, ok: false, problem: error.problem, message: error.userMessage };
		}
		if (isProviderError(error, "cancelled")) throw error;
		return { api, ok: false, problem: "server", message: googleProblemCopy("server", api) };
	}
}

/** Check a key against Cloud Translation and Cloud Vision, in parallel. Never logs the key. */
export async function testGoogleKey(
	key: string,
	options: { readonly fetch?: FetchLike; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<GoogleKeyTest> {
	const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
	const common = {
		providerId: PROVIDER_ID,
		fetch: fetchImpl,
		key,
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? 10_000,
	};
	const checks = await Promise.all([
		check(
			"translate",
			() => callGoogle({ ...common, api: "translate", url: LANGUAGES_V2_ENDPOINT, method: "GET" }),
			false,
		),
		check("vision", () => callGoogle({ ...common, api: "vision", url: VISION_ENDPOINT, body: { requests: [] } }), true),
	]);
	return { ok: checks.every((c) => c.ok), checks };
}
