import { type JSX, Show } from "solid-js";
import { ComponentsPage } from "./ComponentsPage.tsx";
import type { GalleryParams } from "./params.ts";

const OS_NAME = { macos: "macOS", windows: "Windows", linux: "Linux" } as const;

export function Gallery(props: { params: GalleryParams }): JSX.Element {
	const p = () => props.params;
	const variant = () =>
		[
			p().osVersion === "10" ? "Windows 10" : OS_NAME[p().os],
			p().dir === "rtl" ? "right-to-left UI" : "left-to-right UI",
			p().material === "native" ? "translucent veils" : "solid surfaces",
		].join(" · ");
	return (
		<div class="min-h-dvh bg-surface-window-solid px-8 py-6 text-text-primary">
			<header class="mb-6 flex flex-col gap-1">
				<h1 class="m-0 font-display text-title">Glimpse component gallery</h1>
				<p class="m-0 text-body text-text-secondary">{variant()}</p>
			</header>
			<Show when={p().page === "components"}>
				<ComponentsPage params={p()} />
			</Show>
		</div>
	);
}
