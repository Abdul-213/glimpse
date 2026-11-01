// Gallery URL parameters, so a plain browser (or the screenshot script) can pick the
// variant without the desktop shell: ?os=windows&dir=rtl&material=native&page=scripts
// Appearance follows the browser's light/dark setting (Bun lowers light-dark() to
// prefers-color-scheme), so use the browser's or DevTools' emulation to switch it.
import type { UiPlatform } from "@glimpse/ui";

export interface GalleryParams {
	os: UiPlatform;
	/** "10" for Windows 10 (square popups). */
	osVersion?: string;
	dir: "ltr" | "rtl";
	material: "native" | "none";
	page: "components" | "scripts";
}

export function parseGalleryParams(search: string): GalleryParams {
	const q = new URLSearchParams(search);
	const osParam = q.get("os");
	const os: UiPlatform =
		osParam === "windows" || osParam === "win10" ? "windows" : osParam === "linux" ? "linux" : "macos";
	const params: GalleryParams = {
		os,
		dir: q.get("dir") === "rtl" ? "rtl" : "ltr",
		material: q.get("material") === "native" ? "native" : "none",
		page: q.get("page") === "scripts" ? "scripts" : "components",
	};
	if (osParam === "win10") params.osVersion = "10";
	return params;
}
