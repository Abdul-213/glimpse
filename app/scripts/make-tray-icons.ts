// Draws the tray / menu-bar icons into assets/tray/ (GLIM-99; docs/design/flows/tray.html
// "Icon states"). 32 x 32 px, shown at 16 pt / 16 px at 200 %.
//
// The glyph: the four rounded corner brackets of the Live pinned-region frame (DESIGN.md's
// signature move) around two lines of text, the second one shorter (a gloss). Monochrome
// (DESIGN.md Shapes). Badges sit at the bottom-right in a knocked-out circle, and are shapes,
// not colours, so they read in greyscale: a dot (Live running), two bars (Live paused), a cloud
// (a cloud provider is selected), a disc with "!" cut out (needs attention). Priority
// ! > cloud > Live (tray-menu.ts `trayBadge`).
//
// Variants per badge: `tray-template*.png` (macOS template image: black + alpha, the system
// tints it), `tray-light*.png` (light glyph for dark Windows taskbars) and `tray-dark*.png`.
// On Windows the cloud badge is Egress Violet (DESIGN.md: "a violet-tinted cloud badge on the
// tray icon"); everything else stays monochrome.
//
// Shapes are distance functions, 4 x 4 supersampled for smooth edges.
//   bun scripts/make-tray-icons.ts            write the PNGs
//   bun scripts/make-tray-icons.ts --preview  also write docs/design/screens/tray/tray-icons.png (4x)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const TRAY_SIZE = 32;
export const TRAY_BADGES = ["none", "live", "paused", "cloud", "attention"] as const;
export type TrayIconBadge = (typeof TRAY_BADGES)[number];

type Shape = (x: number, y: number) => boolean;

/** Inside a round-capped segment of half-width r. */
const capsule =
	(x0: number, y0: number, x1: number, y1: number, r: number): Shape =>
	(x, y) => {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
		const px = x0 + t * dx - x;
		const py = y0 + t * dy - y;
		return px * px + py * py <= r * r;
	};
const disc =
	(cx: number, cy: number, r: number): Shape =>
	(x, y) =>
		(x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const union =
	(...s: Shape[]): Shape =>
	(x, y) =>
		s.some((f) => f(x, y));
const minus =
	(a: Shape, b: Shape): Shape =>
	(x, y) =>
		a(x, y) && !b(x, y);

// ---- the glyph ------------------------------------------------------------------------

const STROKE = 1.5; // half-width: a 3 px line, 1.5 pt
const LO = 4.5;
const HI = TRAY_SIZE - 4.5;
const ARM = 7.5;

const bracket = (cx: number, cy: number, sx: 1 | -1, sy: 1 | -1): Shape =>
	union(capsule(cx, cy, cx + sx * ARM, cy, STROKE), capsule(cx, cy, cx, cy + sy * ARM, STROKE));

const GLYPH: Shape = union(
	bracket(LO, LO, 1, 1),
	bracket(HI, LO, -1, 1),
	bracket(LO, HI, 1, -1),
	bracket(HI, HI, -1, -1),
	capsule(10.5, 13, 21.5, 13, STROKE),
	capsule(10.5, 19, 17, 19, STROKE),
);

// ---- badges (bottom-right) ------------------------------------------------------------

const BX = 25;
const BY = 25;
/** The glyph is cleared inside this radius so the badge has a gap around it. */
const KNOCKOUT = disc(BX, BY, 8.5);

// Two bumps over a flat, round-ended base: the outlined cloud icon's silhouette, filled.
const cloudShape: Shape = union(
	capsule(20.4, 27.2, 29.6, 27.2, 2.6),
	disc(23.4, 25.2, 3.4),
	disc(27, 24.4, 3.6),
	(x, y) => x >= 20.4 && x <= 29.6 && y >= 24.4 && y <= 29.8,
);

export const BADGE_SHAPES: Readonly<Record<Exclude<TrayIconBadge, "none">, Shape>> = {
	live: disc(BX, BY, 5.5),
	paused: union(capsule(22.5, 21, 22.5, 29, 1.5), capsule(27.5, 21, 27.5, 29, 1.5)),
	cloud: cloudShape,
	attention: minus(disc(BX, BY, 6.5), union(capsule(BX, 20.9, BX, 25.4, 1.25), disc(BX, 28.5, 1.3))),
};

const SS = 4;

/** Coverage 0..255 of a shape per pixel. */
function coverage(shape: Shape): Uint8Array {
	const out = new Uint8Array(TRAY_SIZE * TRAY_SIZE);
	for (let py = 0; py < TRAY_SIZE; py++) {
		for (let px = 0; px < TRAY_SIZE; px++) {
			let n = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) if (shape(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) n++;
			}
			out[py * TRAY_SIZE + px] = Math.round((n / (SS * SS)) * 255);
		}
	}
	return out;
}

type Rgb = readonly [number, number, number];

/** RGBA pixels: the glyph in `ink`, the badge in `badgeInk`. Shapes never overlap (knockout). */
export function trayIconPixels(badge: TrayIconBadge, ink: Rgb, badgeInk: Rgb = ink): Uint8Array {
	const glyph = coverage(badge === "none" ? GLYPH : minus(GLYPH, KNOCKOUT));
	const mark = badge === "none" ? new Uint8Array(glyph.length) : coverage(BADGE_SHAPES[badge]);
	const px = new Uint8Array(TRAY_SIZE * TRAY_SIZE * 4);
	for (let i = 0; i < glyph.length; i++) {
		const g = glyph[i] ?? 0;
		const b = mark[i] ?? 0;
		const a = Math.min(255, g + b);
		const c = b > g ? badgeInk : ink;
		px.set([c[0], c[1], c[2], a], i * 4);
	}
	return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** An 8-bit RGBA PNG of `width` x `height` pixels. */
export function encodePng(rgba: Uint8Array, width = TRAY_SIZE, height = TRAY_SIZE): Uint8Array {
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	const raw = new Uint8Array(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
	}
	return Buffer.concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	]);
}

/** Ink per variant (DESIGN.md: text-primary on each surface; egress / egress-dark for the cloud badge). */
export const TRAY_VARIANTS = {
	template: { ink: [0, 0, 0], cloud: [0, 0, 0] },
	light: { ink: [0xf4, 0xf4, 0xf6], cloud: [0xc4, 0xb0, 0xff] },
	dark: { ink: [0x1d, 0x1d, 0x1f], cloud: [0x5e, 0x32, 0xae] },
} as const satisfies Record<string, { ink: Rgb; cloud: Rgb }>;
export type TrayVariant = keyof typeof TRAY_VARIANTS;

export const trayIconFile = (variant: TrayVariant, badge: TrayIconBadge): string =>
	`tray-${variant}${badge === "none" ? "" : `-${badge}`}.png`;

export function trayIcon(variant: TrayVariant, badge: TrayIconBadge): Uint8Array {
	const v = TRAY_VARIANTS[variant];
	return trayIconPixels(badge, v.ink, badge === "cloud" ? v.cloud : v.ink);
}

/** Every variant at 4x on a menu-bar-like strip: light and dark backgrounds, for review. */
function preview(): Uint8Array {
	const scale = 4;
	const cell = TRAY_SIZE * scale + 16;
	const rows: { variant: TrayVariant; bg: Rgb }[] = [
		{ variant: "dark", bg: [0xee, 0xee, 0xf0] },
		{ variant: "light", bg: [0x20, 0x20, 0x24] },
		{ variant: "template", bg: [0xee, 0xee, 0xf0] },
	];
	const w = cell * TRAY_BADGES.length;
	const h = cell * rows.length;
	const out = new Uint8Array(w * h * 4);
	rows.forEach((row, r) => {
		for (let y = r * cell; y < (r + 1) * cell; y++) {
			for (let x = 0; x < w; x++) out.set([...row.bg, 255], (y * w + x) * 4);
		}
		TRAY_BADGES.forEach((badge, c) => {
			const icon = trayIcon(row.variant, badge);
			for (let y = 0; y < TRAY_SIZE * scale; y++) {
				for (let x = 0; x < TRAY_SIZE * scale; x++) {
					const s = (Math.floor(y / scale) * TRAY_SIZE + Math.floor(x / scale)) * 4;
					const a = (icon[s + 3] ?? 0) / 255;
					const d = ((r * cell + 8 + y) * w + c * cell + 8 + x) * 4;
					for (let k = 0; k < 3; k++) out[d + k] = Math.round((icon[s + k] ?? 0) * a + (row.bg[k] ?? 0) * (1 - a));
				}
			}
		});
	});
	return encodePng(out, w, h);
}

if (import.meta.main) {
	const dir = join(import.meta.dir, "..", "assets", "tray");
	mkdirSync(dir, { recursive: true });
	for (const variant of Object.keys(TRAY_VARIANTS) as TrayVariant[]) {
		for (const badge of TRAY_BADGES) await Bun.write(join(dir, trayIconFile(variant, badge)), trayIcon(variant, badge));
	}
	if (process.argv.includes("--preview")) {
		await Bun.write(
			join(import.meta.dir, "..", "..", "docs", "design", "screens", "tray", "tray-icons.png"),
			preview(),
		);
	}
	console.log(`wrote tray icons to ${dir}`);
}
