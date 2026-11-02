// GLIM-83: automated accessibility checks over every UI surface, headless.
//
//   bun app/scripts/a11y-check.ts [--report <file.md>] [--json <file>] [--surface <name>] [--strict]
//
// For every preview page (preview-surfaces.ts: gallery, Settings, onboarding, Snip popup,
// Live popup, picker), in headless Chromium with reduced motion on:
// 1. axe-core, WCAG 2.1 A/AA rules (contrast, names and roles, ARIA, landmarks off: these are
//    small app windows, not documents).
// 2. Keyboard: Tab through the page and record every stop; flag stops with no visible focus
//    indicator (no outline / ring) and visible enabled controls that Tab never reaches.
// 3. Reduced motion: animations still moving things (transform keyframes over 150 ms).
// Needs Playwright's Chromium headless shell. Exits 0 unless --strict and something failed;
// exits 1 when a page could not load.
import { parseArgs } from "node:util";
import { buildPreviewSurfaces, type Surface, type SurfacePage } from "./preview-surfaces.ts";

export interface AxeViolation {
	readonly id: string;
	readonly impact: string | null;
	readonly help: string;
	readonly nodes: readonly { readonly target: string; readonly html: string; readonly summary: string }[];
}

export interface KeyboardResult {
	readonly stops: readonly string[];
	/** Stops whose focus has no visible indicator. */
	readonly invisible: readonly string[];
	/** Visible, enabled controls that Tab never reached. */
	readonly unreachable: readonly string[];
}

export interface PageResult {
	readonly page: SurfacePage;
	readonly axe: readonly AxeViolation[];
	/** Text whose contrast axe couldn't compute (translucent / layered backgrounds): checked by hand. */
	readonly contrastUndecided?: number;
	readonly keyboard: KeyboardResult;
	readonly motion: readonly string[];
	readonly error?: string;
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
// App windows, not web documents: no landmarks or page titles to speak of.
const AXE_DISABLED = ["region", "landmark-one-main", "page-has-heading-one", "document-title", "html-has-lang"];

async function checkPage(
	browser: import("playwright-core").Browser,
	axeSource: string,
	page: SurfacePage,
	url: string,
): Promise<PageResult> {
	const p = await browser.newPage({
		viewport: { width: page.width, height: page.height },
		colorScheme: page.colorScheme,
		reducedMotion: "reduce",
	});
	try {
		await p.goto(url, { waitUntil: "networkidle" });
		await p.evaluate(() => document.fonts.ready);
		await p
			.waitForFunction(() => document.body.dataset["painted"] !== "0", undefined, { timeout: 2000 })
			.catch(() => {});
		await p.waitForTimeout(100);
		await p.addScriptTag({ content: axeSource });
		const axeResult = (await p.evaluate(
			async ({ tags, disabled }) => {
				// biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global script.
				const r = await (globalThis as any).axe.run(document, {
					runOnly: { type: "tag", values: tags },
					rules: Object.fromEntries(disabled.map((id: string) => [id, { enabled: false }])),
					resultTypes: ["violations", "incomplete"],
				});
				// Contrast axe couldn't decide (text over a translucent or layered background).
				const undecided = r.incomplete
					// biome-ignore lint/suspicious/noExplicitAny: axe result shape.
					.filter((v: any) => v.id === "color-contrast")
					// biome-ignore lint/suspicious/noExplicitAny: axe result shape.
					.reduce((n: number, v: any) => n + v.nodes.length, 0);
				// biome-ignore lint/suspicious/noExplicitAny: axe result shape.
				const violations = r.violations.map((v: any) => ({
					id: v.id,
					impact: v.impact,
					help: v.help,
					// biome-ignore lint/suspicious/noExplicitAny: axe node shape.
					nodes: v.nodes.slice(0, 5).map((n: any) => ({
						target: n.target.join(" "),
						html: String(n.html).slice(0, 160),
						summary: String(n.failureSummary ?? "")
							.split("\n")
							.slice(0, 2)
							.join(" "),
					})),
				}));
				return { violations, undecided };
			},
			{ tags: AXE_TAGS, disabled: AXE_DISABLED },
		)) as { violations: AxeViolation[]; undecided: number };

		const motion = (await p.evaluate(() =>
			document
				.getAnimations()
				.filter((a) => {
					const e = a.effect as KeyframeEffect | null;
					const d = Number(e?.getTiming().duration ?? 0);
					const moves = (e?.getKeyframes() ?? []).some(
						(k) => k["transform"] !== undefined || k["translate"] !== undefined || k["scale"] !== undefined,
					);
					return d > 150 && moves && a.playState === "running";
				})
				.map((a) => {
					const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
					return `${a instanceof CSSAnimation ? a.animationName : "animation"} on ${t?.tagName.toLowerCase() ?? "?"}.${t?.className ?? ""}`;
				}),
		)) as string[];

		// Keyboard: Tab through, recording each stop.
		const describe = () =>
			p.evaluate(() => {
				const el = document.activeElement as HTMLElement | null;
				if (!el || el === document.body) return null;
				const nameOf = (el: Element) => {
					const by = el.getAttribute("aria-labelledby");
					const fromBy = by
						? by
								.split(/\s+/)
								.map((id) => document.getElementById(id)?.textContent ?? "")
								.join(" ")
						: "";
					const labels = (el as HTMLInputElement).labels;
					const fromLabel = labels && labels.length > 0 ? (labels[0]?.textContent ?? "") : "";
					return (
						el.getAttribute("aria-label") ??
						(fromBy || fromLabel || el.textContent || (el as HTMLInputElement).placeholder || "")
					)
						.trim()
						.replace(/\s+/g, " ")
						.slice(0, 40);
				};
				const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
				// The ring may be on the control or on its field wrapper (:focus-within), up to 2 levels up.
				const hasRing = (n: Element) => {
					const s = getComputedStyle(n);
					return (
						(s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0) ||
						(s.boxShadow !== "none" && s.boxShadow !== "")
					);
				};
				const ring =
					hasRing(el) ||
					(!!el.parentElement && hasRing(el.parentElement)) ||
					(!!el.parentElement?.parentElement && hasRing(el.parentElement.parentElement));
				// A key per element (names repeat: an icon "Close" and a "Close" button).
				const w = globalThis as unknown as { __a11yKeys?: number };
				if (el.dataset["a11yKey"] === undefined) {
					w.__a11yKeys = (w.__a11yKeys ?? 0) + 1;
					el.dataset["a11yKey"] = String(w.__a11yKeys);
				}
				return { key: el.dataset["a11yKey"], id: `${role} "${nameOf(el)}"`, ring };
			});
		const stops: string[] = [];
		const invisible: string[] = [];
		const seen = new Set<string>();
		// Where focus starts (a popup focuses its first action) counts as a stop; its ring isn't
		// judged (programmatic focus shows no :focus-visible ring by design).
		const initial = await describe();
		const keys: string[] = [];
		if (initial) {
			stops.push(initial.id);
			keys.push(initial.key);
			seen.add(initial.key);
		}
		let initialAgain = false;
		for (let i = 0; i < 80; i++) {
			await p.keyboard.press("Tab");
			const d = await describe();
			if (!d) continue;
			if (initial && d.key === initial.key) initialAgain = true;
			if (seen.has(d.key) && keys[initial ? 1 : 0] === d.key) break;
			if (!seen.has(d.key)) {
				stops.push(d.id);
				keys.push(d.key);
				if (!d.ring) invisible.push(d.id);
			}
			seen.add(d.key);
		}
		const unreachable = (await p.evaluate(() => {
			// Composite children (options, tabs, radios, menu items, roving blocks) are reached with arrow keys, not Tab.
			const sel =
				'button, a[href], input:not([type="hidden"]):not([type="radio"]), select, textarea, [role="button"], [role="switch"], [role="checkbox"]';
			const out: string[] = [];
			for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
				if (el.getAttribute("tabindex") === "-1") continue;
				if (
					el.closest(
						"[inert], [aria-hidden='true'], [role='listbox'], [role='menu'], [role='tablist'], [role='radiogroup']",
					)
				)
					continue;
				if (el.matches("[data-roving], [data-block]")) continue;
				const nameOf = (el: Element) => {
					const by = el.getAttribute("aria-labelledby");
					const fromBy = by
						? by
								.split(/\s+/)
								.map((id) => document.getElementById(id)?.textContent ?? "")
								.join(" ")
						: "";
					const labels = (el as HTMLInputElement).labels;
					const fromLabel = labels && labels.length > 0 ? (labels[0]?.textContent ?? "") : "";
					return (
						el.getAttribute("aria-label") ??
						(fromBy || fromLabel || el.textContent || (el as HTMLInputElement).placeholder || "")
					)
						.trim()
						.replace(/\s+/g, " ")
						.slice(0, 40);
				};
				const id = `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${nameOf(el)}"`;
				if (el.dataset["a11yKey"] === undefined) out.push(id);
			}
			return out;
		})) as string[];
		// Focus that starts on a control Tab never comes back to: reachable only once.
		// (A container parked with tabindex -1, like the Snip block list, is meant to be left.)
		const parked = await p.evaluate(
			(k) => document.querySelector(`[data-a11y-key="${k}"]`)?.getAttribute("tabindex") === "-1",
			initial?.key ?? "",
		);
		if (initial && !initialAgain && !parked && stops.length > 1)
			unreachable.push(`${initial.id} (only focused at open; Tab never returns to it)`);
		return {
			page,
			axe: axeResult.violations,
			contrastUndecided: axeResult.undecided,
			keyboard: { stops, invisible, unreachable },
			motion,
		};
	} catch (error) {
		return {
			page,
			axe: [],
			keyboard: { stops: [], invisible: [], unreachable: [] },
			motion: [],
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await p.close();
	}
}

const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("`", "'");

export function renderA11yReport(results: readonly PageResult[]): string {
	const out = ["# Accessibility check (axe-core + keyboard + reduced motion)", ""];
	const surfaces = [...new Set(results.map((r) => r.page.surface))];
	out.push(
		"| Surface | Pages | axe violations (rules) | Contrast axe couldn't decide (elements) | Focus stops without a visible ring | Controls Tab never reaches | Motion under reduced motion |",
	);
	out.push("|---|---|---|---|---|---|---|");
	for (const s of surfaces) {
		const rs = results.filter((r) => r.page.surface === s);
		const rules = new Set(rs.flatMap((r) => r.axe.map((v) => v.id)));
		const inv = new Set(rs.flatMap((r) => r.keyboard.invisible));
		const unr = new Set(rs.flatMap((r) => r.keyboard.unreachable));
		const mot = new Set(rs.flatMap((r) => r.motion));
		const undecided = rs.reduce((n, r) => n + (r.contrastUndecided ?? 0), 0);
		out.push(
			`| ${s} | ${rs.length} | ${rules.size ? [...rules].join(", ") : "none"} | ${undecided} | ${inv.size} | ${unr.size} | ${mot.size} |`,
		);
	}
	for (const r of results) {
		const lines: string[] = [];
		if (r.error) lines.push(`- could not check: ${esc(r.error)}`);
		for (const v of r.axe) {
			lines.push(`- axe \`${v.id}\` (${v.impact ?? "?"}): ${esc(v.help)}`);
			for (const n of v.nodes.slice(0, 3)) lines.push(`  - \`${esc(n.target)}\`: ${esc(n.summary)}`);
		}
		for (const i of r.keyboard.invisible) lines.push(`- focus without a visible ring: ${esc(i)}`);
		for (const u of r.keyboard.unreachable) lines.push(`- not reachable with Tab: ${esc(u)}`);
		for (const m of r.motion) lines.push(`- moves under reduced motion: ${esc(m)}`);
		if (lines.length === 0) continue;
		out.push(
			"",
			`**${r.page.surface} / ${r.page.name}** (\`${r.page.path}\`, ${r.page.colorScheme}; ${r.keyboard.stops.length} Tab stops)`,
			"",
			...lines,
		);
	}
	return `${out.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			report: { type: "string" },
			json: { type: "string" },
			surface: { type: "string", multiple: true },
			strict: { type: "boolean", default: false },
		},
	});
	const axeSource = await Bun.file(require.resolve("axe-core/axe.min.js")).text();
	const surfaces = await buildPreviewSurfaces(values.surface as Surface[] | undefined);
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch();
	const results: PageResult[] = [];
	try {
		for (const page of surfaces.pages) results.push(await checkPage(browser, axeSource, page, surfaces.url(page)));
	} finally {
		await browser.close();
		surfaces.close();
	}
	const report = renderA11yReport(results);
	if (values.report) await Bun.write(values.report, report);
	else console.log(report);
	if (values.json) await Bun.write(values.json, `${JSON.stringify(results, null, "\t")}\n`);
	const failures = results.filter(
		(r) =>
			r.axe.length > 0 || r.keyboard.invisible.length > 0 || r.keyboard.unreachable.length > 0 || r.motion.length > 0,
	).length;
	const errors = results.filter((r) => r.error).length;
	console.error(`a11y: ${results.length} pages, ${failures} with findings, ${errors} could not load`);
	if (errors > 0) process.exit(1);
	if (values.strict && failures > 0) process.exit(2);
}
