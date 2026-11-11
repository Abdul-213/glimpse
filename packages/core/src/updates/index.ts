// GLIM-70: update notification, pure parts. Glimpse asks GitHub for the latest published
// release at most once a day (when the user hasn't turned it off) and, if it is newer, says so
// in the tray and in Settings › About. It never downloads or installs anything.
//
// The app supplies the HTTP call and the stored state (app/src/bun/services/update-check.ts).

/** GitHub's "latest release": newest published, non-draft, non-prerelease. */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/Abdul-213/glimpse/releases/latest";

/** Release page for people to download from (opened in the browser). */
export const RELEASES_PAGE_URL = "https://github.com/Abdul-213/glimpse/releases";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
	/** Version without the leading "v" ("0.2.0"). */
	readonly version: string;
	/** The release's GitHub page. Always under RELEASES_PAGE_URL. */
	readonly url: string;
}

/** What the last check found, persisted between runs. */
export interface UpdateCheckState {
	/** Epoch ms of the last attempt (successful or not), or null if never. */
	readonly lastCheckAt: number | null;
	/** The latest release seen, or null if none was found yet. */
	readonly latest: ReleaseInfo | null;
}

export const EMPTY_UPDATE_STATE: UpdateCheckState = { lastCheckAt: null, latest: null };

/** What the UI shows. */
export type UpdateStatus =
	| { readonly state: "off" }
	| { readonly state: "current"; readonly lastCheckAt: number | null }
	| { readonly state: "available"; readonly release: ReleaseInfo; readonly lastCheckAt: number | null };

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type Parsed = { readonly core: readonly [number, number, number]; readonly pre: readonly string[] };

function parseVersion(v: string): Parsed | null {
	const m = VERSION.exec(v.trim());
	if (!m) return null;
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence: negative if a < b, 0 if equal, positive if a > b. Null if either is invalid. */
export function compareReleaseVersions(a: string, b: string): number | null {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) {
		const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
		if (d !== 0) return d;
	}
	// A pre-release is lower than the release; compare identifiers left to right.
	if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) {
			const d = Number(p) - Number(q);
			if (d !== 0) return d;
		} else if (pn !== qn) return pn ? -1 : 1;
		else if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The release in a `releases/latest` response, or null if it isn't one we'd show: drafts,
 * prereleases, tags that aren't versions, pages outside the repo's releases.
 */
export function parseLatestRelease(body: unknown): ReleaseInfo | null {
	if (!isRecord(body)) return null;
	const tag = body["tag_name"];
	const url = body["html_url"];
	if (body["draft"] === true || body["prerelease"] === true) return null;
	if (typeof tag !== "string" || typeof url !== "string") return null;
	if (!parseVersion(tag) || !url.startsWith(`${RELEASES_PAGE_URL}/`)) return null;
	return { version: tag.replace(/^v/, ""), url };
}

/** Whether to ask GitHub now: enabled, and never checked or last checked a day ago or more. */
export function isCheckDue(state: UpdateCheckState, now: number, enabled: boolean): boolean {
	if (!enabled) return false;
	if (state.lastCheckAt === null) return true;
	// A clock set back in time counts as due, so a bad timestamp can't block checks forever.
	return now - state.lastCheckAt >= UPDATE_CHECK_INTERVAL_MS || now < state.lastCheckAt;
}

/** The status to show for `state` when running `current`. */
export function updateStatus(state: UpdateCheckState, current: string, enabled: boolean): UpdateStatus {
	if (!enabled) return { state: "off" };
	const newer = state.latest && (compareReleaseVersions(state.latest.version, current) ?? 0) > 0;
	return newer && state.latest
		? { state: "available", release: state.latest, lastCheckAt: state.lastCheckAt }
		: { state: "current", lastCheckAt: state.lastCheckAt };
}

/** Stored state from disk (any JSON), repaired to a valid value. */
export function parseUpdateCheckState(json: unknown): UpdateCheckState {
	if (!isRecord(json)) return EMPTY_UPDATE_STATE;
	const at = json["lastCheckAt"];
	const latest = json["latest"];
	const release =
		isRecord(latest) &&
		typeof latest["version"] === "string" &&
		parseVersion(latest["version"]) &&
		typeof latest["url"] === "string" &&
		latest["url"].startsWith(`${RELEASES_PAGE_URL}/`)
			? { version: latest["version"], url: latest["url"] }
			: null;
	return { lastCheckAt: typeof at === "number" && Number.isFinite(at) ? at : null, latest: release };
}
