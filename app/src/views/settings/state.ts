// The Settings view's copy of main's state. It is a mirror, not a source of truth
// (ARCHITECTURE.md §5 rule 1): it holds what main last sent and replaces it with whatever main
// answers or pushes. Edits are sent as intents; nothing is applied optimistically except the
// value a control is already showing.
import type { Settings, UpdateStatus } from "@glimpse/core";
import { createSignal } from "solid-js";
import type {
	CloudSnapshot,
	HotkeyStatus,
	LoginItemStatus,
	ModelsSnapshot,
	SettingsEdit,
	SettingsSection,
	SettingsSnapshot,
	SourceLanguagesSnapshot,
} from "../../shared/settings-rpc.ts";
import type { SettingsClient } from "./client.ts";

export function createSettingsState(client: SettingsClient) {
	const [snapshot, setSnapshot] = createSignal<SettingsSnapshot | null>(null);
	const [settings, setSettings] = createSignal<Settings | null>(null);
	const [hotkeys, setHotkeys] = createSignal<HotkeyStatus | null>(null);
	const [loginItem, setLoginItem] = createSignal<LoginItemStatus | null>(null);
	const [models, setModels] = createSignal<ModelsSnapshot | null>(null);
	// Settings › Providers (GLIM-75): key status and cloud providers. Never a key.
	const [cloud, setCloud] = createSignal<CloudSnapshot | null>(null);
	const [languages, setLanguages] = createSignal<SourceLanguagesSnapshot | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	// GLIM-70: a newer release, from the snapshot and then `updateChanged`.
	const [update, setUpdate] = createSignal<UpdateStatus | null>(null);
	// A pane main asked for (GLIM-117): the first snapshot's `section`, then `showSection` pushes.
	// Wrapped so asking twice for the same pane still re-selects it.
	const [requestedSection, setRequestedSection] = createSignal<{ section: SettingsSection } | null>(null);

	client.listen({
		settingsChanged: (s) => setSettings(s),
		hotkeysChanged: (s) => setHotkeys(s),
		modelsChanged: (s) => setModels(s),
		cloudChanged: (s) => setCloud(s),
		updateChanged: (s) => setUpdate(s),
		showSection: (section) => setRequestedSection({ section }),
	});

	const load = async () => {
		try {
			const s = await client.request.getSnapshot();
			setSnapshot(s);
			setSettings(s.settings);
			setHotkeys(s.hotkeys);
			setLoginItem(s.loginItem);
			setUpdate(s.update);
			if (s.section) setRequestedSection({ section: s.section });
		} catch {
			setError("Couldn't reach the Glimpse app process. Close Settings and open it again from the tray.");
		}
	};

	return {
		snapshot,
		settings,
		hotkeys,
		loginItem,
		models,
		cloud,
		updateStatus: update,
		languages,
		error,
		requestedSection,
		load,
		client,
		async update(edit: SettingsEdit) {
			const r = await client.request.updateSettings(edit);
			setSettings(r.settings);
			return r;
		},
		async loadLanguages() {
			setLanguages(await client.request.getSourceLanguages());
		},
		async loadCloud() {
			setCloud(await client.request.getCloud());
		},
		setCloud,
		async loadModels() {
			setModels(await client.request.getModels());
		},
		setModels,
		setHotkeys,
		setSettings,
		setLoginItem,
	};
}

export type SettingsState = ReturnType<typeof createSettingsState>;
