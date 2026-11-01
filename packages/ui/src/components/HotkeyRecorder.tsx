import { createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { type Hotkey, hotkeyKeys, hotkeySpoken, recordStep, validateHotkey } from "../hotkey.ts";
import { currentPlatform, type UiPlatform } from "../platform.ts";
import { InlineMessage } from "./Field.tsx";
import { Kbd } from "./Kbd.tsx";

export interface HotkeyRecorderProps {
	/** What the shortcut does ("Snip"), for the accessible name. */
	label: string;
	value: Hotkey | null;
	onChange: (hotkey: Hotkey | null) => void;
	platform?: UiPlatform;
	/** Registration failure reported by the app process ("Another app already uses this shortcut."). */
	error?: string;
	recordingLabel?: string;
	emptyLabel?: string;
	disabled?: boolean;
}

/**
 * Shortcut recorder (DESIGN.md Settings controls; GLIM-23 validation). Activate, then press
 * a combo: modifiers preview as they're held, the first valid combo is saved, Esc cancels,
 * Backspace clears. Blocked combos show why and keep listening; warnings are kept with the
 * combo. Tab still moves focus, so the field never traps the keyboard.
 */
export function HotkeyRecorder(props: HotkeyRecorderProps): JSX.Element {
	const id = createUniqueId();
	const platform = () => props.platform ?? currentPlatform();
	const [recording, setRecording] = createSignal(false);
	const [preview, setPreview] = createSignal<Partial<Hotkey> | null>(null);
	const [blocked, setBlocked] = createSignal<string | null>(null);

	const stop = () => {
		setRecording(false);
		setPreview(null);
	};
	const warning = createMemo(() => {
		if (!props.value) return null;
		const v = validateHotkey(props.value, platform());
		return v.level === "warning" ? (v.message ?? null) : null;
	});
	const message = (): { tone: "danger" | "warning"; text: string } | null => {
		const b = blocked();
		if (b) return { tone: "danger", text: b };
		if (props.error) return { tone: "danger", text: props.error };
		const w = warning();
		return w ? { tone: "warning", text: w } : null;
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!recording()) return;
		const step = recordStep(e);
		switch (step.kind) {
			case "ignore":
				return;
			case "modifiers":
				setPreview(step.preview);
				break;
			case "cancel":
				setBlocked(null);
				stop();
				break;
			case "clear":
				setBlocked(null);
				props.onChange(null);
				stop();
				break;
			case "hotkey": {
				const verdict = validateHotkey(step.hotkey, platform());
				if (verdict.level === "blocked") {
					setBlocked(verdict.message ?? "This shortcut can't be used.");
					setPreview(null);
				} else {
					setBlocked(null);
					props.onChange(step.hotkey);
					stop();
				}
				break;
			}
		}
		e.preventDefault();
		e.stopPropagation();
	};

	const onKeyUp = (e: KeyboardEvent) => {
		if (!recording()) return;
		const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
		setPreview(mods.ctrl || mods.alt || mods.shift || mods.meta ? mods : null);
	};

	const spoken = () => (props.value ? hotkeySpoken(props.value, platform()) : (props.emptyLabel ?? "Not set"));

	return (
		<div class="flex flex-col gap-1">
			<button
				type="button"
				class="glim-field min-w-36 cursor-default"
				data-recording={recording() ? "" : undefined}
				aria-label={
					recording() ? `${props.label}: ${props.recordingLabel ?? "Type a shortcut"}` : `${props.label}: ${spoken()}`
				}
				aria-describedby={message() ? `hk-${id}` : undefined}
				disabled={props.disabled}
				onClick={() => {
					setBlocked(null);
					if (recording()) stop();
					else setRecording(true);
				}}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onBlur={stop}
			>
				<Show
					when={recording()}
					fallback={
						<Show
							when={props.value}
							fallback={<span class="text-text-secondary">{props.emptyLabel ?? "Not set"}</span>}
						>
							{(v) => <Kbd keys={hotkeyKeys(v(), platform())} platform={platform()} />}
						</Show>
					}
				>
					<Show when={preview()} fallback={<span>{props.recordingLabel ?? "Type a shortcut"}</span>}>
						{(p) => <Kbd keys={hotkeyKeys(p(), platform())} platform={platform()} />}
					</Show>
				</Show>
			</button>
			<Show when={message()}>
				{(m) => (
					<InlineMessage tone={m().tone} id={`hk-${id}`}>
						{m().text}
					</InlineMessage>
				)}
			</Show>
		</div>
	);
}
