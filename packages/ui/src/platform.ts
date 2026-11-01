export type UiPlatform = "macos" | "windows" | "linux";

/** Whether the window behind the webview has a working native material (DESIGN.md Token mapping). */
export type UiMaterial = "native" | "none";

export interface PlatformOptions {
	/** Windows 10 gets square popups (`data-os-version="10"`). Pass the major version. */
	osVersion?: string;
	/** `native` paints the translucent veils; `none` the solid surfaces. Default: leave as is. */
	material?: UiMaterial;
	/** Glimpse's own motion preference; `reduced` behaves like the OS reduced-motion setting. */
	motion?: "system" | "reduced";
	root?: HTMLElement;
}

/**
 * Tell the theme which OS it is on. DESIGN.md: the shell sets `data-os` on <html>, which
 * swaps radii, control height and body size for Windows, plus `data-os-version`,
 * `data-material` and `data-motion` when it knows them.
 */
export function applyPlatform(platform: UiPlatform, options: PlatformOptions = {}): void {
	const root = options.root ?? document.documentElement;
	root.dataset["os"] = platform;
	if (options.osVersion !== undefined) root.dataset["osVersion"] = options.osVersion;
	if (options.material !== undefined) root.dataset["material"] = options.material;
	if (options.motion === "reduced") root.dataset["motion"] = "reduced";
	else if (options.motion === "system") delete root.dataset["motion"];
}

/** Read the platform back from the DOM (components that format keys need it). */
export function currentPlatform(root: HTMLElement = document.documentElement): UiPlatform {
	const os = root.dataset["os"];
	return os === "windows" || os === "linux" ? os : "macos";
}
