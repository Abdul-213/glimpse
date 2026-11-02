// GLIM-99: the tray icon art and its state badges (flows/tray.html "Icon states").
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BADGE_SHAPES,
	TRAY_BADGES,
	TRAY_SIZE,
	TRAY_VARIANTS,
	type TrayVariant,
	trayIcon,
	trayIconFile,
} from "../scripts/make-tray-icons.ts";
import { TRAY_POINTS, type TrayImageNative, trayImageSetter } from "../src/bun/native/tray-image.ts";
import {
	TrayController,
	type TrayState,
	trayAccessibleName,
	trayBadge,
	trayIconFor,
	trayIconForState,
} from "../src/bun/tray-menu.ts";

const ASSETS = join(import.meta.dir, "..", "assets", "tray");

const base: TrayState = {
	platform: "macos",
	live: "off",
	private: false,
	translation: { name: "Firefox Translations (Bergamot)", kind: "local" },
	hotkeys: { snip: "Ctrl+Shift+S", live: "Ctrl+Shift+L" },
	taskbarTheme: "dark",
};
const cloud = { name: "Google Cloud Translation", kind: "cloud" } as const;
const notice = {
	label: { windows: "Allow screen access…", macos: "Allow Screen Access…" },
	action: "app.quit",
} as const;

const alpha = (px: Uint8Array) => Array.from({ length: TRAY_SIZE * TRAY_SIZE }, (_, i) => px[i * 4 + 3] ?? 0);

describe("trayBadge: one badge, priority ! > cloud > Live", () => {
	test("each state alone", () => {
		expect(trayBadge(base)).toBe("none");
		expect(trayBadge({ ...base, live: "running" })).toBe("live");
		expect(trayBadge({ ...base, live: "paused" })).toBe("paused");
		expect(trayBadge({ ...base, translation: cloud })).toBe("cloud");
		expect(trayBadge({ ...base, cloudOcr: "Google Cloud Vision" })).toBe("cloud");
		expect(trayBadge({ ...base, notices: [notice] })).toBe("attention");
	});

	test("priority", () => {
		expect(trayBadge({ ...base, live: "running", translation: cloud })).toBe("cloud");
		expect(trayBadge({ ...base, live: "paused", translation: cloud, notices: [notice] })).toBe("attention");
		// An update isn't a problem: no badge.
		expect(trayBadge({ ...base, update: { version: "1.2.0" } })).toBe("none");
	});
});

describe("trayIconFor with a badge", () => {
	test("file names per OS, taskbar theme and badge; macOS stays a template", () => {
		expect(trayIconFor("macos", "dark", "live")).toEqual({
			image: "views://assets/tray-template-live.png",
			template: true,
		});
		expect(trayIconFor("windows", "dark", "cloud").image).toBe("views://assets/tray-light-cloud.png");
		expect(trayIconFor("windows", "light", "attention").image).toBe("views://assets/tray-dark-attention.png");
		expect(trayIconFor("linux", "dark", "paused").image).toBe("views://assets/tray-dark-paused.png");
		expect(trayIconForState({ ...base, live: "running" }).image).toBe("views://assets/tray-template-live.png");
	});

	test("every icon trayIconFor can name is in assets/tray", () => {
		for (const platform of ["macos", "windows", "linux"] as const) {
			for (const theme of ["light", "dark"] as const) {
				for (const badge of TRAY_BADGES) {
					const file = trayIconFor(platform, theme, badge).image.replace("views://assets/", "");
					expect(existsSync(join(ASSETS, file))).toBe(true);
				}
			}
		}
	});

	test("TrayController swaps the image when the badge changes, and only then", () => {
		const images: string[] = [];
		const c = new TrayController({ setMenu: () => {}, setImage: (i) => images.push(i) }, base);
		c.update({ live: "running" });
		c.update({ private: true });
		c.update({ translation: cloud });
		c.update({ live: "off" });
		c.update({ notices: [notice] });
		expect(images).toEqual([
			"views://assets/tray-template-live.png",
			"views://assets/tray-template-cloud.png",
			"views://assets/tray-template-attention.png",
		]);
	});
});

describe("tray icon art (scripts/make-tray-icons.ts)", () => {
	test("the committed PNGs are what the script draws", () => {
		for (const variant of Object.keys(TRAY_VARIANTS) as TrayVariant[]) {
			for (const badge of TRAY_BADGES) {
				const committed = readFileSync(join(ASSETS, trayIconFile(variant, badge)));
				const drawn = new Uint8Array(trayIcon(variant, badge));
				expect(Buffer.compare(committed, Buffer.from(drawn))).toBe(0);
			}
		}
	});

	test("monochrome: the template is black + alpha; only Windows' cloud badge is tinted", () => {
		for (const badge of TRAY_BADGES) {
			const px = trayIcon("template", badge);
			for (let i = 0; i < px.length; i += 4) expect([px[i], px[i + 1], px[i + 2]]).toEqual([0, 0, 0]);
		}
		const colours = (variant: TrayVariant, badge: (typeof TRAY_BADGES)[number]) => {
			const px = trayIcon(variant, badge);
			const set = new Set<string>();
			for (let i = 0; i < px.length; i += 4) if ((px[i + 3] ?? 0) > 0) set.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
			return set.size;
		};
		expect(colours("light", "live")).toBe(1);
		expect(colours("dark", "attention")).toBe(1);
		expect(colours("light", "cloud")).toBe(2);
	});

	test("badges are distinct shapes, and the glyph is cleared under them", () => {
		const shapes = TRAY_BADGES.map((b) => alpha(trayIcon("template", b)).join(","));
		expect(new Set(shapes).size).toBe(TRAY_BADGES.length);
		// Inside the knockout circle (r 8.5 around 25,25), a pixel the badge doesn't touch is clear.
		const none = alpha(trayIcon("template", "none"));
		let glyphUnderBadges = 0;
		for (const badge of Object.keys(BADGE_SHAPES) as (keyof typeof BADGE_SHAPES)[]) {
			const a = alpha(trayIcon("template", badge));
			const shape = BADGE_SHAPES[badge];
			for (let y = 0; y < TRAY_SIZE; y++) {
				for (let x = 0; x < TRAY_SIZE; x++) {
					if ((x + 0.5 - 25) ** 2 + (y + 0.5 - 25) ** 2 > 8 ** 2) continue;
					const touched = [0, 0.5, 1].some((dx) => [0, 0.5, 1].some((dy) => shape(x + dx, y + dy)));
					if (touched) continue;
					if ((none[y * TRAY_SIZE + x] ?? 0) > 0) glyphUnderBadges++;
					expect(a[y * TRAY_SIZE + x]).toBe(0);
				}
			}
		}
		// The check isn't vacuous: the glyph does reach into the badge corner.
		expect(glyphUnderBadges).toBeGreaterThan(0);
	});
});

describe("accessible name says what the badge shows (GLIM-136 + GLIM-99)", () => {
	test("attention, Live and cloud in words", () => {
		expect(trayAccessibleName({ ...base, translation: cloud })).toBe("Glimpse — cloud: Google");
		expect(trayAccessibleName({ ...base, live: "running", cloudOcr: "Google Cloud Vision" })).toBe(
			"Glimpse — Live running, cloud: Google",
		);
		expect(trayAccessibleName({ ...base, notices: [notice], live: "paused", translation: cloud })).toBe(
			"Glimpse — needs attention, Live paused, cloud: Google",
		);
	});
});

describe("trayImageSetter", () => {
	const fakeTray = (id = 3) => {
		const set: string[] = [];
		return {
			set,
			tray: {
				id,
				setImage: (i: string) => set.push(i),
				resolveImagePath: (i: string) => i.replace("views://", "/app/views/"),
			},
		};
	};
	const fakeNative = (ok = true) => {
		const calls: [number, string, number][] = [];
		const native: TrayImageNative = {
			setTemplateImage: (id, path, size) => {
				calls.push([id, path, size]);
				return ok;
			},
		};
		return { calls, native };
	};

	test("Windows and Linux use Electrobun's setImage", () => {
		const t = fakeTray();
		trayImageSetter("windows", t.tray, () => null)("views://assets/tray-light-live.png");
		expect(t.set).toEqual(["views://assets/tray-light-live.png"]);
	});

	test("macOS goes through the helper as a 16 pt template, never Electrobun's setImage", () => {
		const t = fakeTray(7);
		const n = fakeNative();
		trayImageSetter("macos", t.tray, () => n.native)("views://assets/tray-template-live.png");
		expect(n.calls).toEqual([[7, "/app/views/assets/tray-template-live.png", TRAY_POINTS]]);
		expect(t.set).toEqual([]);
	});

	test("macOS without the helper keeps the old icon and warns once", () => {
		const t = fakeTray();
		const warnings: string[] = [];
		const set = trayImageSetter(
			"macos",
			t.tray,
			() => null,
			(m) => warnings.push(m),
		);
		set("views://assets/tray-template-live.png");
		set("views://assets/tray-template.png");
		expect(t.set).toEqual([]);
		expect(warnings).toHaveLength(1);
		const failing = fakeNative(false);
		const w2: string[] = [];
		trayImageSetter(
			"macos",
			t.tray,
			() => failing.native,
			(m) => w2.push(m),
		)("views://assets/tray-template-cloud.png");
		expect(w2).toEqual(["tray: badge not shown (status item not found)"]);
	});
});
