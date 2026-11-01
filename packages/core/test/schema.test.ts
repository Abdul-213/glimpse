import { describe, expect, test } from "bun:test";
import {
	array,
	boolean,
	formatIssue,
	json,
	languageCode,
	languageCodeSchema,
	nullable,
	number,
	object,
	oneOf,
	parseOrDefault,
	record,
	refine,
	string,
	validate,
	withDefault,
} from "../src/index.ts";

const Live = object({
	fps: withDefault(number({ min: 1, max: 10 }), 3),
	paused: withDefault(boolean(), false),
	mode: withDefault(oneOf(["a", "b"] as const), "a"),
});
const Root = object({
	live: Live,
	langs: withDefault(array(languageCodeSchema(), { uniqueBy: (c) => c }), []),
	name: withDefault(nullable(string({ maxLength: 5 })), null),
});

describe("schema", () => {
	test("missing everything gives the defaults with no issues", () => {
		const { value, issues } = parseOrDefault(Root, undefined);
		expect(value).toEqual({ live: { fps: 3, paused: false, mode: "a" }, langs: [], name: null });
		expect(issues).toEqual([]);
	});

	test("bad fields are reset one by one and reported with paths", () => {
		const { value, issues } = parseOrDefault(Root, {
			live: { fps: 99, paused: "yes", mode: "b", extra: 1 },
			langs: ["JA", "ja", "not a tag", 4, "zh-hant"],
			name: "toolong",
		});
		expect(value).toEqual({
			live: { fps: 3, paused: false, mode: "b" },
			langs: [languageCode("ja"), languageCode("zh-Hant")],
			name: null,
		});
		expect(issues.map(formatIssue)).toEqual([
			"live.fps: 99 is above the maximum 10; using the default",
			'live.paused: expected true or false, got "yes"; using the default',
			"langs[1]: duplicate; removed",
			'langs[2]: not a language code: "not a tag"; removed',
			"langs[3]: not a language code: number; removed",
			"name: longer than 5; using the default",
		]);
	});

	test("a non-object section is reported and defaulted", () => {
		const { value, issues } = parseOrDefault(Root, { live: "fast" });
		expect(value.live.fps).toBe(3);
		expect(issues.map(formatIssue)).toEqual(['live: expected an object, got "fast"']);
	});

	test("strict validate fails without defaults", () => {
		const S = object({ n: number({ integer: true }) });
		expect(validate(S, { n: 1.5 }).result).toEqual({ ok: false, message: "n: expected a whole number, got 1.5" });
		expect(() => parseOrDefault(S, {})).toThrow(TypeError);
	});

	test("refine, record and json", () => {
		const Even = refine(number(), (n) => (n % 2 === 0 ? null : "must be even"));
		expect(validate(Even, 3).result.ok).toBe(false);
		const R = record(Even);
		const { result, issues } = validate(R, { a: 2, b: 3 });
		expect(result).toEqual({ ok: true, value: { a: 2 } });
		expect(issues).toHaveLength(1);
		const cyclic: Record<string, unknown> = {};
		cyclic["self"] = cyclic;
		expect(validate(json(), cyclic).result.ok).toBe(false);
		expect(validate(json(), { a: [1, "x", null, { b: true }] }).result).toEqual({
			ok: true,
			value: { a: [1, "x", null, { b: true }] },
		});
		expect(validate(json(), Number.NaN).result.ok).toBe(false);
	});
});
