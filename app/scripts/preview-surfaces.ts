// Every UI surface as a headless page (GLIM-52, GLIM-83): the component gallery, Settings,
// onboarding, the Snip popup, the Live popup and the region picker, each built from its
// dev-only preview (the real views over fake state, as the *-shots.ts scripts use them) and
// served on its own local port. The design detector (design-detect.ts) and the accessibility
// checker (a11y-check.ts) scan the same list.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { buildViews } from "./build-views.ts";
import { VARIANTS as GALLERY_VARIANTS, serve } from "./gallery.ts";
import { ONBOARDING_VARIANTS } from "./onboarding-shots.ts";
import { SETTINGS_VARIANTS } from "./settings-shots.ts";
import { solidPlugin } from "./solid-plugin.ts";

export type Surface = "gallery" | "settings" | "onboarding" | "snip-popup" | "live-popup" | "picker";

export interface SurfacePage {
	readonly surface: Surface;
	readonly name: string;
	/** Path + query on the surface's server. */
	readonly path: string;
	readonly colorScheme: "light" | "dark";
	readonly width: number;
	readonly height: number;
}

export interface PreviewSurfaces {
	readonly pages: readonly SurfacePage[];
	/** Absolute URL of a page (servers are up until `close()`). */
	url(page: SurfacePage): string;
	close(): void;
}

const SNIP_SCENARIOS = ["s0-opened", "s4-done", "s7-skipped-expanded", "s14-cloud", "e1-no-text", "e3-offline"];
const LIVE_SCENARIOS = [
	"l1-running",
	"l4-changed",
	"l5-paused",
	"l10-consent",
	"l11-skipped-expanded",
	"l16-ocr-stopped",
];
const PICKER_STATES = ["hover", "drag", "keyboard", "tooSmall", "live", "results", "comic", "comic-overlay"];

/** The pages, without building anything. `light` keeps one appearance per query (URL scanners can't set it). */
export function surfacePages(): SurfacePage[] {
	const pages: SurfacePage[] = [];
	for (const v of GALLERY_VARIANTS)
		pages.push({
			surface: "gallery",
			name: v.name,
			path: `/?${v.query}`,
			colorScheme: v.colorScheme,
			width: v.width,
			height: v.height ?? 900,
		});
	for (const v of SETTINGS_VARIANTS)
		pages.push({
			surface: "settings",
			name: v.name,
			path: `/?${v.query}`,
			colorScheme: v.colorScheme,
			width: v.width,
			height: v.height ?? 820,
		});
	for (const v of ONBOARDING_VARIANTS)
		pages.push({
			surface: "onboarding",
			name: v.name,
			path: `/?${v.query}`,
			colorScheme: v.colorScheme,
			width: v.width,
			height: v.height ?? 480,
		});
	for (const os of ["macos", "windows"] as const) {
		const colorScheme = os === "macos" ? "light" : "dark";
		for (const s of SNIP_SCENARIOS)
			pages.push({
				surface: "snip-popup",
				name: `${s}-${os}`,
				path: `/?os=${os}&scenario=${s}`,
				colorScheme,
				width: 640,
				height: 900,
			});
		for (const s of LIVE_SCENARIOS)
			pages.push({
				surface: "live-popup",
				name: `${s}-${os}`,
				path: `/?os=${os}&scenario=${s}`,
				colorScheme: os === "macos" ? "dark" : "light",
				width: 640,
				height: 900,
			});
	}
	pages.push({
		surface: "snip-popup",
		name: "s4-done-rtl-ui",
		path: "/?os=macos&dir=rtl&scenario=s4-done",
		colorScheme: "light",
		width: 640,
		height: 900,
	});
	pages.push({
		surface: "live-popup",
		name: "l4-changed-rtl-ui",
		path: "/?os=macos&dir=rtl&scenario=l4-changed",
		colorScheme: "dark",
		width: 640,
		height: 900,
	});
	for (const s of PICKER_STATES)
		pages.push({
			surface: "picker",
			name: `picker-${s}`,
			path: `/?os=macos&state=${s}`,
			colorScheme: "light",
			width: 1280,
			height: 800,
		});
	return pages;
}

async function bundle(entry: string, outDir: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entry],
		outdir: outDir,
		target: "browser",
		format: "esm",
		plugins: [solidPlugin(), tailwind],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`preview build failed: ${entry}`);
	}
}

/** Build every preview and serve each on its own port (127.0.0.1, port 0). */
export async function buildPreviewSurfaces(only?: readonly Surface[]): Promise<PreviewSurfaces> {
	const want = (s: Surface) => !only || only.includes(s);
	const tmp = mkdtempSync(join(tmpdir(), "glimpse-surfaces-"));
	const views = [
		...(want("gallery") ? ["gallery"] : []),
		...(want("settings") ? ["settings-preview"] : []),
		...(want("onboarding") ? ["onboarding-preview"] : []),
	];
	if (views.length > 0) await buildViews({ dev: true, outDir: tmp, views });
	const scripts = import.meta.dir;
	const dirs: Partial<Record<Surface, string>> = {
		gallery: join(tmp, "gallery"),
		settings: join(tmp, "settings-preview"),
		onboarding: join(tmp, "onboarding-preview"),
	};
	if (want("snip-popup")) {
		dirs["snip-popup"] = join(tmp, "snip-popup");
		await bundle(join(scripts, "popup-preview", "index.html"), dirs["snip-popup"]);
	}
	if (want("live-popup")) {
		dirs["live-popup"] = join(tmp, "live-popup");
		await bundle(join(scripts, "live-preview", "index.html"), dirs["live-popup"]);
	}
	if (want("picker")) {
		dirs.picker = join(tmp, "picker");
		await bundle(join(scripts, "picker-preview", "index.html"), dirs.picker);
	}
	const servers = new Map<Surface, Awaited<ReturnType<typeof serve>>>();
	for (const [surface, dir] of Object.entries(dirs) as [Surface, string][]) {
		if (want(surface)) servers.set(surface, await serve(dir, 0));
	}
	return {
		pages: surfacePages().filter((p) => want(p.surface)),
		url: (page) => {
			const server = servers.get(page.surface);
			if (!server) throw new Error(`surface not built: ${page.surface}`);
			return `http://localhost:${server.port}${page.path}`;
		},
		close: () => {
			for (const s of servers.values()) s.stop(true);
			rmSync(tmp, { recursive: true, force: true });
		},
	};
}
