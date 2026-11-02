import { For, type JSX, Show } from "solid-js";
import type { UiPlatform } from "../platform.ts";

export interface KbdProps {
	/** One entry per key cap, already OS-formatted (see `hotkeyKeys`). */
	keys: readonly string[];
	platform: UiPlatform;
}

/**
 * DESIGN.md `kbd`: macOS shows one chip of glyphs ("⌃⇧S"), as its menus do; Windows shows
 * one chip per key ("Alt" "Shift" "S"), as its shortcut hints do.
 */
export function Kbd(props: KbdProps): JSX.Element {
	return (
		<Show
			when={props.platform !== "macos"}
			fallback={
				<kbd class="glim-kbd" dir="ltr">
					{props.keys.join("")}
				</kbd>
			}
		>
			<span class="inline-flex items-center gap-0.5" dir="ltr">
				{/* The spaces keep the text "Alt Shift S", matching the accessible name (WCAG 2.5.3);
				    flex layout ignores them. */}
				<For each={props.keys}>
					{(k, i) => (
						<>
							{i() > 0 ? " " : ""}
							<kbd class="glim-kbd">{k}</kbd>
						</>
					)}
				</For>
			</span>
		</Show>
	);
}
