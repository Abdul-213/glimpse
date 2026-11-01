import { Button } from "@glimpse/ui";
import { createResource, type JSX, Show } from "solid-js";
import type { AppInfo, Platform } from "../../shared/rpc.ts";

const platformName: Record<Platform, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export interface SettingsAppProps {
	loadInfo: () => Promise<AppInfo>;
	onClose: () => void;
}

/**
 * Placeholder Settings shell (GLIM-28). It proves the stack end to end: Solid, the
 * DESIGN.md tokens, the shared Button and a typed RPC round trip. The real panes are
 * GLIM-69 and the tickets under it. Layout follows DESIGN.md Layout > Settings:
 * a 200px navigation list at inline-start, a scrolling pane with 24px padding.
 */
export function SettingsApp(props: SettingsAppProps): JSX.Element {
	const [info] = createResource(props.loadInfo);

	return (
		<div class="flex h-dvh bg-surface-popup-solid text-text-primary">
			<nav aria-label="Settings sections" class="w-50 shrink-0 border-e border-divider p-2">
				<ul class="m-0 flex list-none flex-col gap-0.5 p-0">
					<li>
						<a
							href="#general"
							aria-current="page"
							class="block rounded-control bg-overlay-selected px-2 py-1.5 text-body text-text-primary no-underline"
						>
							General
						</a>
					</li>
				</ul>
			</nav>

			<main id="general" class="min-w-0 flex-1 overflow-y-auto p-6">
				<h1 class="m-0 mb-5 font-display text-title">General</h1>

				<section aria-labelledby="about-heading" class="flex flex-col gap-2">
					<h2 id="about-heading" class="m-0 text-heading">
						About
					</h2>
					<div class="rounded-control border border-border-hairline bg-surface-group">
						<div class="flex items-center justify-between gap-3 p-3">
							<div class="flex min-w-0 flex-col gap-0.5">
								<span class="text-body">Glimpse {info()?.version ?? ""}</span>
								<Show when={info()} fallback={<span class="text-label text-text-secondary">Connecting…</span>}>
									{(i) => (
										<span class="text-label text-text-secondary tabular-nums">
											{platformName[i().platform]} · Electrobun {i().electrobun} · Bun {i().bun}
										</span>
									)}
								</Show>
								<Show when={info.error}>
									<span class="text-label text-danger">Couldn't reach the app process.</span>
								</Show>
							</div>
							<Button variant="secondary" onClick={() => props.onClose()}>
								Close
							</Button>
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}
