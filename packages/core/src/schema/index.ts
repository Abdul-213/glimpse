// A tiny validation kit for configuration: settings (GLIM-53) and provider options
// (GLIM-43). Hand-written instead of a dependency (zod, valibot) because what config
// needs is unusual: **repair, don't reject**. A settings file with one bad value must
// still load, with that one field reset to its default and a warning recorded, so a typo
// in a hand-edited file never wipes the user's other choices. `withDefault` does exactly
// that and records an `Issue`; libraries can do fallbacks, but they drop the reason or
// fail the whole parse. It is ~200 lines, has no runtime deps, and keeps core
// dependency-free.
//
//   const S = object({ fps: withDefault(number({ min: 1, max: 10 }), 3) });
//   parseOrDefault(S, { fps: 99 })  // { value: { fps: 3 }, issues: [{ path: "fps", message: ... }] }

import { type LanguageCode, parseLanguageCode } from "../language.ts";

export interface Issue {
	/** Dotted path to the value, e.g. `live.fps`, `language.sources[2]`. Empty for the root. */
	readonly path: string;
	readonly message: string;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface ParseContext {
	readonly path: string;
	/** Repairs made below this point (defaults substituted, items dropped). */
	readonly issues: Issue[];
}

export interface Schema<T> {
	/** Fails when the value can't be used. Repairs inside it are pushed to `ctx.issues`. */
	parse(input: unknown, ctx: ParseContext): Parsed<T>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

/** JSON-compatible values, for options we store but don't understand. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (message: string): Parsed<never> => ({ ok: false, message });
const describe = (v: unknown): string =>
	v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" ? JSON.stringify(v).slice(0, 40) : typeof v;
export const childPath = (path: string, key: string | number): string =>
	typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
const child = (ctx: ParseContext, key: string | number): ParseContext => ({
	path: childPath(ctx.path, key),
	issues: ctx.issues,
});

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const string = (opts: { minLength?: number; maxLength?: number; pattern?: RegExp } = {}): Schema<string> => ({
	parse(input) {
		if (typeof input !== "string") return fail(`expected a string, got ${describe(input)}`);
		if (opts.minLength !== undefined && input.length < opts.minLength) return fail(`shorter than ${opts.minLength}`);
		if (opts.maxLength !== undefined && input.length > opts.maxLength) return fail(`longer than ${opts.maxLength}`);
		if (opts.pattern && !opts.pattern.test(input)) return fail(`does not match ${opts.pattern}`);
		return ok(input);
	},
});

export const boolean = (): Schema<boolean> => ({
	parse: (input) => (typeof input === "boolean" ? ok(input) : fail(`expected true or false, got ${describe(input)}`)),
});

export const number = (opts: { min?: number; max?: number; integer?: boolean } = {}): Schema<number> => ({
	parse(input) {
		if (typeof input !== "number" || !Number.isFinite(input)) return fail(`expected a number, got ${describe(input)}`);
		if (opts.integer && !Number.isInteger(input)) return fail(`expected a whole number, got ${input}`);
		if (opts.min !== undefined && input < opts.min) return fail(`${input} is below the minimum ${opts.min}`);
		if (opts.max !== undefined && input > opts.max) return fail(`${input} is above the maximum ${opts.max}`);
		return ok(input);
	},
});

export const oneOf = <const T extends readonly (string | number | boolean | null)[]>(values: T): Schema<T[number]> => ({
	parse: (input) =>
		values.includes(input as T[number])
			? ok(input as T[number])
			: fail(`expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}, got ${describe(input)}`),
});

/** A canonical BCP-47 tag; input is canonicalised (`EN` -> `en`). */
export const languageCodeSchema = (): Schema<LanguageCode> => ({
	parse(input) {
		const code = typeof input === "string" ? parseLanguageCode(input) : null;
		return code ? ok(code) : fail(`not a language code: ${describe(input)}`);
	},
});

export const nullable = <T>(schema: Schema<T>): Schema<T | null> => ({
	parse: (input, ctx) => (input === null ? ok(null) : schema.parse(input, ctx)),
});

/** Extra check on a parsed value; return an error message or null. */
export const refine = <T>(schema: Schema<T>, test: (value: T) => string | null): Schema<T> => ({
	parse(input, ctx) {
		const r = schema.parse(input, ctx);
		if (!r.ok) return r;
		const message = test(r.value);
		return message === null ? r : fail(message);
	},
});

export const map = <A, B>(schema: Schema<A>, fn: (value: A) => B): Schema<B> => ({
	parse(input, ctx) {
		const r = schema.parse(input, ctx);
		return r.ok ? ok(fn(r.value)) : r;
	},
});

export interface ArrayOptions<T> {
	readonly maxLength?: number;
	/** `drop` (default): an invalid item is removed and recorded. `fail`: the array fails. */
	readonly invalidItems?: "drop" | "fail";
	/** Remove duplicates (by this key), keeping the first, and record it. */
	readonly uniqueBy?: (item: T) => unknown;
}

export const array = <T>(item: Schema<T>, opts: ArrayOptions<T> = {}): Schema<readonly T[]> => ({
	parse(input, ctx) {
		if (!Array.isArray(input)) return fail(`expected a list, got ${describe(input)}`);
		if (opts.maxLength !== undefined && input.length > opts.maxLength) {
			return fail(`more than ${opts.maxLength} items`);
		}
		const out: T[] = [];
		const seen = new Set<unknown>();
		for (const [i, raw] of input.entries()) {
			const r = item.parse(raw, child(ctx, i));
			if (!r.ok) {
				if (opts.invalidItems === "fail") return fail(`item ${i}: ${r.message}`);
				ctx.issues.push({ path: childPath(ctx.path, i), message: `${r.message}; removed` });
				continue;
			}
			if (opts.uniqueBy) {
				const key = opts.uniqueBy(r.value);
				if (seen.has(key)) {
					ctx.issues.push({ path: childPath(ctx.path, i), message: "duplicate; removed" });
					continue;
				}
				seen.add(key);
			}
			out.push(r.value);
		}
		return ok(out);
	},
});

type Shape = Record<string, Schema<unknown>>;
export type ObjectOf<S extends Shape> = { readonly [K in keyof S]: Infer<S[K]> };

/**
 * An object with known fields. Unknown keys are dropped. A missing object (`undefined`)
 * is parsed as `{}`, so an object whose fields all have defaults defaults as a whole; a
 * non-object is recorded and treated the same way.
 */
export const object = <S extends Shape>(shape: S): Schema<ObjectOf<S>> => ({
	parse(input, ctx) {
		let source: Record<string, unknown> = {};
		if (isPlainObject(input)) source = input;
		else if (input !== undefined)
			ctx.issues.push({ path: ctx.path, message: `expected an object, got ${describe(input)}` });
		const out: Record<string, unknown> = {};
		for (const [key, schema] of Object.entries(shape)) {
			const r = schema.parse(source[key], child(ctx, key));
			if (!r.ok) return fail(`${childPath(ctx.path, key) || key}: ${r.message}`);
			out[key] = r.value;
		}
		return ok(out as ObjectOf<S>);
	},
});

/** A string-keyed map; invalid entries are dropped and recorded. */
export const record = <T>(value: Schema<T>, key: Schema<string> = string()): Schema<Readonly<Record<string, T>>> => ({
	parse(input, ctx) {
		if (!isPlainObject(input)) return fail(`expected an object, got ${describe(input)}`);
		const out: Record<string, T> = {};
		for (const [k, raw] of Object.entries(input)) {
			const kr = key.parse(k, ctx);
			const vr = kr.ok ? value.parse(raw, child(ctx, k)) : kr;
			if (!vr.ok) {
				ctx.issues.push({ path: childPath(ctx.path, k), message: `${vr.message}; removed` });
				continue;
			}
			out[k] = vr.value;
		}
		return ok(out);
	},
});

/** Any JSON value, deep-copied. Rejects functions, `undefined`, non-finite numbers, cycles. */
export const json = (): Schema<JsonValue> => ({
	parse(input) {
		const seen = new Set<object>();
		const copy = (v: unknown): JsonValue => {
			if (v === null || typeof v === "boolean" || typeof v === "string") return v;
			if (typeof v === "number") {
				if (!Number.isFinite(v)) throw new Error("non-finite number");
				return v;
			}
			if (typeof v !== "object") throw new Error(`not JSON: ${typeof v}`);
			if (seen.has(v)) throw new Error("cycle");
			seen.add(v);
			const out = Array.isArray(v)
				? v.map(copy)
				: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, copy(x)]));
			seen.delete(v);
			return out;
		};
		try {
			return ok(copy(input));
		} catch (error) {
			return fail(error instanceof Error ? error.message : "not JSON");
		}
	},
});

export const jsonObject = (): Schema<JsonObject> =>
	refine(json(), (v) => (isPlainObject(v) ? null : `expected an object, got ${describe(v)}`)) as Schema<JsonObject>;

/**
 * Never fails: a missing value silently becomes `fallback` (new fields appear with their
 * defaults); an invalid value becomes `fallback` and is recorded as an issue.
 */
export const withDefault = <T>(schema: Schema<T>, fallback: T | (() => T)): Schema<T> => {
	const value = (): T => (typeof fallback === "function" ? (fallback as () => T)() : fallback);
	return {
		parse(input, ctx) {
			if (input === undefined) {
				// Parse "nothing" so nested objects can fill their own defaults; fall back if they can't.
				const nested = schema.parse(undefined, { path: ctx.path, issues: [] });
				return ok(nested.ok ? nested.value : value());
			}
			const r = schema.parse(input, ctx);
			if (r.ok) return r;
			ctx.issues.push({ path: ctx.path, message: `${r.message}; using the default` });
			return ok(value());
		},
	};
};

/** Strict parse at the root: the value, or a failure, plus repairs made on the way. */
export function validate<T>(schema: Schema<T>, input: unknown): { result: Parsed<T>; issues: Issue[] } {
	const issues: Issue[] = [];
	return { result: schema.parse(input, { path: "", issues }), issues };
}

/** Parse with a schema that can always produce a value (all fields defaulted). */
export function parseOrDefault<T>(schema: Schema<T>, input: unknown): { value: T; issues: Issue[] } {
	const { result, issues } = validate(schema, input);
	if (!result.ok) throw new TypeError(`schema has no default for: ${result.message}`);
	return { value: result.value, issues };
}

export const formatIssue = (issue: Issue): string => (issue.path ? `${issue.path}: ${issue.message}` : issue.message);
