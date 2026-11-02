// Versioned settings migrations. Each migration lifts raw JSON from version N to N+1;
// they run in order until the file reaches SETTINGS_VERSION, then the lenient schema
// fills anything still missing. Migrations work on plain JSON (not `Settings`), because
// an old file's shape is by definition not the current type.
//
// Rules: never delete a migration; make each one total (accept any JSON object, since
// the file may be hand-edited); keep them pure. Tests cover each step with a fixture.

import { isPlainObject, type JsonObject } from "../schema/index.ts";

export interface Migration {
	/** Lifts a version-`from` file to version `from + 1`. */
	readonly from: number;
	readonly description: string;
	migrate(input: JsonObject): JsonObject;
}

// Literal ids rather than PROVIDER_IDS: a migration must keep meaning what it meant when it
// shipped, even if the registry changes later. Cloud ids are `cloud:<name>` (provenance.ts).
const BERGAMOT = "bergamot";
const SMALL100 = "small100";
const CLOUD_PREFIX = "cloud:";

/**
 * GLIM-139 (1 -> 2): add SMaLL-100 to translation chains saved before it existed.
 *
 * The providers section is stored whole, so a file written before GLIM-100 keeps
 * `translation: ["bergamot"]` and never gets the long-tail model. When the chain has
 * bergamot and no small100, small100 goes right after the last local translator: never
 * ahead of a cloud provider the user put first, and never after a cloud one (the registry
 * would drop a local-after-cloud entry anyway). Runs once: a user who removes small100
 * afterwards has a version-2 file and is left alone.
 */
export const addSmall100ToTranslationChain: Migration = {
	from: 1,
	description: "add small100 after the last local translator in chains that have bergamot",
	migrate(input) {
		const providers = input["providers"];
		if (!isPlainObject(providers)) return input;
		const chain = (providers as JsonObject)["translation"];
		if (!Array.isArray(chain) || !chain.includes(BERGAMOT) || chain.includes(SMALL100)) return input;
		let lastLocal = -1;
		chain.forEach((id, i) => {
			if (typeof id === "string" && !id.startsWith(CLOUD_PREFIX)) lastLocal = i;
		});
		const translation = [...chain.slice(0, lastLocal + 1), SMALL100, ...chain.slice(lastLocal + 1)];
		return { ...input, providers: { ...(providers as JsonObject), translation } };
	},
};

/** Shipped migrations, in order. Version 1 is the first released shape. */
export const SETTINGS_MIGRATIONS: readonly Migration[] = [addSmall100ToTranslationChain];

export type VersionInfo =
	| { readonly kind: "current" }
	| { readonly kind: "older"; readonly version: number }
	| { readonly kind: "newer"; readonly version: number };

/**
 * The version a file claims. No `version` (or a nonsense one) is treated as 1, the first
 * shape: a hand-written file without it still loads.
 */
export function fileVersion(input: JsonObject): number {
	const v = input["version"];
	return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
}

export function classifyVersion(version: number, current: number): VersionInfo {
	if (version === current) return { kind: "current" };
	return version < current ? { kind: "older", version } : { kind: "newer", version };
}

export class MigrationError extends Error {
	override name = "MigrationError";
}

/**
 * Run migrations from the file's version up to `target`. Returns the migrated JSON (with
 * `version: target`) and the versions it passed through. Throws `MigrationError` when a
 * step is missing or a migration throws or returns a non-object.
 */
export function runMigrations(
	input: JsonObject,
	migrations: readonly Migration[],
	target: number,
): { data: JsonObject; from: number; applied: number[] } {
	const from = fileVersion(input);
	let data = input;
	const applied: number[] = [];
	for (let v = from; v < target; v++) {
		const step = migrations.find((m) => m.from === v);
		if (!step) throw new MigrationError(`no settings migration from version ${v}`);
		let next: unknown;
		try {
			next = step.migrate(data);
		} catch (error) {
			throw new MigrationError(
				`settings migration ${v}→${v + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isPlainObject(next)) throw new MigrationError(`settings migration ${v}→${v + 1} returned a non-object`);
		data = { ...(next as JsonObject), version: v + 1 };
		applied.push(v);
	}
	return { data, from, applied };
}
