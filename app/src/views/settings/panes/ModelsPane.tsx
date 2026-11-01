import {
	Banner,
	Button,
	formatBytes,
	IconButton,
	InlineMessage,
	LanguagePicker,
	ProgressBar,
	SettingsGroup,
	SettingsRow,
	TextButton,
} from "@glimpse/ui";
import { createSignal, For, type JSX, Match, onMount, Show, Switch } from "solid-js";
import type { ActionResult, ModelRow, ModelsSnapshot } from "../../../shared/settings-rpc.ts";
import type { SettingsState } from "../state.ts";
import { createAction, type Os, osWords, Pane } from "./common.tsx";

/**
 * Settings › Models (GLIM-69, GLIM-96): what is installed, how big it is, where it lives.
 * Downloads only start from a button here (or a popup's Download), and the pack list is only
 * fetched when the user asks for it.
 */
export function ModelsPane(props: { state: SettingsState }): JSX.Element {
	const os = () => (props.state.snapshot()?.app.platform ?? "macos") as Os;
	const m = () => props.state.models();
	const folder = createAction();
	const [rowErrors, setRowErrors] = createSignal<Record<string, string>>({});
	const [addError, setAddError] = createSignal<string | null>(null);

	onMount(() => void props.state.loadModels());

	const act = async (id: string, fn: () => Promise<ActionResult>) => {
		const r = await fn();
		const { [id]: _, ...rest } = rowErrors();
		setRowErrors(r.ok ? rest : { ...rest, [id]: r.message });
	};
	const request = props.state.client.request;

	const ocrRows = () => m()?.rows.filter((r) => r.kind === "ocr") ?? [];
	const translationRows = () => m()?.rows.filter((r) => r.kind !== "ocr") ?? [];

	return (
		<Pane title="Models">
			<Show when={m()} fallback={<p class="glim-description">Reading the models folder…</p>}>
				{(snap) => (
					<>
						<SettingsGroup title="Storage">
							<SettingsRow
								label="Models folder"
								description={
									<>
										<span class="block [overflow-wrap:anywhere]" dir="ltr">
											{snap().directory}
										</span>
										{folder.view()}
									</>
								}
							>
								<div class="flex gap-2">
									<Button onClick={() => void folder.run(() => request.revealModelsDirectory())}>
										Show in {osWords(os()).fileManager}
									</Button>
									<Button
										disabled={snap().moving || folder.busy()}
										onClick={() => void folder.run(() => request.chooseModelsDirectory())}
									>
										Change…
									</Button>
								</div>
							</SettingsRow>
							<SettingsRow label="Space used" description={spaceLine(snap())}>
								<Show when={!snap().isDefaultDirectory}>
									<Button
										disabled={snap().moving || folder.busy()}
										onClick={() => void folder.run(() => request.resetModelsDirectory())}
									>
										Use default folder
									</Button>
								</Show>
							</SettingsRow>
							<Show when={snap().moving}>
								<div class="glim-row" role="status">
									<span class="glim-description">Moving models… Downloads can start again once it finishes.</span>
								</div>
							</Show>
						</SettingsGroup>

						<SettingsGroup
							title="Text recognition"
							footer="Built-in readers ship with Glimpse. The others download when you first need them."
						>
							<For each={ocrRows()}>
								{(row) => (
									<ModelRowView
										row={row}
										error={rowErrors()[row.id]}
										onDownload={() => void act(row.id, () => request.downloadModel({ id: row.id }))}
										onCancel={() => void act(row.id, () => request.cancelModelDownload({ id: row.id }))}
										onRemove={() => void act(row.id, () => request.removeModel({ id: row.id }))}
									/>
								)}
							</For>
						</SettingsGroup>

						<SettingsGroup
							title="Translation"
							footer="Language packs come from Mozilla's Firefox Translations. Most languages need two packs: one into English and one out of it."
						>
							<For each={translationRows()}>
								{(row) => (
									<ModelRowView
										row={row}
										error={rowErrors()[row.id]}
										onDownload={() => void act(row.id, () => request.downloadModel({ id: row.id }))}
										onCancel={() => void act(row.id, () => request.cancelModelDownload({ id: row.id }))}
										onRemove={() => void act(row.id, () => request.removeModel({ id: row.id }))}
									/>
								)}
							</For>
							<SettingsRow label="Add a language" description={catalogueLine(snap().catalogue)}>
								{(ids) => (
									<Switch>
										<Match when={snap().catalogue === "idle" || snap().catalogue === "offline"}>
											<Button onClick={async () => props.state.setModels(await request.loadPackCatalogue())}>
												{snap().catalogue === "offline" ? "Try again" : "Find language packs"}
											</Button>
										</Match>
										<Match when={snap().catalogue === "loading"}>
											<span class="text-label text-text-secondary" role="status">
												Looking…
											</span>
										</Match>
										<Match when={true}>
											<div class="w-56">
												<LanguagePicker
													aria-labelledby={ids.labelId}
													options={snap().addable.map((a) => ({ ...a }))}
													placeholder="Choose a language"
													onChange={async (code) => {
														const r = await request.addLanguagePacks({ language: code });
														setAddError(r.ok ? null : r.message);
													}}
												/>
											</div>
										</Match>
									</Switch>
								)}
							</SettingsRow>
							<Show when={addError()}>
								{(e) => (
									<div class="glim-row">
										<InlineMessage tone="danger">{e()}</InlineMessage>
									</div>
								)}
							</Show>
						</SettingsGroup>

						<Show when={snap().freeBytes !== null && (snap().freeBytes ?? 0) < 512 * 1024 * 1024}>
							<div class="mt-5">
								<Banner tone="warning" title="The models folder's disk is nearly full">
									Downloads need room for the files plus a little extra. Free some space or move the models folder to
									another disk.
								</Banner>
							</div>
						</Show>
					</>
				)}
			</Show>
		</Pane>
	);
}

function spaceLine(s: ModelsSnapshot): string {
	const used = s.usedBytes > 0 ? `${formatBytes(s.usedBytes)} downloaded` : "Nothing downloaded yet";
	return s.freeBytes === null ? used : `${used} · ${formatBytes(s.freeBytes)} free on this disk`;
}

function catalogueLine(c: ModelsSnapshot["catalogue"]): string {
	switch (c) {
		case "idle":
			return "Gets the list of packs from Mozilla. Nothing about you or your screen is sent.";
		case "loading":
			return "Getting the list of packs…";
		case "cached":
			return "Couldn't connect, so this is the list from last time.";
		case "offline":
			return "Couldn't connect. Check your connection and try again.";
		case "ready":
			return "Downloads the packs needed to translate it into your language.";
	}
}

interface ModelRowViewProps {
	row: ModelRow;
	error?: string | undefined;
	onDownload: () => void;
	onCancel: () => void;
	onRemove: () => void;
}

function ModelRowView(props: ModelRowViewProps): JSX.Element {
	const st = () => props.row.state;
	const description = () => {
		const s = st();
		const size = formatBytes(props.row.bytes);
		switch (s.status) {
			case "installed":
				return s.bundled ? `Built in · ${size}` : `Downloaded · ${size}`;
			case "missing":
				return props.row.detail ? `${props.row.detail} · ${size} download` : `${size} download`;
			case "queued":
				return "Waiting to download";
			case "verifying":
				return "Checking the download…";
			case "downloading":
				return undefined;
			case "failed":
				return undefined;
		}
	};
	return (
		<div class="glim-row">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span class="glim-label">{props.row.name}</span>
				<Show when={description()}>
					<p class="glim-description">{description()}</p>
				</Show>
				<Show when={st().status === "downloading" ? st() : null}>
					{(d) => {
						const dl = d() as Extract<ModelRow["state"], { status: "downloading" }>;
						return (
							<div class="mt-1 max-w-80">
								<ProgressBar label={`Downloading ${props.row.name}`} done={dl.done} total={dl.total} />
							</div>
						);
					}}
				</Show>
				<Show when={st().status === "failed" ? st() : null}>
					{(f) => (
						<InlineMessage tone="danger">
							{(f() as Extract<ModelRow["state"], { status: "failed" }>).message}
						</InlineMessage>
					)}
				</Show>
				<Show when={props.error}>
					<InlineMessage tone="danger">{props.error ?? ""}</InlineMessage>
				</Show>
			</div>
			<div class="flex shrink-0 items-center">
				<Switch>
					<Match when={st().status === "installed" && !(st() as { bundled: boolean }).bundled}>
						<TextButton onClick={() => props.onRemove()}>Remove</TextButton>
					</Match>
					<Match when={st().status === "missing"}>
						<Button onClick={() => props.onDownload()}>Download</Button>
					</Match>
					<Match when={st().status === "failed"}>
						<Button onClick={() => props.onDownload()}>Try again</Button>
					</Match>
					<Match when={st().status === "downloading" || st().status === "queued"}>
						<IconButton icon="close" label={`Cancel ${props.row.name} download`} onClick={() => props.onCancel()} />
					</Match>
				</Switch>
			</div>
		</div>
	);
}
