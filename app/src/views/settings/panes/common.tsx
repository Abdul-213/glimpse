import { InlineMessage } from "@glimpse/ui";
import { createSignal, type JSX, Show } from "solid-js";
import type { ActionResult } from "../../../shared/settings-rpc.ts";

export function Pane(props: { title: string; children: JSX.Element }): JSX.Element {
	return (
		<>
			<h1 id="pane-title" class="m-0 mb-5 text-title">
				{props.title}
			</h1>
			{props.children}
		</>
	);
}

export type Os = "macos" | "windows" | "linux";

/** Words that differ per OS (docs/design/flows/settings.html P1-mac). */
export function osWords(os: Os) {
	const mac = os === "macos";
	return {
		fileManager: mac ? "Finder" : "File Explorer",
		trayPlace: mac ? "the menu bar" : "the notification area",
		keychain: mac ? "your Keychain" : "Windows Credential Manager",
		computer: mac ? "this Mac" : "this PC",
		signIn: mac ? "log in" : "sign in",
	};
}

/**
 * A button action with its outcome shown next to it: "Working…" while it runs, then a short
 * confirmation or the error in words. Returns [run, view].
 */
export function createAction(done?: string) {
	const [busy, setBusy] = createSignal(false);
	const [result, setResult] = createSignal<ActionResult | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = async (fn: () => Promise<ActionResult>) => {
		setBusy(true);
		setResult(null);
		clearTimeout(timer);
		try {
			setResult(await fn());
		} catch {
			setResult({ ok: false, message: "Glimpse didn't answer. Try again." });
		} finally {
			setBusy(false);
			timer = setTimeout(() => setResult(null), 4000);
		}
	};
	const view = () => (
		<Show when={result()}>
			{(r) => {
				const res = r();
				return res.ok ? (
					<Show when={done}>
						<span class="text-label text-text-secondary" role="status">
							{done}
						</span>
					</Show>
				) : (
					<InlineMessage tone="danger">{res.message}</InlineMessage>
				);
			}}
		</Show>
	);
	return { run, busy, view };
}

/** Options for a numeric setting, with the current value added if a hand-edit left it off the list. */
export function numberOptions(
	options: readonly { value: number; label: string }[],
	current: number,
	custom: (n: number) => string,
) {
	const list = options.map((o) => ({ value: String(o.value), label: o.label }));
	if (!options.some((o) => o.value === current)) list.push({ value: String(current), label: custom(current) });
	return list;
}
