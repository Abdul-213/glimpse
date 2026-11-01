import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeReply } from "../../src/google/fake-fetch.ts";

export const GOOGLE_FIXTURES = join(import.meta.dir, "..", "fixtures", "google");

export const fixtureJson = (name: string): unknown => JSON.parse(readFileSync(join(GOOGLE_FIXTURES, name), "utf8"));

interface ErrorFixture {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly body: unknown;
}

const errors = fixtureJson("errors.json") as Record<string, ErrorFixture>;

export type ErrorName =
	| "key-invalid"
	| "key-invalid-v2-legacy"
	| "service-disabled"
	| "billing-disabled"
	| "key-service-blocked"
	| "referrer-blocked"
	| "rate-limited"
	| "quota-daily"
	| "quota-daily-legacy"
	| "unavailable";

export const ERROR_NAMES: readonly ErrorName[] = [
	"key-invalid",
	"key-invalid-v2-legacy",
	"service-disabled",
	"billing-disabled",
	"key-service-blocked",
	"referrer-blocked",
	"rate-limited",
	"quota-daily",
	"quota-daily-legacy",
	"unavailable",
];

/** A recorded Google error reply for the fake fetch. */
export function errorReply(name: ErrorName): FakeReply {
	const e = errors[name];
	if (!e) throw new Error(`no error fixture ${name}`);
	return { status: e.status, json: e.body, ...(e.headers ? { headers: e.headers } : {}) };
}

/** A key that looks like a Google API key (39 chars, `AIza` prefix). Not a real key. */
export const TEST_KEY = "AIzaSyD-test-key-0000000000000000000000";
