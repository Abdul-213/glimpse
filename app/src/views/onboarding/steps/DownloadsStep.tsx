import { Banner, Button, formatBytes, Icon, LanguagePicker, TextButton } from "@glimpse/ui";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import type { DownloadLanguage, DownloadsSnapshot } from "../../../shared/onboarding-rpc.ts";

export interface DownloadsStepProps {
	downloads: DownloadsSnapshot;
	busy: boolean;
	onToggle: (code: string, on: boolean) => void;
	onFindPacks: () => void;
	onStop: () => void;
}

/** What the row says at inline-end. */
function rowStatus(l: DownloadLanguage): string {
	switch (l.state) {
		case "ready":
			return "Ready";
		case "available":
			return formatBytes(l.bytes);
		case "downloading":
			return l.bytes > 0 ? `${Math.floor((l.done / l.bytes) * 100)}%` : "Waiting";
		case "failed":
			return "Download failed";
		case "unavailable":
			return "No pack yet";
	}
}

/**
 * Languages to read (flows O3a–O3c): tick the languages, see each one's size, download. The
 * download keeps going in the background while setup continues; real bytes, no spinner.
 */
export function DownloadsStep(props: DownloadsStepProps): JSX.Element {
	const d = () => props.downloads;
	const picked = createMemo(() => new Set<string>(d().picked));
	const listed = createMemo(() => new Set<string>(d().languages.map((l) => l.code)));
	const addable = createMemo(() => d().addable.filter((a) => !listed().has(a.code)));
	const needBytes = createMemo(() =>
		d()
			.languages.filter((l) => picked().has(l.code) && l.state === "available")
			.reduce((n, l) => n + l.bytes, 0),
	);
	const failed = createMemo(() => d().languages.find((l) => picked().has(l.code) && l.state === "failed"));
	const noCatalogue = () => d().catalogue === "idle" || d().catalogue === "offline" || d().catalogue === "loading";

	return (
		<>
			<Show when={noCatalogue()}>
				<Banner
					tone={d().catalogue === "offline" ? "warning" : "info"}
					title={
						d().catalogue === "offline"
							? "Glimpse couldn't reach the language pack list"
							: "Language packs aren't listed yet"
					}
					actions={
						<Button disabled={props.busy || d().catalogue === "loading"} onClick={() => props.onFindPacks()}>
							{d().catalogue === "loading" ? "Looking…" : "Find language packs"}
						</Button>
					}
				>
					{d().catalogue === "offline"
						? "Check your connection and try again, or skip this step and add languages later in Settings."
						: "Glimpse asks the language pack server once, then works offline."}
				</Banner>
			</Show>

			<fieldset class="glim-group m-0 border-0 p-0">
				<legend class="sr-only">Languages to read</legend>
				<For each={d().languages}>
					{(l) => {
						const on = () => picked().has(l.code);
						const disabled = () => l.state === "unavailable" || l.state === "ready";
						return (
							<label class="onboarding-choice" data-disabled={disabled() ? "" : undefined}>
								<input
									type="checkbox"
									class="sr-only"
									checked={on() || l.state === "ready"}
									disabled={disabled()}
									onChange={(e) => props.onToggle(l.code, e.currentTarget.checked)}
								/>
								<span class="glim-check" data-checked={on() || l.state === "ready" ? "" : undefined} aria-hidden="true">
									<Icon name="check" size={12} />
								</span>
								<span class="flex min-w-0 flex-1 items-baseline gap-2">
									<span class="truncate">{l.name}</span>
									<Show when={l.nativeName && l.nativeName !== l.name}>
										<span class="truncate text-text-secondary" lang={l.code} dir="auto">
											{l.nativeName}
										</span>
									</Show>
								</span>
								<span
									class="onboarding-status flex items-center gap-1 text-label"
									data-tone={l.state === "ready" ? "success" : undefined}
								>
									<Show when={l.state === "failed"}>
										<Icon name="alert" class="glim-tone-danger" />
									</Show>
									{rowStatus(l)}
								</span>
							</label>
						);
					}}
				</For>
			</fieldset>

			<Show when={addable().length > 0}>
				<div class="flex items-center gap-3">
					<span id="add-language" class="glim-label shrink-0">
						Add a language
					</span>
					<div class="min-w-0 flex-1">
						<LanguagePicker
							options={addable()}
							onChange={(code) => props.onToggle(code, true)}
							aria-labelledby="add-language"
							placeholder="Search languages"
						/>
					</div>
				</div>
			</Show>

			<Switch>
				<Match when={d().active}>
					<p class="m-0 max-w-measure text-label text-text-secondary">
						The download keeps going in the background while you finish setup.{" "}
						<TextButton onClick={() => props.onStop()}>Stop downloading</TextButton>
					</p>
				</Match>
				<Match when={failed()}>
					{(f) => (
						<Banner tone="danger" title={`${f().name} didn't download`}>
							{f().message ?? "Try again."}
						</Banner>
					)}
				</Match>
				<Match when={needBytes() > 0}>
					<p class="m-0 text-label text-text-secondary tabular-nums">
						To download: {formatBytes(needBytes())}
						<Show when={d().freeBytes !== null}> · {formatBytes(d().freeBytes ?? 0)} free</Show>
					</p>
				</Match>
			</Switch>
		</>
	);
}
