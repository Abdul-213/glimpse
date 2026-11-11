// GLIM-52: the Impeccable design detector over Glimpse's UI, for CI and by hand.
//
//   bun app/scripts/design-detect.ts [--report <file.md>] [--json <file>] [--strict] [--no-rendered]
//
// Two passes:
// 1. Source: `impeccable detect` over app/src/views and packages/ui/src (regex rules on
//    .tsx/.ts/.css; element rules such as contrast and tiny text need a page).
// 2. Rendered: every preview surface (preview-surfaces.ts: gallery, Settings, onboarding, Snip
//    popup, Live popup, picker) built, served on localhost and scanned in headless Chromium
//    (Playwright's headless shell; IMPECCABLE_BROWSER overrides).
//
// Project exceptions live in .impeccable/config.json (written with `impeccable hooks
// ignore-value ...`, each with its reason; see CONTRIBUTING.md). Non-blocking: exits 0 with
// findings unless --strict; exits 1 when a scan could not run.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPreviewSurfaces, type SurfacePage } from "./preview-surfaces.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(ROOT, ".claude", "skills", "impeccable", "scripts", "impeccable");
const SOURCE_TARGETS = ["app/src/views", "packages/ui/src"];

export interface Finding {
	readonly antipattern: string;
	readonly name: string;
	readonly severity: string;
	readonly file: string;
	readonly line?: number;
	readonly snippet?: string;
	readonly advisory?: boolean;
}

/** Playwright's Chromium headless shell from the cache CI and the gallery use. */
export function findChromium(): string | null {
	if (process.env["IMPECCABLE_BROWSER"]) return process.env["IMPECCABLE_BROWSER"];
	const cache = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? join(homedir(), ".cache", "ms-playwright");
	if (!existsSync(cache)) return null;
	for (const d of readdirSync(cache)
		.filter((n) => n.startsWith("chromium_headless_shell-"))
		.sort()
		.reverse()) {
		const exe = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
		if (existsSync(exe)) return exe;
	}
	return null;
}

async function detect(
	targets: readonly string[],
	env: Record<string, string> = {},
): Promise<{ findings: Finding[]; failed: boolean; stderr: string }> {
	const p = Bun.spawn([CLI, "detect", "--json", ...targets], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		// DO_NOT_TRACK: the CLI otherwise pings its telemetry endpoint.
		env: { ...process.env, DO_NOT_TRACK: "1", ...env },
	});
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	let findings: Finding[] = [];
	try {
		findings = out.trim() ? (JSON.parse(out) as Finding[]) : [];
	} catch {
		return { findings: [], failed: true, stderr: `${err}\n${out}`.trim() };
	}
	// Exit 2 = findings (fine); 1 = a target could not be scanned.
	return { findings, failed: code === 1, stderr: err };
}

const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderReport(
	source: readonly Finding[],
	rendered: readonly { page: SurfacePage; url: string; findings: readonly Finding[] }[],
	notes: readonly string[],
): string {
	const out: string[] = ["# Impeccable design detector", ""];
	const primary = (fs: readonly Finding[]) => fs.filter((f) => !f.advisory);
	const all = [...source, ...rendered.flatMap((r) => r.findings)];
	out.push(
		`Source: ${primary(source).length} findings (${source.length - primary(source).length} advisory) in ${SOURCE_TARGETS.join(", ")}. ` +
			`Rendered: ${rendered.length} pages, ${primary(rendered.flatMap((r) => r.findings)).length} findings.`,
	);
	for (const n of notes) out.push("", `> ${n}`);
	const byRule = new Map<string, number>();
	for (const f of all)
		byRule.set(
			`${f.antipattern}${f.advisory ? " (advisory)" : ""}`,
			(byRule.get(`${f.antipattern}${f.advisory ? " (advisory)" : ""}`) ?? 0) + 1,
		);
	if (byRule.size > 0) {
		out.push("", "| Rule | Count |", "|---|---|");
		for (const [r, n] of [...byRule].sort((a, b) => b[1] - a[1])) out.push(`| ${r} | ${n} |`);
	}
	if (source.length > 0) {
		out.push("", "## Source", "");
		for (const f of source)
			out.push(
				`- ${f.advisory ? "(advisory) " : ""}\`${relative(ROOT, f.file)}:${f.line ?? "?"}\` [${f.antipattern}] ${esc(f.snippet ?? f.name)}`,
			);
	}
	const withFindings = rendered.filter((r) => r.findings.length > 0);
	if (withFindings.length > 0) {
		out.push("", "## Rendered pages", "");
		for (const r of withFindings) {
			out.push(`**${r.page.surface} / ${r.page.name}** (\`${r.page.path}\`)`, "");
			for (const f of r.findings)
				out.push(`- ${f.advisory ? "(advisory) " : ""}[${f.antipattern}] ${esc(f.snippet ?? f.name)}`);
			out.push("");
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			report: { type: "string" },
			json: { type: "string" },
			strict: { type: "boolean", default: false },
			"no-rendered": { type: "boolean", default: false },
		},
	});
	const notes: string[] = [];
	let failed = false;
	const src = await detect(SOURCE_TARGETS);
	if (src.failed) {
		failed = true;
		notes.push(`source scan failed: ${src.stderr.slice(0, 300)}`);
	}
	const rendered: { page: SurfacePage; url: string; findings: Finding[] }[] = [];
	if (!values["no-rendered"]) {
		const browser = findChromium();
		if (!browser) {
			failed = true;
			notes.push("rendered scan skipped: no Chromium (run `bunx playwright-core install --only-shell chromium`)");
		} else {
			const surfaces = await buildPreviewSurfaces();
			try {
				// One appearance per URL: a URL scan can't set prefers-color-scheme.
				const seen = new Set<string>();
				const pages = surfaces.pages.filter(
					(p) => !seen.has(`${p.surface}${p.path}`) && seen.add(`${p.surface}${p.path}`),
				);
				const urls = pages.map((p) => surfaces.url(p));
				// The headless shell runs as the CI user without a setuid sandbox; the pages are local previews.
				const r = await detect(urls, { IMPECCABLE_BROWSER: browser, PUPPETEER_DANGEROUS_NO_SANDBOX: "true" });
				if (r.failed) {
					failed = true;
					notes.push(`some pages could not be scanned: ${r.stderr.slice(0, 500)}`);
				}
				const strip = (u: string) => u.replace(/\/$/, "");
				pages.forEach((page, i) => {
					const url = urls[i] as string;
					rendered.push({ page, url, findings: r.findings.filter((f) => strip(f.file) === strip(url)) });
				});
			} finally {
				surfaces.close();
			}
		}
	}
	const report = renderReport(src.findings, rendered, notes);
	if (values.report) await Bun.write(values.report, report);
	else console.log(report);
	if (values.json)
		await Bun.write(values.json, `${JSON.stringify({ source: src.findings, rendered, notes }, null, "\t")}\n`);
	const count = [...src.findings, ...rendered.flatMap((r) => r.findings)].filter((f) => !f.advisory).length;
	console.error(
		`design detector: ${count} findings over source + ${rendered.length} rendered pages${failed ? " (some scans failed)" : ""}`,
	);
	if (failed) process.exit(1);
	if (values.strict && count > 0) process.exit(2);
}
