// The GLIM-58 Live scenario recording (app/test/fixtures/capture/live-scenario, rendered by
// app/scripts/make-live-fixtures.ts): what it shows and where.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Rect, rect } from "@glimpse/core";

export const LIVE_SCENARIO_DIR = resolve(import.meta.dir, "../../test/fixtures/capture/live-scenario");

/** The subtitle lines, keyed by frame file (a.png, b.png, c.png). */
export const LIVE_SCENARIO_LINES = {
	a: "明日の会議は午後三時に始まります。",
	b: "請求書を保存しました。",
	c: "次の駅で降りてください。",
} as const;

/** The subtitle strip of the 800 x 240 scene (global logical): the region a user would pin. */
export const LIVE_SCENARIO_RECT: Rect = rect(0, 150, 800, 90);

/**
 * Which frame file a timed recording shows at `t` ms (for timelines), from its frames.json;
 * "" when the folder has no manifest.
 */
export function frameNamer(dir: string): (t: number) => string {
	let frames: { file: string; holdMs?: number }[] = [];
	try {
		frames = (JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")) as { frames?: typeof frames }).frames ?? [];
	} catch {
		return () => "";
	}
	return (t) => {
		let end = 0;
		for (const f of frames) {
			end += f.holdMs ?? 250;
			if (t < end) return f.file.replace(/\.png$/, "");
		}
		return frames.at(-1)?.file.replace(/\.png$/, "") ?? "";
	};
}
