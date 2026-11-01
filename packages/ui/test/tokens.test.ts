import { describe, expect, test } from "bun:test";
import { renderTokens, tokensCssPath } from "../scripts/generate-tokens.ts";
import { generateTokensCss, parseDesignFrontmatter, pxToRem, splitHexAlpha } from "../scripts/tokens.ts";

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
	const css = generateTokensCss(design, [
		{ name: "duration-fast", value: "100ms" },
		{ name: "ease-out", value: "cubic-bezier(0.16, 1, 0.3, 1)" },
		{ name: "spring-dock", value: "{}" },
	]);

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
