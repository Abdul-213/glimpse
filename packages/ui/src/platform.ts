export type UiPlatform = "macos" | "windows" | "linux";

/**
 * Tell the theme which OS it is on. DESIGN.md: the shell sets `data-os` on <html>,
 * which swaps radii, control height and body size for Windows.
 */
export function applyPlatform(platform: UiPlatform, root: HTMLElement = document.documentElement): void {
	root.dataset["os"] = platform;
}
