import type { HotkeyAction, Settings } from "@glimpse/core";
import {
	Banner,
	Button,
	fromStoredHotkey,
	HotkeyRecorder,
	hotkeyLabel,
	SettingsGroup,
	SettingsRow,
	toStoredHotkey,
} from "@glimpse/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { SetHotkeyResult } from "../../../shared/settings-rpc.ts";
import type { SettingsState } from "../state.ts";
import { type Os, Pane } from "./common.tsx";

const ACTIONS: readonly { action: HotkeyAction; label: string; description: string }[] = [
	{ action: "snip", label: "Snip", description: "Select a region and translate it once." },
	{ action: "live", label: "Live", description: "Pin a region and keep translating it. Press again to stop." },
	{ action: "pauseLive", label: "Pause or resume Live", description: "Optional." },
	{ action: "resnip", label: "Snip the last region again", description: "Optional." },
	{ action: "toggleLivePopup", label: "Show or hide the Live popup", description: "Optional." },
	{
		action: "focusLivePopup",
		label: "Focus the Live popup",
		description: "Optional. Moves the keyboard to the popup's controls; Esc hands it back.",
	},
];

const labelOf = (a: HotkeyAction) => ACTIONS.find((x) => x.action === a)?.label ?? a;

interface Conflict {
	action: HotkeyAction;
	hotkey: string;
	owner: HotkeyAction;
}

/**
 * Settings › Shortcuts: one recorder per global action. The recorder blocks what GLIM-23
 * forbids before anything is sent; main checks Glimpse's own conflicts and asks the hotkey
 * service to register, and the status it reports (ready, used by another app) is what shows.
 */
export function ShortcutsPane(props: { state: SettingsState }): JSX.Element {
	const s = () => props.state.settings() as Settings;
	const os = () => (props.state.snapshot()?.app.platform ?? "macos") as Os;
	const [errors, setErrors] = createSignal<Partial<Record<HotkeyAction, string>>>({});
	const [conflict, setConflict] = createSignal<Conflict | null>(null);

	const applyResult = (action: HotkeyAction | null, r: SetHotkeyResult, hotkey: string | null) => {
		if (r.ok) {
			props.state.setSettings({ ...s(), hotkeys: r.bindings });
			props.state.setHotkeys(r.status);
			setErrors({});
			setConflict(null);
			return;
		}
		if (action && r.error === "conflict" && r.owner && hotkey) {
			setConflict({ action, hotkey, owner: r.owner });
			return;
		}
		if (action) setErrors({ ...errors(), [action]: r.message });
	};

	const set = async (action: HotkeyAction, hotkey: string | null, swap = false) => {
		setConflict(null);
		const r = await props.state.client.request.setHotkey({ action, hotkey, swap });
		applyResult(action, r, hotkey);
	};

	const errorFor = (action: HotkeyAction): string | undefined => {
		const local = errors()[action];
		if (local) return local;
		const status = props.state.hotkeys()?.[action];
		return status?.state === "failed" ? status.message : undefined;
	};

	const description = (a: (typeof ACTIONS)[number]) => {
		const status = props.state.hotkeys()?.[a.action];
		if (status?.state === "inactive") return `${a.description} Saved; Glimpse doesn't use this shortcut yet.`;
		if (status?.state === "unverified") {
			return `${a.description} macOS can't confirm it works inside every app; if it doesn't, change it here.`;
		}
		return a.description;
	};

	return (
		<Pane title="Shortcuts">
			<SettingsGroup
				title="Global shortcuts"
				footer="These work from any app. Keys inside Glimpse popups, such as Esc and Copy, are fixed. The tray menu works without any shortcut."
			>
				<For each={ACTIONS}>
					{(a) => (
						<SettingsRow label={a.label} description={description(a)}>
							<div class="w-44">
								<HotkeyRecorder
									label={a.label}
									platform={os()}
									value={fromStoredHotkey(s().hotkeys[a.action])}
									onChange={(h) => void set(a.action, h ? toStoredHotkey(h) : null)}
									error={errorFor(a.action)}
									emptyLabel="Not set"
								/>
							</div>
						</SettingsRow>
					)}
				</For>
			</SettingsGroup>

			<Show when={conflict()}>
				{(c) => {
					const h = fromStoredHotkey(c().hotkey);
					const shown = h ? hotkeyLabel(h, os()) : c().hotkey;
					return (
						<div class="mt-3">
							<Banner
								tone="warning"
								live
								title={`${shown} is already used for ${labelOf(c().owner)}`}
								actions={
									<>
										<Button variant="primary" onClick={() => void set(c().action, c().hotkey, true)}>
											Swap shortcuts
										</Button>
										<Button onClick={() => setConflict(null)}>Keep both as they are</Button>
									</>
								}
							>
								Swapping gives {labelOf(c().action)} this shortcut and {labelOf(c().owner)} the one{" "}
								{labelOf(c().action)} had.
							</Banner>
						</div>
					);
				}}
			</Show>

			<div class="mt-5 flex justify-end">
				<Button
					onClick={async () => {
						setConflict(null);
						applyResult(null, await props.state.client.request.resetHotkeys(), null);
					}}
				>
					Restore defaults
				</Button>
			</div>
		</Pane>
	);
}
