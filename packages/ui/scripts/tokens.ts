// Turns DESIGN.md's YAML frontmatter (and the motion, shadow and per-script typography
// values in .impeccable/design.json) into Tailwind v4 theme CSS, following DESIGN.md
// "Token mapping". Pure: takes the parsed data, returns the CSS text.
// `generate-tokens.ts` does the file I/O.

export interface TypographyToken {
	fontFamily: string;
	fontSize: string;
	fontWeight: number;
	lineHeight: number;
	letterSpacing?: string;
	fontFeature?: string;
}

export interface DesignFrontmatter {
	colors: Record<string, string>;
	typography: Record<string, TypographyToken>;
	rounded: Record<string, string>;
	spacing: Record<string, string>;
}

export interface MotionToken {
	name: string;
	value: string;
}

export interface ShadowToken {
	name: string;
	value: string;
	/** Dark-appearance value with the same shape; colours are paired with light-dark(). */
	dark?: string;
}

export interface ScriptTypography {
	lang: string;
	/** `:root` for the base stack, else a `:lang()` list. */
	selector: string;
	fontFamily: string;
	sizeScale: number;
	lineHeight: { translation: number; source: number; body: number };
	css?: string;
}

/** The parts of `.impeccable/design.json` → `extensions` the generator reads. */
export interface SidecarExtensions {
	motion?: MotionToken[];
	shadows?: ShadowToken[];
	scriptTypography?: ScriptTypography[];
}

const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b/g;

/**
 * Pair a light and a dark box-shadow of the same shape into one value whose colours are
 * `light-dark()`, so a shadow follows the element's color-scheme like every colour token.
 * Throws if the two differ in anything but colour.
 */
export function mergeShadow(light: string, dark?: string): string {
	if (!dark) return light;
	const lightColors = light.match(HEX) ?? [];
	const darkColors = dark.match(HEX) ?? [];
	if (light.replace(HEX, "#") !== dark.replace(HEX, "#") || lightColors.length !== darkColors.length) {
		throw new Error(`shadow light/dark values differ in shape: "${light}" vs "${dark}"`);
	}
	let i = 0;
	return light.replace(HEX, (c) => {
		const d = darkColors[i++] ?? c;
		return c === d ? c : `light-dark(${c}, ${d})`;
	});
}

/**
 * Per-script stacks and leading (DESIGN.md Typography > Script stacks). Every element with
 * a `lang` attribute resets to the base stack, then `:lang()` picks the script's stack, so a
 * Latin block inside a Japanese popup doesn't inherit the CJK leading. Zero specificity
 * (`:where`) so utilities still win. Components read `--script-scale` and `--leading-<role>`.
 */
function scriptRules(scripts: ScriptTypography[]): string[] {
	const out: string[] = [];
	const decls = (s: ScriptTypography, indent: string) => {
		const lines = [
			`font-family: ${s.fontFamily};`,
			`--script-scale: ${s.sizeScale};`,
			`--leading-translation: ${s.lineHeight.translation};`,
			`--leading-source: ${s.lineHeight.source};`,
			`--leading-body: ${s.lineHeight.body};`,
		];
		for (const extra of (s.css ?? "").split(";")) {
			const d = extra.trim();
			if (d) lines.push(`${d};`);
		}
		return lines.map((l) => `${indent}${l}`);
	};
	out.push("/* Per-script stacks and leading (DESIGN.md Typography; .impeccable/design.json scriptTypography). */");
	out.push("@layer base {");
	const base = scripts.find((s) => s.selector === ":root");
	if (base) {
		out.push("\t:where(:root, [lang]) {");
		out.push(...decls(base, "\t\t"));
		out.push("\t}");
	}
	for (const s of scripts) {
		if (s === base) continue;
		const selector = s.selector
			.split(",")
			.map((part) => part.trim())
			.join(", ");
		out.push(`\t:where(${selector}) {`);
		out.push(...decls(s, "\t\t"));
		out.push("\t}");
	}
	out.push("}");
	return out;
}

/** Colour tokens whose value follows the OS accent the shell injects as --os-accent(-dark). */
const ACCENT_DERIVED = new Set([
	"accent",
	"focus-ring",
	"change-flash",
	"change-rest",
	"change-mark",
	"overlay-selected",
	"box-linked-fill",
]);

/**
 * Radii with a Windows variant (`<key>-win`), swapped in by `:root[data-os="windows"]`, and
 * optionally a Windows 10 one (`<key>-win10`), swapped in by `[data-os-version="10"]`.
 */
const PLATFORM_RADII = ["control", "popup"];

/** Extract and parse the `---` YAML frontmatter at the top of DESIGN.md. */
export function parseDesignFrontmatter(markdown: string): DesignFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
	if (!match?.[1]) throw new Error("DESIGN.md has no YAML frontmatter");
	const data = Bun.YAML.parse(match[1]) as Partial<DesignFrontmatter> | null;
	for (const key of ["colors", "typography", "rounded", "spacing"] as const) {
		if (!data?.[key] || typeof data[key] !== "object") {
			throw new Error(`DESIGN.md frontmatter is missing "${key}"`);
		}
	}
	return data as DesignFrontmatter;
}

/** `16px` -> `1rem`. Leaves non-px values (and `0px`) readable. */
export function pxToRem(value: string): string {
	const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
	if (!m?.[1]) return value;
	const px = Number(m[1]);
	if (px === 0) return "0";
	return `${Number((px / 16).toFixed(4))}rem`;
}

/** `#RRGGBBAA` -> { base: `#RRGGBB`, alpha: 0..1 }. Opaque for 6-digit hex. */
export function splitHexAlpha(hex: string): { base: string; alpha: number } {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
	if (!m?.[1]) throw new Error(`expected #RRGGBB or #RRGGBBAA, got ${hex}`);
	const alpha = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
	return { base: `#${m[1]}`, alpha };
}

function accentValue(hex: string, accentVar: string): string {
	const { base, alpha } = splitHexAlpha(hex);
	const accent = `var(${accentVar}, ${base})`;
	if (alpha === 1) return accent;
	const pct = Number((alpha * 100).toFixed(1));
	return `color-mix(in oklab, ${accent} ${pct}%, transparent)`;
}

interface ColorPair {
	key: string;
	light: string;
	dark: string;
}

function colorPairs(colors: Record<string, string>): ColorPair[] {
	const pairs: ColorPair[] = [];
	for (const [key, light] of Object.entries(colors)) {
		if (key.endsWith("-dark")) continue;
		const darkHex = colors[`${key}-dark`] ?? light;
		if (ACCENT_DERIVED.has(key)) {
			pairs.push({
				key,
				light: accentValue(light, "--os-accent"),
				dark: accentValue(darkHex, "--os-accent-dark"),
			});
		} else {
			pairs.push({ key, light, dark: darkHex });
		}
	}
	return pairs;
}

const lightDark = (p: ColorPair): string => (p.light === p.dark ? p.light : `light-dark(${p.light}, ${p.dark})`);

/** Build the full tokens.css text. Output is deterministic so CI can diff it. */
export function generateTokensCss(design: DesignFrontmatter, sidecar: SidecarExtensions = {}): string {
	const motion = sidecar.motion ?? [];
	const shadows = sidecar.shadows ?? [];
	const out: string[] = [];
	const line = (s = "") => out.push(s);

	line("/*");
	line(" * GENERATED from DESIGN.md frontmatter and .impeccable/design.json (motion).");
	line(" * Do not edit. Run `bun run tokens` after changing DESIGN.md; CI fails if this is stale.");
	line(" */");
	line();
	line("@theme static {");

	const pairs = colorPairs(design.colors);
	line("\t/* Colours: one property per light/dark pair (DESIGN.md Token mapping). */");
	line("\t--color-*: initial;");
	// Translucent accent-derived colours (color-mix over var(--os-accent)) can't be declared
	// here: Tailwind's color-mix polyfill rewrites theme values to the opaque accent and only
	// keeps the real value (in an @supports block) for tokens some utility uses, and it drops
	// it entirely inside light-dark(). So the theme aliases them to --mix-<key>, set in plain
	// :root rules below (light, then a dark-scheme override), which it polyfills correctly.
	const mixed = pairs.filter((p) => p.light.includes("color-mix") || p.dark.includes("color-mix"));
	for (const p of pairs) line(`\t--color-${p.key}: ${mixed.includes(p) ? `var(--mix-${p.key})` : lightDark(p)};`);
	line();

	const body = design.typography["body"];
	const title = design.typography["title"];
	line("\t/* Typography */");
	line("\t--font-*: initial;");
	if (body) line(`\t--font-ui: ${body.fontFamily};`);
	if (title) line(`\t--font-display: ${title.fontFamily};`);
	line("\t--text-*: initial;");
	for (const [role, t] of Object.entries(design.typography)) {
		line(`\t--text-${role}: ${pxToRem(t.fontSize)};`);
		line(`\t--text-${role}--line-height: ${t.lineHeight};`);
		line(`\t--text-${role}--font-weight: ${t.fontWeight};`);
	}
	line();

	line("\t/* Spacing: one 4px base; utilities multiply it (p-3 = 12px). */");
	line("\t--spacing: 0.25rem;");
	line();

	line("\t/* Radii */");
	line("\t--radius-*: initial;");
	for (const [key, value] of Object.entries(design.rounded)) line(`\t--radius-${key}: ${pxToRem(value)};`);

	if (shadows.length > 0) {
		line();
		line("\t/* Shadows (DESIGN.md Shadow Vocabulary): colours follow light/dark. */");
		line("\t--shadow-*: initial;");
		for (const s of shadows) line(`\t--shadow-${s.name}: ${mergeShadow(s.value, s.dark)};`);
	}

	const easing = motion.filter((m) => m.name.startsWith("ease-") && /^(cubic-bezier\(.*\)|linear)$/.test(m.value));
	if (easing.length > 0) {
		line();
		line("\t/* Easing */");
		line("\t--ease-*: initial;");
		for (const m of easing) line(`\t--${m.name}: ${m.value};`);
	}
	line("}");
	line();

	line(":root {");
	line("\tcolor-scheme: light dark;");
	const durations = motion.filter((m) => m.name.startsWith("duration-") && /^\d+ms$/.test(m.value));
	for (const m of durations) line(`\t--${m.name}: ${m.value};`);
	line("}");
	line();

	if (mixed.length > 0) {
		// One rule per property: the build's color-mix lowering keeps the real value (in its
		// @supports override) for only the first declaration of a rule.
		line("/* Translucent accent-derived colours (see the note in @theme). One rule each, on purpose. */");
		for (const p of mixed) line(`:root { --mix-${p.key}: ${p.light}; }`);
		line();
		line("@media (prefers-color-scheme: dark) {");
		for (const p of mixed) line(`\t:root { --mix-${p.key}: ${p.dark}; }`);
		line("}");
		line();
	}

	const platform = PLATFORM_RADII.filter((k) => design.rounded[`${k}-win`]);
	if (platform.length > 0) {
		line("/* Windows radii: the shell sets data-os on <html>. */");
		line(':root[data-os="windows"] {');
		for (const k of platform) line(`\t--radius-${k}: var(--radius-${k}-win);`);
		line("}");
		line();
	}

	const win10 = PLATFORM_RADII.filter((k) => design.rounded[`${k}-win10`]);
	if (win10.length > 0) {
		line("/* Windows 10: DWM does not round windows, so popups are square (DESIGN.md Shapes). */");
		line(':root[data-os="windows"][data-os-version="10"] {');
		for (const k of win10) line(`\t--radius-${k}: var(--radius-${k}-win10);`);
		line("}");
		line();
	}

	const themed = pairs.filter((p) => p.light !== p.dark && !mixed.includes(p));
	line("/* Fallback for webviews without light-dark() (WKWebView before Safari 17.5). */");
	line("@supports not (color: light-dark(#000, #fff)) {");
	line("\t:root {");
	for (const p of themed) line(`\t\t--color-${p.key}: ${p.light};`);
	line("\t}");
	line("\t@media (prefers-color-scheme: dark) {");
	line("\t\t:root {");
	for (const p of themed) line(`\t\t\t--color-${p.key}: ${p.dark};`);
	line("\t\t}");
	line("\t}");
	line("}");

	if (sidecar.scriptTypography && sidecar.scriptTypography.length > 0) {
		line();
		for (const l of scriptRules(sidecar.scriptTypography)) line(l);
	}

	return `${out.join("\n")}\n`;
}
