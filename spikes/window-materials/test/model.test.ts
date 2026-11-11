import { describe, expect, test } from "bun:test";
import {
	accentPolicy,
	compositionAttribData,
	decideSurface,
	materialSupported,
	parseHex,
	popupRadius,
	stats,
	TOKENS,
	windowsCaps,
	withAlpha,
	worstCaseContrast,
} from "../src/shared/model";

describe("windowsCaps", () => {
	test("Windows 10 22H2 has no DWM materials or corners", () => {
		const c = windowsCaps(19045);
		expect(c).toMatchObject({ isWin11: false, systemBackdrop: false, legacyMica: false, cornerPreference: false, accentAcrylic: true });
	});
	test("Windows 11 21H2 has corners and only the undocumented Mica attribute", () => {
		expect(windowsCaps(22000)).toMatchObject({ isWin11: true, systemBackdrop: false, legacyMica: true, cornerPreference: true });
	});
	test("Windows 11 22H2+ has DWMWA_SYSTEMBACKDROP_TYPE", () => {
		expect(windowsCaps(22621)).toMatchObject({ systemBackdrop: true, legacyMica: false });
		expect(windowsCaps(26100).systemBackdrop).toBe(true);
	});
});

describe("materialSupported", () => {
	test("Acrylic needs 22621; Mica also works on 22000", () => {
		expect(materialSupported("windows", "acrylic", { winBuild: 22000 })).toBe(false);
		expect(materialSupported("windows", "mica", { winBuild: 22000 })).toBe(true);
		expect(materialSupported("windows", "acrylic", { winBuild: 22631 })).toBe(true);
		expect(materialSupported("windows", "accent-acrylic", { winBuild: 19045 })).toBe(true);
	});
	test("macOS glass only when NSGlassEffectView exists", () => {
		expect(materialSupported("macos", "glass", { macGlass: false })).toBe(false);
		expect(materialSupported("macos", "glass", { macGlass: true })).toBe(true);
		expect(materialSupported("macos", "popover")).toBe(true);
	});
});

describe("decideSurface", () => {
	const base = { os: "macos" as const, material: "popover", supported: true, osReduceTransparency: false, rtMode: "auto" as const };
	test("default: material + tint veil", () => {
		expect(decideSurface(base)).toMatchObject({ nativeMaterial: true, veil: "tint" });
	});
	test("OS reduce transparency -> solid, no material", () => {
		expect(decideSurface({ ...base, osReduceTransparency: true })).toMatchObject({ nativeMaterial: false, veil: "solid" });
	});
	test("simulation forces solid even when the OS is off", () => {
		expect(decideSurface({ ...base, rtMode: "on" })).toMatchObject({ nativeMaterial: false, veil: "solid" });
	});
	test("'off' ignores the OS setting", () => {
		expect(decideSurface({ ...base, rtMode: "off", osReduceTransparency: true }).nativeMaterial).toBe(true);
	});
	test("unsupported material (Windows 10) falls back to solid", () => {
		expect(decideSurface({ ...base, os: "windows", material: "acrylic", supported: false })).toMatchObject({
			nativeMaterial: false,
			veil: "solid",
		});
	});
});

describe("popupRadius", () => {
	test("12 macOS, 8 Windows 11, square Windows 10", () => {
		expect(popupRadius("macos")).toBe(12);
		expect(popupRadius("windows", 22631)).toBe(8);
		expect(popupRadius("windows", 19045)).toBe(0);
	});
});

describe("Win32 struct layouts", () => {
	test("ACCENT_POLICY is 16 bytes with AABBGGRR gradient", () => {
		const b = accentPolicy(4, { r: 0x11, g: 0x22, b: 0x33, a: 0x44 });
		const v = new DataView(b.buffer);
		expect(b.byteLength).toBe(16);
		expect(v.getInt32(0, true)).toBe(4);
		expect(v.getUint32(8, true)).toBe(0x44332211);
	});
	test("WINDOWCOMPOSITIONATTRIBDATA is 24 bytes on x64 with the pointer at offset 8", () => {
		const b = compositionAttribData(19, 0x1234_5678_9a, 16);
		const v = new DataView(b.buffer);
		expect(b.byteLength).toBe(24);
		expect(v.getUint32(0, true)).toBe(19);
		expect(v.getBigUint64(8, true)).toBe(0x1234_5678_9an);
		expect(v.getBigUint64(16, true)).toBe(16n);
	});
});

describe("DESIGN.md veil legibility (text over the veil over pure white / pure black)", () => {
	for (const mode of ["light", "dark"] as const) {
		const t = TOKENS[mode];
		test(`${mode}: primary and secondary text pass 4.5:1 at 90%`, () => {
			expect(worstCaseContrast(t.textPrimary, t.surfacePopup)).toBeGreaterThan(4.5);
			expect(worstCaseContrast(t.textSecondary, t.surfacePopup)).toBeGreaterThan(4.5);
		});
	}
	test("surface-popup tokens really are 90% (0xE6)", () => {
		expect(parseHex(TOKENS.light.surfacePopup).a).toBeCloseTo(0.9, 2);
		expect(parseHex(TOKENS.dark.surfacePopup).a).toBeCloseTo(0.9, 2);
	});
	test("withAlpha", () => {
		expect(withAlpha("#F5F5F7E6", 0.8)).toBe("#F5F5F7CC");
	});
});

describe("stats", () => {
	test("percentiles and under-100 count", () => {
		const s = stats([10, 20, 30, 40, 200, Number.NaN])!;
		expect(s).toMatchObject({ n: 5, min: 10, p50: 30, max: 200, under100: 4 });
	});
	test("empty", () => {
		expect(stats([])).toBeNull();
	});
});
