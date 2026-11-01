// File-based CaptureSource (GLIM-86): replays screenshots from disk behind the same
// port as the native backends, so the pipeline, Snip and Live mode run headless on
// Linux and in CI.
//
// A frame folder holds PNGs (each one is the whole virtual desktop) and an optional
// frames.json:
//
//   {
//     "displays": [                          // default: one display the size of the first PNG, scale 1
//       { "id": 1, "bounds": { "x": 0, "y": 0, "width": 800, "height": 450 },
//         "scaleFactor": 2, "isPrimary": true,
//         "pixelBounds": { "x": 0, "y": 0, "width": 1600, "height": 900 } }  // where it is in the PNG
//     ],
//     "frames": ["0001.png", { "file": "0002.png", "holdMs": 500 }],         // default: every *.png, sorted
//     "advance": "per-grab",                 // or "timed" (uses holdMs, default 250 ms)
//     "end": "hold"                          // or "loop"
//   }
//
// A path to a single PNG works too: one frame, one display.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type CaptureDisplay,
	FrameSequenceSource,
	type Rect,
	type RgbaImage,
	type SequenceAdvance,
	type SequenceFrame,
} from "@glimpse/core";
import { decodePng } from "./png.ts";

export const MANIFEST = "frames.json";

export class FrameFolderError extends Error {
	override readonly name = "FrameFolderError";
}

export interface FileCaptureOptions {
	readonly now?: () => number;
	/** Overrides the manifest's `advance`. */
	readonly advance?: SequenceAdvance;
	readonly end?: "hold" | "loop";
}

interface Manifest {
	displays?: CaptureDisplay[];
	frames?: { file: string; holdMs?: number }[];
	advance?: SequenceAdvance;
	end?: "hold" | "loop";
}

/** Load a frame folder (or a single PNG) into a FrameSequenceSource with backend `file`. */
export function createFileCaptureSource(path: string, options: FileCaptureOptions = {}): FrameSequenceSource {
	const single = statSafe(path)?.isFile() ?? false;
	const dir = single ? dirname(path) : path;
	if (!single && !statSafe(dir)?.isDirectory()) throw new FrameFolderError(`frame folder not found: ${path}`);
	const manifestPath = join(dir, MANIFEST);
	const manifest: Manifest = single ? {} : statSafe(manifestPath) ? parseManifest(readJson(manifestPath)) : {};

	const entries: { file: string; holdMs?: number }[] = single
		? [{ file: basename(path) }]
		: (manifest.frames ??
			readdirSync(dir)
				.filter((f) => f.toLowerCase().endsWith(".png"))
				.sort()
				.map((file) => ({ file })));
	if (entries.length === 0) throw new FrameFolderError(`no PNG frames in ${dir}`);

	const frames: SequenceFrame[] = entries.map(({ file, holdMs }) => {
		const image = readPng(join(dir, file));
		return holdMs === undefined ? { image, name: file } : { image, name: file, holdMs };
	});
	const first = frames[0]?.image as RgbaImage;
	for (const f of frames) {
		if (f.image.width !== first.width || f.image.height !== first.height) {
			throw new FrameFolderError(
				`${f.name} is ${f.image.width}x${f.image.height}, but frames must all be ${first.width}x${first.height}`,
			);
		}
	}
	const displays = manifest.displays ?? [defaultDisplay(first)];
	for (const d of displays) {
		const p = d.nativeBounds;
		if (p.x < 0 || p.y < 0 || p.x + p.width > first.width || p.y + p.height > first.height) {
			throw new FrameFolderError(`display ${d.id} pixelBounds fall outside the ${first.width}x${first.height} frames`);
		}
	}
	const advance = options.advance ?? manifest.advance;
	const end = options.end ?? manifest.end;
	return new FrameSequenceSource({
		displays,
		frames,
		now: options.now ?? Date.now,
		backend: "file",
		...(advance ? { advance } : {}),
		...(end ? { end } : {}),
	});
}

function defaultDisplay(img: RgbaImage): CaptureDisplay {
	const bounds = { x: 0, y: 0, width: img.width, height: img.height };
	return { id: 1, bounds, workArea: bounds, scaleFactor: 1, isPrimary: true, nativeBounds: bounds };
}

function statSafe(path: string) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new FrameFolderError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function readPng(path: string): RgbaImage {
	try {
		return decodePng(new Uint8Array(readFileSync(path)));
	} catch (e) {
		throw new FrameFolderError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ---- manifest validation (plain data in, typed data out) --------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new FrameFolderError(`${MANIFEST}: ${what} must be a number`);
	return v;
}

function parseRectField(v: unknown, what: string): Rect {
	if (!isObject(v)) throw new FrameFolderError(`${MANIFEST}: ${what} must be {x, y, width, height}`);
	const r = {
		x: num(v["x"], `${what}.x`),
		y: num(v["y"], `${what}.y`),
		width: num(v["width"], `${what}.width`),
		height: num(v["height"], `${what}.height`),
	};
	if (r.width <= 0 || r.height <= 0) throw new FrameFolderError(`${MANIFEST}: ${what} must have a positive size`);
	return r;
}

export function parseManifest(raw: unknown): Manifest {
	if (!isObject(raw)) throw new FrameFolderError(`${MANIFEST} must be a JSON object`);
	const out: Manifest = {};
	if (raw["displays"] !== undefined) {
		const list = raw["displays"];
		if (!Array.isArray(list) || list.length === 0) {
			throw new FrameFolderError(`${MANIFEST}: displays must be a non-empty array`);
		}
		out.displays = list.map((d, i): CaptureDisplay => {
			if (!isObject(d)) throw new FrameFolderError(`${MANIFEST}: displays[${i}] must be an object`);
			const bounds = parseRectField(d["bounds"], `displays[${i}].bounds`);
			const scaleFactor = d["scaleFactor"] === undefined ? 1 : num(d["scaleFactor"], `displays[${i}].scaleFactor`);
			if (scaleFactor <= 0) throw new FrameFolderError(`${MANIFEST}: displays[${i}].scaleFactor must be positive`);
			const nativeBounds =
				d["pixelBounds"] === undefined
					? {
							x: 0,
							y: 0,
							width: Math.round(bounds.width * scaleFactor),
							height: Math.round(bounds.height * scaleFactor),
						}
					: parseRectField(d["pixelBounds"], `displays[${i}].pixelBounds`);
			if (d["pixelBounds"] === undefined && list.length > 1) {
				throw new FrameFolderError(
					`${MANIFEST}: displays[${i}].pixelBounds is required when there are several displays`,
				);
			}
			return {
				id: d["id"] === undefined ? i + 1 : num(d["id"], `displays[${i}].id`),
				bounds,
				workArea: d["workArea"] === undefined ? bounds : parseRectField(d["workArea"], `displays[${i}].workArea`),
				scaleFactor,
				isPrimary: d["isPrimary"] === undefined ? i === 0 : d["isPrimary"] === true,
				nativeBounds,
			};
		});
	}
	if (raw["frames"] !== undefined) {
		const list = raw["frames"];
		if (!Array.isArray(list)) throw new FrameFolderError(`${MANIFEST}: frames must be an array`);
		out.frames = list.map((f, i) => {
			if (typeof f === "string") return { file: f };
			if (isObject(f) && typeof f["file"] === "string") {
				return f["holdMs"] === undefined
					? { file: f["file"] }
					: { file: f["file"], holdMs: Math.max(0, num(f["holdMs"], `frames[${i}].holdMs`)) };
			}
			throw new FrameFolderError(`${MANIFEST}: frames[${i}] must be a file name or {file, holdMs}`);
		});
	}
	if (raw["advance"] !== undefined) {
		if (raw["advance"] !== "per-grab" && raw["advance"] !== "timed") {
			throw new FrameFolderError(`${MANIFEST}: advance must be "per-grab" or "timed"`);
		}
		out.advance = raw["advance"];
	}
	if (raw["end"] !== undefined) {
		if (raw["end"] !== "hold" && raw["end"] !== "loop")
			throw new FrameFolderError(`${MANIFEST}: end must be "hold" or "loop"`);
		out.end = raw["end"];
	}
	return out;
}
