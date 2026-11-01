import { Banner, nextIndex } from "@glimpse/ui";
import { createEffect, createSignal, For, type JSX, Match, onMount, Show, Switch } from "solid-js";
import type { SettingsClient } from "./client.ts";
import { AboutPane } from "./panes/AboutPane.tsx";
import { GeneralPane } from "./panes/GeneralPane.tsx";
import { LanguagesPane } from "./panes/LanguagesPane.tsx";
import { ModelsPane } from "./panes/ModelsPane.tsx";
import { PrivacyPane } from "./panes/PrivacyPane.tsx";
import { ProvidersPane } from "./panes/ProvidersPane.tsx";
import { ShortcutsPane } from "./panes/ShortcutsPane.tsx";
import { createSettingsState } from "./state.ts";

export const SECTIONS = [
	{ id: "general", label: "General" },
	{ id: "languages", label: "Languages" },
	{ id: "shortcuts", label: "Shortcuts" },
	{ id: "providers", label: "Providers" },
	{ id: "models", label: "Models" },
	{ id: "privacy", label: "Privacy" },
	{ id: "about", label: "About" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export interface SettingsAppProps {
	client: SettingsClient;
	initialSection?: SectionId;
	/** Called once the snapshot arrives (index.tsx applies the platform to <html>). */
	onReady?: (platform: "macos" | "windows" | "linux") => void;
}

/**
 * The Settings window (GLIM-69, docs/design/flows/settings.html, DESIGN.md Layout >
 * Settings): a 200px section list at inline-start and a scrolling pane. Changes apply as they
 * are made; there is no Save button. macOS draws the list as a sidebar with rounded
 * selection; Windows as a navigation view with the accent pill (see index.css).
 */
export function SettingsApp(props: SettingsAppProps): JSX.Element {
	const state = createSettingsState(props.client);
	const [section, setSection] = createSignal<SectionId>(props.initialSection ?? "general");
	const buttons: HTMLButtonElement[] = [];

	// The motion setting applies to this window too (DESIGN.md: `data-motion="reduced"`).
	createEffect(() => {
		const root = document.documentElement;
		if (state.settings()?.appearance.motion === "reduced") root.dataset["motion"] = "reduced";
		else delete root.dataset["motion"];
	});

	onMount(async () => {
		await state.load();
		const snap = state.snapshot();
		if (snap) props.onReady?.(snap.app.platform);
		void state.loadLanguages();
	});

	const select = (id: SectionId) => {
		setSection(id);
		const label = SECTIONS.find((s) => s.id === id)?.label ?? "";
		document.title = `${label} · Glimpse Settings`;
		document.getElementById("settings-pane")?.scrollTo({ top: 0 });
	};

	const onNavKey = (e: KeyboardEvent, index: number) => {
		const next = nextIndex(index, SECTIONS.length, e.key, "vertical", { wrap: false });
		if (next === null || next === index) return;
		e.preventDefault();
		const target = SECTIONS[next];
		if (!target) return;
		select(target.id);
		buttons[next]?.focus();
	};

	return (
		<div class="settings-shell flex h-dvh text-text-primary">
			<nav aria-label="Settings sections" class="settings-nav w-50 shrink-0 overflow-y-auto">
				<ul class="m-0 flex list-none flex-col gap-0.5 p-0">
					<For each={SECTIONS}>
						{(s, i) => (
							<li>
								<button
									ref={(el) => {
										buttons[i()] = el;
									}}
									type="button"
									class="settings-nav-item"
									aria-current={section() === s.id ? "page" : undefined}
									tabindex={section() === s.id ? 0 : -1}
									onClick={() => select(s.id)}
									onKeyDown={(e) => onNavKey(e, i())}
								>
									{s.label}
								</button>
							</li>
						)}
					</For>
				</ul>
			</nav>

			<main id="settings-pane" class="settings-pane min-w-0 flex-1 overflow-y-auto" aria-labelledby="pane-title">
				<div class="mx-auto max-w-160 p-6">
					<Show when={state.error()}>
						{(message) => (
							<div class="mb-5">
								<Banner tone="danger" title="Settings can't load" live>
									{message()}
								</Banner>
							</div>
						)}
					</Show>
					<Show when={state.snapshot() && state.settings()}>
						<Switch>
							<Match when={section() === "general"}>
								<GeneralPane state={state} />
							</Match>
							<Match when={section() === "languages"}>
								<LanguagesPane state={state} onManagePacks={() => select("models")} />
							</Match>
							<Match when={section() === "shortcuts"}>
								<ShortcutsPane state={state} />
							</Match>
							<Match when={section() === "providers"}>
								<ProvidersPane state={state} />
							</Match>
							<Match when={section() === "models"}>
								<ModelsPane state={state} />
							</Match>
							<Match when={section() === "privacy"}>
								<PrivacyPane state={state} />
							</Match>
							<Match when={section() === "about"}>
								<AboutPane state={state} />
							</Match>
						</Switch>
					</Show>
				</div>
			</main>
		</div>
	);
}
