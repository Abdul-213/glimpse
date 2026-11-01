import type { HotkeyAction, HotkeyBindings } from "@glimpse/core";
import { fromStoredHotkey, HotkeyRecorder, Icon, toStoredHotkey, type UiPlatform } from "@glimpse/ui";
import { For, type JSX, Show } from "solid-js";
import type { HotkeyRegistration, HotkeyStatus } from "../../../shared/settings-rpc.ts";

const ROWS: readonly { action: HotkeyAction; label: string; description: string }[] = [
	{ action: "snip", label: "Snip", description: "Select a region and translate it once." },
	{ action: "live", label: "Live", description: "Pin a region and keep translating it." },
];

export interface ShortcutsStepProps {
	bindings: HotkeyBindings;
	status: HotkeyStatus;
	platform: UiPlatform;
	errors: Partial<Record<HotkeyAction, string>>;
	onChange: (action: HotkeyAction, hotkey: string | null) => void;
}

function statusText(r: HotkeyRegistration | undefined): { text: string; ok: boolean } | null {
	switch (r?.state) {
		case "ready":
			return { text: "Ready. Try it now.", ok: true };
		case "unverified":
			return { text: "Saved. Try it now.", ok: true };
		case "inactive":
			return { text: "Saved", ok: true };
		case "unbound":
			return { text: "No shortcut", ok: false };
		case "failed":
			return { text: r.message, ok: false };
		default:
			return null;
	}
}

/**
 * Shortcuts with live status (flows O4a/O4b): the recorder from Settings, and the hotkey
 * service's real answer under each. Pressing one opens the real picker (Esc to come back).
 */
export function ShortcutsStep(props: ShortcutsStepProps): JSX.Element {
	return (
		<div class="glim-group">
			<For each={ROWS}>
				{(row) => {
					const s = () => statusText(props.status[row.action]);
					const error = () => props.errors[row.action] ?? (s()?.ok === false ? s()?.text : undefined);
					return (
						<div class="glim-row items-start">
							<div class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="glim-label">{row.label}</span>
								<span class="glim-description">{row.description}</span>
								<Show when={s()?.ok}>
									<span class="flex items-center gap-1 text-label text-text-secondary" role="status">
										<Icon name="check" class="glim-tone-success" />
										{s()?.text}
									</span>
								</Show>
							</div>
							<div class="w-48 shrink-0">
								<HotkeyRecorder
									label={row.label}
									platform={props.platform}
									value={fromStoredHotkey(props.bindings[row.action])}
									onChange={(h) => props.onChange(row.action, h ? toStoredHotkey(h) : null)}
									{...(error() ? { error: error() } : {})}
								/>
							</div>
						</div>
					);
				}}
			</For>
		</div>
	);
}
