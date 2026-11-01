import {
	Banner,
	Button,
	EgressBadge,
	Icon,
	LocalIndicator,
	SecretField,
	Select,
	SettingsGroup,
	SettingsRow,
	TextButton,
} from "@glimpse/ui";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import type {
	ApiKeyStatus,
	CloudActionResult,
	CloudLink,
	CloudProviderStatus,
	CloudSnapshot,
	CloudTask,
	ProviderSummary,
} from "../../../shared/settings-rpc.ts";
import type { SettingsState } from "../state.ts";
import { type Os, osWords, Pane } from "./common.tsx";

const LOCAL = "local";

function names(list: readonly ProviderSummary[]): string {
	return list.map((p) => p.name).join(", then ");
}

/** "just now" for the last minute, else the time of day. */
function checkedAt(at: number): string {
	const age = Date.now() - at;
	if (age < 60_000) return "checked just now";
	return `checked at ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

const TASK_WORDS: Record<CloudTask, { label: string; verb: string }> = {
	ocr: { label: "Read text with", verb: "Read text with" },
	translation: { label: "Translate with", verb: "Translate with" },
};

/** What leaves the device when a cloud provider does this task (flows settings.html P2, GLIM-22). */
function sendsCopy(p: CloudProviderStatus, os: Os): string {
	const computer = osWords(os).computer;
	return p.sends === "image"
		? `An image of the area you select is sent to ${p.name} each time you Snip, and each time pinned Live text changes. Text and images leave ${computer}.`
		: `Text read from your screen is sent to ${p.name} each time you Snip, and each time pinned Live text changes. Images are never sent.`;
}

/**
 * Settings › Providers (GLIM-75, docs/design/flows/settings.html P1/P2).
 *
 * - Per task: this computer or a cloud provider. A cloud choice needs a saved key and an
 *   explicit "Use ‹Provider›" confirmation; main enforces both.
 * - The key: pasted once, saved to the OS keychain by main, never sent back. The view only
 *   ever shows saved / not saved, the last four characters and "Test key" results.
 * - Live: whether Live will ask before sending (live-popup.md L10, GLIM-94 #16 defaults).
 */
export function ProvidersPane(props: { state: SettingsState }): JSX.Element {
	const snap = () => props.state.snapshot();
	const os = () => (snap()?.app.platform ?? "macos") as Os;
	const cloud = () => props.state.cloud();
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		props.state.loadCloud().catch(() => setError("Couldn't load cloud providers. Close Settings and open it again."));
	});

	/** Apply a result: the fresh snapshot always comes back, success or not. */
	const apply = (r: CloudActionResult): CloudActionResult => {
		props.state.setCloud(r.cloud);
		return r;
	};

	return (
		<Pane title="Providers">
			<Show when={error()}>
				{(message) => (
					<div class="mb-5">
						<Banner tone="danger" title="Cloud providers are unavailable" live>
							{message()}
						</Banner>
					</div>
				)}
			</Show>
			<Show when={cloud()} fallback={<LocalOnly state={props.state} os={os()} />}>
				{(c) => (
					<>
						<TaskGroup cloud={c()} os={os()} apply={apply} state={props.state} />
						<For each={c().keys}>
							{(key) => <KeyGroup cloud={c()} keyStatus={key} os={os()} apply={apply} state={props.state} />}
						</For>
						<GuideGroup state={props.state} />
						<LiveGroup cloud={c()} apply={apply} state={props.state} />
					</>
				)}
			</Show>
		</Pane>
	);
}

/** Before the cloud snapshot arrives (or if it can't): what runs on this computer. */
function LocalOnly(props: { state: SettingsState; os: Os }): JSX.Element {
	const ocr = () => props.state.snapshot()?.providers.ocr ?? null;
	const translation = () => props.state.snapshot()?.providers.translation ?? [];
	return (
		<SettingsGroup title="Read and translate">
			<SettingsRow label="Read text with" description={ocr()?.name ?? "No text reader is installed in this build."} />
			<SettingsRow
				label="Translate with"
				description={translation().length > 0 ? names(translation()) : "No translator is installed in this build."}
			/>
		</SettingsGroup>
	);
}

interface GroupProps {
	cloud: CloudSnapshot;
	os: Os;
	state: SettingsState;
	apply: (r: CloudActionResult) => CloudActionResult;
}

function TaskGroup(props: GroupProps): JSX.Element {
	/** A cloud provider the user picked and hasn't confirmed yet. */
	const [pending, setPending] = createSignal<CloudProviderStatus | null>(null);
	const [message, setMessage] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);

	const forTask = (task: CloudTask) => props.cloud.providers.filter((p) => p.task === task);
	const selected = (task: CloudTask) => forTask(task).find((p) => p.selected) ?? null;
	const keySaved = (p: CloudProviderStatus) => props.cloud.keys.some((k) => k.secretId === p.secretId && k.saved);
	const localName = (task: CloudTask) =>
		task === "ocr" ? (props.cloud.local.ocr?.name ?? "No text reader installed") : names(props.cloud.local.translation);
	const inUse = () => props.cloud.providers.filter((p) => p.selected);

	const options = (task: CloudTask) => [
		{ value: LOCAL, label: `On this computer` },
		...forTask(task).map((p) => ({
			value: p.id,
			label: keySaved(p) ? `${p.name} (cloud)` : `${p.name} (add a key first)`,
			disabled: !keySaved(p),
		})),
	];

	const send = async (task: CloudTask, id: string | null) => {
		setBusy(true);
		setMessage(null);
		try {
			const r = props.apply(await props.state.client.request.setProvider({ task, id, confirmed: id !== null }));
			if (!r.ok) setMessage(r.message);
		} catch {
			setMessage("Glimpse didn't answer. Try again.");
		} finally {
			setBusy(false);
			setPending(null);
		}
	};

	const choose = (task: CloudTask, value: string) => {
		setMessage(null);
		if (value === LOCAL) {
			setPending(null);
			if (selected(task)) void send(task, null);
			return;
		}
		const p = forTask(task).find((x) => x.id === value);
		if (p && !p.selected) setPending(p);
	};

	const row = (task: CloudTask) => (
		<SettingsRow
			label={TASK_WORDS[task].label}
			description={
				<span class="flex flex-col items-start gap-1.5">
					<Show when={selected(task)} fallback={<span>{localName(task)}</span>}>
						{(p) => (
							<span>
								{p().name}, using your {p().vendor} key
							</span>
						)}
					</Show>
					<Show when={selected(task)} fallback={<LocalIndicator />}>
						{(p) => <EgressBadge provider={p().vendor} label={p().sends === "image" ? "Sends images" : "Sends text"} />}
					</Show>
				</span>
			}
		>
			{(ids) => (
				<div class="w-64">
					<Select
						aria-labelledby={ids.labelId}
						value={pending()?.task === task ? (pending()?.id ?? LOCAL) : (selected(task)?.id ?? LOCAL)}
						options={options(task)}
						disabled={busy()}
						onChange={(v) => choose(task, v)}
					/>
				</div>
			)}
		</SettingsRow>
	);

	return (
		<SettingsGroup
			title="Read and translate"
			footer={
				<Show
					when={inUse().length > 0}
					fallback={
						<>Text from your screen is read and translated on {osWords(props.os).computer}. Nothing is sent anywhere.</>
					}
				>
					<>
						{inUse()
							.map((p) => sendsCopy(p, props.os))
							.join(" ")}{" "}
						Every result says where it went.
					</>
				</Show>
			}
		>
			{row("ocr")}
			{row("translation")}
			<Show when={pending()}>
				{(p) => (
					<div class="glim-row block">
						<Banner
							tone="info"
							title={`${TASK_WORDS[p().task].verb} ${p().name}?`}
							actions={
								<>
									<Button variant="primary" disabled={busy()} onClick={() => void send(p().task, p().id)}>
										Use {p().name}
									</Button>
									<Button disabled={busy()} onClick={() => setPending(null)}>
										Stay on this computer
									</Button>
								</>
							}
						>
							{sendsCopy(p(), props.os)} Results will be marked “Sent to {p().vendor}”.
						</Banner>
					</div>
				)}
			</Show>
			<Show when={message()}>
				{(m) => (
					<div class="glim-row">
						<p class="glim-inline-message m-0" data-tone="danger" role="alert">
							<Icon name="alert" class="mt-px" />
							<span>{m()}</span>
						</p>
					</div>
				)}
			</Show>
		</SettingsGroup>
	);
}

function KeyGroup(props: GroupProps & { keyStatus: ApiKeyStatus }): JSX.Element {
	const k = () => props.keyStatus;
	const [draft, setDraft] = createSignal("");
	const [replacing, setReplacing] = createSignal(false);
	const [fieldError, setFieldError] = createSignal<string | undefined>(undefined);
	const [busy, setBusy] = createSignal<"save" | "test" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = createSignal(false);
	const [message, setMessage] = createSignal<string | null>(null);
	const words = () => osWords(props.os);
	const editing = () => !k().saved || replacing();
	const keychainOk = () => props.cloud.keychain.available;
	const keychainProblem = () => {
		const kc = props.cloud.keychain;
		return kc.available ? null : kc.message;
	};

	const run = async (what: "save" | "test" | "remove", fn: () => Promise<CloudActionResult>) => {
		setBusy(what);
		setMessage(null);
		try {
			const r = props.apply(await fn());
			if (!r.ok) {
				if (what === "save") setFieldError(r.message);
				else setMessage(r.message);
			}
			return r.ok;
		} catch {
			setMessage("Glimpse didn't answer. Try again.");
			return false;
		} finally {
			setBusy(null);
		}
	};

	const save = async (e: SubmitEvent) => {
		e.preventDefault();
		setFieldError(undefined);
		const key = draft();
		// The pasted key leaves the view once, here, and is forgotten right after.
		const ok = await run("save", () => props.state.client.request.saveApiKey({ secretId: k().secretId, key }));
		if (ok) {
			setDraft("");
			setReplacing(false);
			void run("test", () => props.state.client.request.testApiKey({ secretId: k().secretId }));
		}
	};

	const remove = async () => {
		setConfirmRemove(false);
		await run("remove", () => props.state.client.request.removeApiKey({ secretId: k().secretId }));
	};

	const status = () =>
		k().saved
			? `Saved in ${words().keychain}${k().hint ? `, ending ${k().hint?.replace("…", "")}` : ""}.`
			: `No key saved. ${k().usedBy.join(" and ")} stay off until you add one.`;

	return (
		<SettingsGroup
			title={k().label}
			footer={
				<>
					Stored only in {words().keychain}, never in a file. Glimpse sends it only to {k().vendor}. {k().vendor} says
					it doesn't use what you send to train its models, and doesn't keep text or images after answering.{" "}
					<LinkButton state={props.state} link="terms">
						Read {k().vendor}'s data terms
					</LinkButton>
				</>
			}
		>
			<Show when={keychainProblem()}>
				{(message) => (
					<div class="glim-row block">
						<Banner tone="danger" title="Keys can't be saved on this computer">
							{message()} Glimpse never stores keys anywhere else.
						</Banner>
					</div>
				)}
			</Show>
			<SettingsRow label="API key" description={status()}>
				<Show when={k().saved && !replacing()}>
					<div class="flex items-center gap-2">
						<Button
							disabled={busy() !== null}
							onClick={() => void run("test", () => props.state.client.request.testApiKey({ secretId: k().secretId }))}
						>
							{busy() === "test" ? "Testing…" : "Test key"}
						</Button>
						<Button disabled={busy() !== null} onClick={() => setReplacing(true)}>
							Replace…
						</Button>
						<Button disabled={busy() !== null} onClick={() => setConfirmRemove(true)}>
							Remove
						</Button>
					</div>
				</Show>
			</SettingsRow>

			<Show when={editing() && keychainOk()}>
				<div class="glim-row block">
					<form class="flex items-start gap-2" onSubmit={(e) => void save(e)}>
						<div class="min-w-0 flex-1">
							<SecretField
								label={replacing() ? "New API key" : "Paste your API key"}
								hideLabel
								placeholder={replacing() ? "Paste the new key" : "Paste your API key"}
								value={draft()}
								onChange={(v) => {
									setDraft(v);
									setFieldError(undefined);
								}}
								error={fieldError()}
								name="api-key"
							/>
						</div>
						<Button type="submit" variant="primary" disabled={busy() !== null || draft().trim() === ""}>
							{busy() === "save" ? "Saving…" : "Save"}
						</Button>
						<Show when={replacing()}>
							<Button
								onClick={() => {
									setReplacing(false);
									setDraft("");
									setFieldError(undefined);
								}}
							>
								Cancel
							</Button>
						</Show>
					</form>
				</div>
			</Show>

			<Show when={confirmRemove()}>
				<div class="glim-row block">
					<Banner
						tone="warning"
						title={`Remove your ${k().vendor} key?`}
						actions={
							<>
								<Button variant="primary" onClick={() => void remove()}>
									Remove key
								</Button>
								<Button onClick={() => setConfirmRemove(false)}>Keep it</Button>
							</>
						}
					>
						It is deleted from {words().keychain}. Anything set to use {k().usedBy.join(" or ")} goes back to{" "}
						{words().computer}.
					</Banner>
				</div>
			</Show>

			<Show when={k().saved && (busy() === "test" || k().lastTest)}>
				<div class="glim-row block" aria-live="polite">
					<Show
						when={busy() !== "test" && k().lastTest}
						fallback={
							<p class="m-0 text-label text-text-secondary">
								Checking with {k().vendor}. Nothing from your screen is sent.
							</p>
						}
					>
						{(t) => (
							<div class="flex flex-col gap-1.5">
								<For each={t().checks}>
									{(c) => (
										<p class="m-0 flex items-start gap-2 text-label">
											<Icon
												name={c.ok ? "success" : "alert"}
												class={`mt-px shrink-0 ${c.ok ? "glim-tone-success" : "glim-tone-danger"}`}
											/>
											<span>
												<span class="font-semibold">{c.name}:</span>{" "}
												{c.ok ? "the key works." : <span class="text-text-secondary">{c.message}</span>}
											</span>
										</p>
									)}
								</For>
								<p class="m-0 text-label text-text-secondary">
									{t().ok ? "Key works" : "Some checks failed"}, {checkedAt(t().at)}.
								</p>
							</div>
						)}
					</Show>
				</div>
			</Show>

			<Show when={message()}>
				{(m) => (
					<div class="glim-row">
						<p class="glim-inline-message m-0" data-tone="danger" role="alert">
							<Icon name="alert" class="mt-px" />
							<span>{m()}</span>
						</p>
					</div>
				)}
			</Show>
		</SettingsGroup>
	);
}

function LinkButton(props: { state: SettingsState; link: CloudLink; children: JSX.Element }): JSX.Element {
	return (
		<TextButton onClick={() => void props.state.client.request.openCloudLink({ link: props.link })}>
			{props.children}
		</TextButton>
	);
}

/** How to get a key (GLIM-22: one key, restricted to the two APIs). */
function GuideGroup(props: { state: SettingsState }): JSX.Element {
	const steps: JSX.Element[] = [
		<>Sign in to the Google Cloud console and create a project (or pick one).</>,
		<>
			Turn on billing for the project. Google asks for a card even for the free tier: 1,000 images and 500,000
			characters a month, as of October 2026.
		</>,
		<>
			Enable the <span class="font-semibold">Cloud Translation API</span>, and the{" "}
			<span class="font-semibold">Cloud Vision API</span> if you want text read in the cloud.
		</>,
		<>
			Under APIs &amp; Services › Credentials, create an API key. Restrict it to those two APIs and set no application
			restriction.
		</>,
		<>Paste the key above, then choose Test key.</>,
	];
	return (
		<SettingsGroup title="How to get a key">
			<div class="glim-row block">
				<ol class="m-0 flex list-decimal flex-col gap-1.5 ps-5 text-body">
					<For each={steps}>{(s) => <li class="ps-1">{s}</li>}</For>
				</ol>
				<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1">
					<LinkButton state={props.state} link="console">
						Open the Google Cloud console
					</LinkButton>
					<LinkButton state={props.state} link="credentials">
						Open Credentials
					</LinkButton>
					<LinkButton state={props.state} link="pricing">
						Translation pricing
					</LinkButton>
				</div>
			</div>
		</SettingsGroup>
	);
}

/** Live's cloud consent (live-popup.md L10; GLIM-94 #16 defaults). */
function LiveGroup(props: Omit<GroupProps, "os">): JSX.Element {
	const [busy, setBusy] = createSignal(false);
	const remembered = () =>
		props.cloud.providers.filter((p) => p.task === "translation" && props.cloud.liveConsent.includes(p.id));
	const reset = async () => {
		setBusy(true);
		try {
			props.apply(await props.state.client.request.resetLiveConsent());
		} finally {
			setBusy(false);
		}
	};
	return (
		<SettingsGroup
			title="Live"
			footer="When text is read in the cloud, Live asks before every session: it sends an image each time the pinned area changes."
		>
			<SettingsRow
				label="Ask before Live sends text"
				description={
					remembered().length > 0
						? `You chose not to be asked again for ${remembered()
								.map((p) => p.name)
								.join(" and ")}.`
						: "Live asks once, before the first pinned session that sends text to a cloud provider."
				}
			>
				<Show when={remembered().length > 0}>
					<Button disabled={busy()} onClick={() => void reset()}>
						Ask again
					</Button>
				</Show>
			</SettingsRow>
		</SettingsGroup>
	);
}
