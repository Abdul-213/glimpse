import { describe, expect, test } from "bun:test";
import { renderTokens, tokensCssPath } from "../scripts/generate-tokens.ts";
import { generateTokensCss, mergeShadow, parseDesignFrontmatter, pxToRem, splitHexAlpha } from "../scripts/tokens.ts";

describe("token generation", () => {
	test("committed tokens.css matches DESIGN.md (run `bun run tokens` if this fails)", async () => {
		expect(await Bun.file(tokensCssPath).text()).toBe(await renderTokens());
	});

	test("pxToRem", () => {
		expect(pxToRem("16px")).toBe("1rem");
		expect(pxToRem("13px")).toBe("0.8125rem");
		expect(pxToRem("0px")).toBe("0");
		expect(pxToRem("normal")).toBe("normal");
	});

	test("splitHexAlpha", () => {
		expect(splitHexAlpha("#0A63C924")).toEqual({ base: "#0A63C9", alpha: 0x24 / 255 });
		expect(splitHexAlpha("#FFFFFF")).toEqual({ base: "#FFFFFF", alpha: 1 });
		expect(() => splitHexAlpha("red")).toThrow();
	});

	const design = parseDesignFrontmatter(`---
colors:
  surface: "#FFFFFF"
  surface-dark: "#000000"
  accent: "#0A63C9"
  accent-dark: "#2A6FD9"
  change-flash: "#0A63C924"
  picker-scrim: "#00000073"
typography:
  body:
    fontFamily: "system-ui"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "6px"
  control-win: "4px"
  popup: "12px"
  popup-win: "8px"
  popup-win10: "0px"
spacing:
  "1": "4px"
---
# body
`);
	const css = generateTokensCss(design, {
		motion: [
			{ name: "duration-fast", value: "100ms" },
			{ name: "ease-out", value: "cubic-bezier(0.16, 1, 0.3, 1)" },
			{ name: "spring-dock", value: "{}" },
		],
		shadows: [
			{ name: "tooltip", value: "0 2px 8px #00000026", dark: "0 2px 8px #00000066" },
			{ name: "hud", value: "0 1px 4px #0000004D" },
		],
		scriptTypography: [
			{
				lang: "default",
				selector: ":root",
				fontFamily: "system-ui",
				sizeScale: 1,
				lineHeight: { translation: 1.5, source: 1.5, body: 1.45 },
			},
			{
				lang: "ko",
				selector: ":lang(ko)",
				fontFamily: "'Malgun Gothic', sans-serif",
				sizeScale: 1,
				lineHeight: { translation: 1.7, source: 1.7, body: 1.65 },
				css: "line-break: strict; word-break: keep-all;",
			},
		],
	});

	test("translucent accent colours avoid light-dark() (Tailwind's color-mix polyfill flattens it)", () => {
		expect(css).toContain("--color-change-flash: var(--mix-change-flash);");
		expect(css).not.toContain("light-dark(color-mix");
		expect(css).toContain(
			":root { --mix-change-flash: color-mix(in oklab, var(--os-accent, #0A63C9) 14.1%, transparent); }",
		);
		expect(css).toContain(
			"@media (prefers-color-scheme: dark) {\n\t:root { --mix-change-flash: color-mix(in oklab, var(--os-accent-dark, #0A63C9) 14.1%, transparent); }",
		);
	});

	test("shadows pair their colours with light-dark()", () => {
		expect(css).toContain("--shadow-tooltip: 0 2px 8px light-dark(#00000026, #00000066);");
		expect(css).toContain("--shadow-hud: 0 1px 4px #0000004D;");
		expect(
			mergeShadow("0 8px 24px #0000002E, 0 0 0 0.5px #0000001F", "0 8px 24px #00000073, 0 0 0 0.5px #FFFFFF1F"),
		).toBe("0 8px 24px light-dark(#0000002E, #00000073), 0 0 0 0.5px light-dark(#0000001F, #FFFFFF1F)");
		expect(() => mergeShadow("0 1px 2px #000000", "0 2px 2px #000000")).toThrow();
	});

	test("script rules reset at every [lang] and pick the script's stack and leading", () => {
		expect(css).toContain(":where(:root, [lang]) {\n\t\tfont-family: system-ui;\n\t\t--script-scale: 1;");
		expect(css).toContain(":where(:lang(ko)) {");
		expect(css).toContain("--leading-translation: 1.7;");
		expect(css).toContain("word-break: keep-all;");
	});

	test("colour pairs become one light-dark() property; -dark keys are not emitted alone", () => {
		expect(css).toContain("--color-surface: light-dark(#FFFFFF, #000000);");
		expect(css).not.toContain("--color-surface-dark");
		expect(css).toContain("--color-picker-scrim: #00000073;");
	});

	test("accent tokens follow the injected OS accent", () => {
		expect(css).toContain("--color-accent: light-dark(var(--os-accent, #0A63C9), var(--os-accent-dark, #2A6FD9));");
		expect(css).toContain("color-mix(in oklab, var(--os-accent, #0A63C9) 14.1%, transparent)");
	});

	test("typography, radii, platform swap and motion", () => {
		expect(css).toContain("--text-body: 0.8125rem;");
		expect(css).toContain("--text-body--line-height: 1.45;");
		expect(css).toContain("--radius-control: 0.375rem;");
		expect(css).toContain("--radius-control: var(--radius-control-win);");
		expect(css).toContain(
			':root[data-os="windows"][data-os-version="10"] {\n\t--radius-popup: var(--radius-popup-win10);\n}',
		);
		expect(css).toContain("--duration-fast: 100ms;");
		expect(css).toContain("--ease-out: cubic-bezier(0.16, 1, 0.3, 1);");
		expect(css).not.toContain("spring-dock");
	});

	test("rejects markdown without frontmatter", () => {
		expect(() => parseDesignFrontmatter("# no frontmatter")).toThrow();
	});
});
