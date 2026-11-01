import { describe, expect, test } from "bun:test";
import { countScripts, dominantScript } from "../src/index.ts";

describe("script counting", () => {
	test("letters only, marks join their base letter's script", () => {
		const c = countScripts("Größe: 12 MB!");
		expect(c.total).toBe(7);
		expect(c.counts.get("Latn")).toBe(7);
		const hi = countScripts("सेटिंग्स");
		expect(hi.counts.get("Deva")).toBe(hi.total);
	});

	test("kana + Han fold into Jpan, Hangul + Han into Kore, Han alone stays Hani", () => {
		expect(dominantScript("設定を保存しました")?.script).toBe("Jpan");
		expect(dominantScript("請輸入密碼")?.script).toBe("Hani");
		expect(dominantScript("大韓民國 만세")?.script).toBe("Kore");
		expect(dominantScript("설정이 저장되었습니다")?.script).toBe("Hang");
	});

	test("dominant script and share; null without letters", () => {
		const d = dominantScript("Привет, world");
		expect(d?.script).toBe("Cyrl");
		expect(d?.share).toBeCloseTo(6 / 11, 5);
		expect(dominantScript("12:30 — 100%")).toBeNull();
		expect(dominantScript("مرحبا")?.script).toBe("Arab");
	});
});
