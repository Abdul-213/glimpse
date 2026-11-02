import {
	Banner,
	BlockList,
	Button,
	EgressBadge,
	type Hotkey,
	HotkeyRecorder,
	hotkeyKeys,
	hotkeyLabel,
	Icon,
	IconButton,
	Kbd,
	type LanguageOption,
	LanguagePicker,
	LocalIndicator,
	languageName,
	nativeLanguageName,
	PopupShell,
	ProgressBar,
	SecretField,
	SegmentedControl,
	Select,
	SettingsControlRow,
	SettingsGroup,
	SettingsRow,
	SkippedLine,
	StateMessage,
	StatusIndicator,
	Switch,
	TextBlock,
	TextButton,
	TextField,
	Toolbar,
	type UiPlatform,
} from "@glimpse/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { GalleryParams } from "./params.ts";

const LANGS = [
	"en",
	"ja",
	"ko",
	"zh-Hans",
	"zh-Hant",
	"ar",
	"he",
	"fa",
	"ur",
	"hi",
	"bn",
	"th",
	"ru",
	"uk",
	"es",
	"fr",
	"de",
	"pt-BR",
	"tr",
	"vi",
];
const LANGUAGE_OPTIONS: LanguageOption[] = LANGS.map((code) => ({
	code,
	name: languageName(code),
	nativeName: nativeLanguageName(code),
})).sort((a, b) => a.name.localeCompare(b.name));

const hk = (key: string, mods: Partial<Omit<Hotkey, "key">>): Hotkey => ({
	ctrl: false,
	alt: false,
	shift: false,
	meta: false,
	...mods,
	key,
});
const SNIP_KEY = { macos: hk("S", { ctrl: true, shift: true }), windows: hk("S", { alt: true, shift: true }) };
const LIVE_KEY = { macos: hk("L", { ctrl: true, shift: true }), windows: hk("L", { alt: true, shift: true }) };
const keyFor = (os: UiPlatform, mac: Hotkey, win: Hotkey) => hotkeyLabel(os === "macos" ? mac : win, os);

function Section(props: { title: string; note?: string; children: JSX.Element }): JSX.Element {
	return (
		<section class="mb-10 flex flex-col gap-3">
			<div class="flex flex-col gap-0.5">
				<h2 class="m-0 text-heading">{props.title}</h2>
				<Show when={props.note}>
					<p class="m-0 max-w-measure text-body text-text-secondary">{props.note}</p>
				</Show>
			</div>
			<div class="flex flex-wrap items-start gap-6">{props.children}</div>
		</section>
	);
}

/** A labelled specimen. The caption sits outside the popup so it never reads as UI. */
function Specimen(props: { caption: string; children: JSX.Element }): JSX.Element {
	return (
		<figure class="m-0 flex flex-col gap-2">
			{props.children}
			<figcaption class="text-label text-text-secondary">{props.caption}</figcaption>
		</figure>
	);
}

// ── Snip ──────────────────────────────────────────────────────────────────────────────

function SnipFooter(props: {
	os: UiPlatform;
	status?: JSX.Element;
	cloud?: { provider: string; remembered?: boolean };
	originalPressed?: boolean;
	local?: string;
}): JSX.Element {
	const copy = () => (props.os === "macos" ? "⌘C" : "Ctrl+C");
	const original = () => (props.os === "macos" ? "⌘⇧O" : "Ctrl+Shift+O");
	return (
		<div class="mt-2 flex h-6 items-center gap-2 ps-2">
			<Show
				when={props.cloud}
				fallback={
					<LocalIndicator
						label={props.local}
						tooltip="Text was read and translated on this device. Nothing was sent."
					/>
				}
			>
				{(c) => (
					<EgressBadge
						provider={c().provider}
						remembered={c().remembered}
						tooltip={`Text sent to ${c().provider} (3 segments)`}
					/>
				)}
			</Show>
			<span class="min-w-0 flex-1" />
			<span role="status" class="inline-flex items-center gap-1 text-label text-text-secondary">
				{props.status}
			</span>
			<Toolbar label="Translation actions">
				<IconButton
					icon="original"
					label="Show original"
					shortcut={original()}
					pressed={props.originalPressed ?? false}
				/>
				<IconButton icon="copy" label="Copy translation" shortcut={copy()} />
				<IconButton icon="close" label="Close" shortcut="Esc" />
			</Toolbar>
		</div>
	);
}

const Copied = (props: { label?: string }) => (
	<>
		<Icon name="check" />
		{props.label ?? "Copied"}
	</>
);

function SnipSpecimens(props: { os: UiPlatform }): JSX.Element {
	return (
		<>
			<Specimen caption="Done, mixed source languages (S4, S8): tags, a neutral block, skipped line last">
				<PopupShell kind="snip" aria-label="Translation" style={{ width: "22.5rem" }}>
					<BlockList aria-label="Translated text">
						<TextBlock
							state="done"
							source="保存に失敗しました。もう一度試しますか？"
							sourceLang="ja"
							translation="Saving failed. Try again?"
							targetLang="en"
							tag="Japanese"
							tagLang="en"
						/>
						<TextBlock
							state="done"
							source="按任意键继续"
							sourceLang="zh-Hans"
							translation="Press any key to continue"
							targetLang="en"
							tag="Chinese"
							tagLang="en"
						/>
						<TextBlock state="done" kind="neutral" source="v2.4.1 · 60 FPS" />
						<SkippedLine count={1} languages={["Korean"]} />
					</BlockList>
					<SnipFooter os={props.os} status={<Copied />} />
				</PopupShell>
			</Specimen>

			<Specimen caption="Streaming (S1–S3): skeleton, pending source, translated">
				<PopupShell kind="snip" aria-label="Translation" style={{ width: "22.5rem" }}>
					<BlockList aria-label="Translated text">
						<TextBlock
							state="done"
							source="Сохранение не удалось"
							sourceLang="ru"
							translation="Saving failed"
							targetLang="en"
						/>
						<TextBlock
							state="pending"
							source="Проверьте подключение к сети и повторите попытку."
							sourceLang="ru"
							targetLang="en"
						/>
						<TextBlock state="skeleton" skeletonWidth={45} />
					</BlockList>
					<SnipFooter os={props.os} status="Translating 1 of 3" />
				</PopupShell>
			</Specimen>

			<Specimen caption="Original under translation (S5), skipped expanded (S7), failed block (S16)">
				<PopupShell kind="snip" aria-label="Translation" style={{ width: "22.5rem" }}>
					<BlockList aria-label="Translated text">
						<TextBlock
							state="done"
							showSource
							source="Ihr Abonnement läuft am 3. März ab."
							sourceLang="de"
							translation="Your subscription ends on 3 March."
							targetLang="en"
						/>
						<TextBlock state="failed" source="Jetzt verlängern" sourceLang="de" onRetry={() => undefined} />
						<SkippedLine count={2} languages={["Korean", "Thai"]} defaultExpanded>
							<TextBlock
								state="done"
								kind="neutral"
								source="계속하려면 아무 키나 누르세요"
								sourceLang="ko"
								tag="Korean"
							/>
							<TextBlock state="done" kind="neutral" source="กดปุ่มใดก็ได้เพื่อดำเนินการต่อ" sourceLang="th" tag="Thai" />
							<li class="flex gap-4 ps-2">
								<TextButton>Translate these</TextButton>
								<TextButton>Edit source languages…</TextButton>
							</li>
						</SkippedLine>
					</BlockList>
					<SnipFooter os={props.os} status="Translated 1 of 2" originalPressed />
				</PopupShell>
			</Specimen>

			<Specimen caption="Cloud in use, RTL source (S9, S14): egress pill, mixed-direction text">
				<PopupShell kind="snip" aria-label="Translation" style={{ width: "22.5rem" }}>
					<BlockList aria-label="Translated text">
						<TextBlock
							state="done"
							showSource
							source="تم حفظ الملف في مجلد «المستندات» بنجاح."
							sourceLang="ar"
							translation="The file was saved to the “Documents” folder."
							targetLang="en"
						/>
						<TextBlock
							state="done"
							showSource
							source="גרסה 3.2 זמינה – לחצו על Update"
							sourceLang="he"
							translation="Version 3.2 is available – click Update"
							targetLang="en"
						/>
					</BlockList>
					<SnipFooter os={props.os} status={<Copied />} cloud={{ provider: "DeepL" }} />
				</PopupShell>
			</Specimen>

			<Specimen caption="Cloud error (E3): heading, body, recovery is primary">
				<PopupShell kind="snip" aria-label="Translation" style={{ width: "22.5rem" }}>
					<StateMessage
						tone="danger"
						title="DeepL rejected the API key"
						actions={
							<>
								<Button variant="primary">Check key…</Button>
								<Button>Translate on this device</Button>
							</>
						}
					>
						Nothing was translated. Check the key in Settings.
					</StateMessage>
					<SnipFooter os={props.os} status="Clipboard not changed" cloud={{ provider: "DeepL" }} />
				</PopupShell>
			</Specimen>

			<Specimen caption="Right-to-left UI, Arabic target (S10): chrome mirrors, blocks align per text">
				<PopupShell kind="snip" dir="rtl" lang="ar" aria-label="الترجمة" style={{ width: "22.5rem" }}>
					<BlockList aria-label="النص المترجم">
						<TextBlock
							state="done"
							showSource
							source="Saving failed. Try again?"
							sourceLang="en"
							translation="فشل الحفظ. هل تريد المحاولة مرة أخرى؟"
							targetLang="ar"
						/>
						<TextBlock
							state="done"
							showSource
							source="Update to version 3.2 (12 MB)"
							sourceLang="en"
							translation="حدّث إلى الإصدار 3.2 (12 MB)"
							targetLang="ar"
						/>
						<SkippedLine count={1} languages={[]} label="تم تخطي كتلة واحدة · اليابانية" />
					</BlockList>
					<SnipFooter os={props.os} status={<Copied label="تم النسخ" />} local="على الجهاز" />
				</PopupShell>
			</Specimen>
		</>
	);
}

// ── Live ──────────────────────────────────────────────────────────────────────────────

function LiveStrip(props: {
	os: UiPlatform;
	status: "running" | "updating" | "paused" | "error";
	label: string;
	compact?: boolean;
	cloud?: boolean;
	private?: boolean;
}): JSX.Element {
	const pauseKey = () => (props.os === "macos" ? "⌘⇧P" : "Ctrl+Shift+P");
	const stopKey = () => (props.os === "macos" ? "⌘W" : "Ctrl+W");
	const paused = () => props.status === "paused" || props.status === "error";
	return (
		<div class="flex h-7 items-center gap-2 ps-2">
			<StatusIndicator status={props.status} label={props.label} />
			<Show when={!props.cloud}>
				<LocalIndicator
					compact={props.compact}
					tooltip="Text is read and translated on this device. Nothing is sent."
				/>
			</Show>
			<span class="min-w-0 flex-1" />
			<Toolbar label="Live controls">
				<IconButton
					icon="eye-off"
					label={props.private ? "Private is on" : "Turn on Private"}
					pressed={props.private ?? false}
				/>
				<IconButton icon={paused() ? "play" : "pause"} label={paused() ? "Resume" : "Pause"} shortcut={pauseKey()} />
				<IconButton icon="select-area" label="Pick a new area" />
				<IconButton icon="stop" label="Stop Live" shortcut={stopKey()} />
			</Toolbar>
		</div>
	);
}

function LiveSpecimens(props: { os: UiPlatform }): JSX.Element {
	return (
		<>
			<Specimen caption="Running, a change just landed (L4, flash frame); neutral counter never marked">
				<div data-freeze-flash="">
					<PopupShell kind="live" aria-label="Live translation" style={{ width: "25rem" }}>
						<LiveStrip os={props.os} status="running" label="Live" />
						<BlockList aria-label="Translated text" class="mt-1">
							<TextBlock
								variant="live"
								state="done"
								translation="The gate opens at dawn."
								targetLang="en"
								source="門は夜明けに開く。"
								sourceLang="ja"
							/>
							<TextBlock
								variant="live"
								state="done"
								translation="Bring the lantern with you."
								targetLang="en"
								source="ランタンを持って行け。"
								sourceLang="ja"
								changeId={1}
							/>
							<TextBlock variant="live" state="done" kind="neutral" source="HP 42 / 50" />
						</BlockList>
					</PopupShell>
				</div>
			</Specimen>

			<Specimen caption="Settled (rest tint and mark stay until the next change)">
				<div data-settled="">
					<PopupShell kind="live" aria-label="Live translation" style={{ width: "25rem" }}>
						<LiveStrip os={props.os} status="updating" label="Updating" />
						<BlockList aria-label="Translated text" class="mt-1">
							<TextBlock variant="live" state="done" translation="The gate opens at dawn." targetLang="en" />
							<TextBlock
								variant="live"
								state="done"
								translation="Bring the lantern with you."
								targetLang="en"
								changeId={1}
							/>
						</BlockList>
					</PopupShell>
				</div>
			</Specimen>

			<Specimen caption="Paused, stale (L5): hollow dot, secondary text, age line">
				<PopupShell kind="live" aria-label="Live translation" style={{ width: "20rem" }}>
					<LiveStrip os={props.os} status="paused" label="Paused · Private" private />
					<div class="mt-1">
						<StateMessage>Showing text from 3 min ago</StateMessage>
					</div>
					<BlockList aria-label="Translated text" class="mt-1">
						<TextBlock variant="live" stale state="done" translation="We're almost at the border." targetLang="en" />
						<TextBlock variant="live" stale state="done" translation="Keep your papers ready." targetLang="en" />
					</BlockList>
				</PopupShell>
			</Specimen>

			<Specimen caption="Compact (< 300px), cloud row for the session (L9, L21)">
				<PopupShell kind="live" aria-label="Live translation" style={{ width: "16.25rem" }}>
					<LiveStrip os={props.os} status="running" label="Live" compact cloud />
					<div class="mt-1 flex h-6 items-center">
						<EgressBadge
							provider="Google Cloud Translation"
							shortName="Google"
							short
							tooltip="Changes in this area are sent to Google Cloud Translation as text"
						/>
					</div>
					<BlockList aria-label="Translated text" class="mt-1">
						<TextBlock
							variant="live"
							state="done"
							translation="Next stop: Central Station"
							targetLang="en"
							changeId={2}
						/>
					</BlockList>
				</PopupShell>
			</Specimen>

			<Specimen caption="Error, paused (L14): danger dot, state row with actions">
				<PopupShell kind="live" aria-label="Live translation" style={{ width: "22.5rem" }}>
					<LiveStrip os={props.os} status="error" label="Paused" cloud />
					<div class="mt-1 flex h-6 items-center">
						<EgressBadge provider="DeepL" />
					</div>
					<div class="mt-1">
						<StateMessage
							tone="danger"
							title="DeepL's quota for this key is used up"
							actions={
								<>
									<Button variant="primary">Use on-device</Button>
									<Button>Stop Live</Button>
								</>
							}
						>
							Live is paused. You can keep watching with on-device translation.
						</StateMessage>
					</div>
				</PopupShell>
			</Specimen>
		</>
	);
}

// ── Settings controls ─────────────────────────────────────────────────────────────────

function SettingsSpecimen(props: { os: UiPlatform }): JSX.Element {
	const [target, setTarget] = createSignal("en");
	const [motion, setMotion] = createSignal("system");
	const [snip, setSnip] = createSignal<Hotkey | null>(props.os === "macos" ? SNIP_KEY.macos : SNIP_KEY.windows);
	const [live, setLive] = createSignal<Hotkey | null>(props.os === "macos" ? LIVE_KEY.macos : LIVE_KEY.windows);
	const vault = () => (props.os === "macos" ? "Keychain" : "Credential Manager");
	return (
		<div class="flex w-[38rem] flex-col rounded-popup bg-(--veil-window) p-6 shadow-[inset_0_0_0_1px_var(--color-border-hairline)]">
			<h3 class="m-0 mb-5 font-display text-title">General</h3>
			<SettingsGroup title="Translation">
				<SettingsRow label="Translate into" description="Text in other languages is translated into this one.">
					{(ids) => (
						<div class="w-56">
							<LanguagePicker
								options={LANGUAGE_OPTIONS}
								value={target()}
								onChange={setTarget}
								aria-labelledby={ids.labelId}
							/>
						</div>
					)}
				</SettingsRow>
				<SettingsControlRow>
					<Switch
						label="Copy translation after Snip"
						description="Puts the translated text on the clipboard."
						defaultChecked
					/>
				</SettingsControlRow>
				<SettingsControlRow>
					<Switch label="Show original under translation" />
				</SettingsControlRow>
				<SettingsRow label="Motion">
					<SegmentedControl
						label="Motion"
						value={motion()}
						onChange={setMotion}
						options={[
							{ value: "system", label: "System" },
							{ value: "reduced", label: "Reduced" },
						]}
					/>
				</SettingsRow>
				<SettingsRow label="Live capture rate on battery">
					{(ids) => (
						<div class="w-40">
							<Select
								aria-labelledby={ids.labelId}
								value="1"
								options={[
									{ value: "1", label: "1 per second" },
									{ value: "2", label: "2 per second" },
									{ value: "4", label: "4 per second" },
								]}
							/>
						</div>
					)}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title="Shortcuts">
				<SettingsRow label="Snip">
					<HotkeyRecorder label="Snip" platform={props.os} value={snip()} onChange={setSnip} />
				</SettingsRow>
				<SettingsRow label="Live">
					<HotkeyRecorder
						label="Live"
						platform={props.os}
						value={live()}
						onChange={setLive}
						error="Another app already uses this shortcut."
					/>
				</SettingsRow>
				<SettingsRow label="Pause or resume Live">
					<HotkeyRecorder label="Pause or resume Live" platform={props.os} value={null} onChange={() => undefined} />
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title="Cloud translation" footer={`Keys are stored in the ${vault()} and never shown again.`}>
				<div class="glim-row flex-col items-stretch">
					<SecretField label="DeepL API key" stored storedLabel={`Saved in ${vault()}`} />
				</div>
				<div class="glim-row flex-col items-stretch">
					<TextField
						label="Custom endpoint"
						value="htp://translate.example"
						error="Enter a URL that starts with https://"
					/>
				</div>
			</SettingsGroup>
		</div>
	);
}

function MiscSpecimens(props: { os: UiPlatform }): JSX.Element {
	return (
		<div class="flex w-[30rem] flex-col gap-4">
			<Banner tone="warning" title="This copy of Glimpse isn't signed" actions={<Button>Show me how</Button>}>
				{props.os === "macos"
					? "macOS will say it can't check it for malware. Open it once from Finder with Control-click, then Open."
					: "SmartScreen may warn you the first time. Choose More info, then Run anyway."}
			</Banner>
			<Banner tone="success" title="Screen Recording is allowed" />
			<Banner
				tone="danger"
				title="The Japanese pack didn't download"
				actions={<Button variant="primary">Try again</Button>}
			>
				The connection dropped at 412 MB. Glimpse keeps what it has and resumes from there.
			</Banner>
			<div class="glim-banner flex-col items-stretch">
				<p class="m-0 text-body font-semibold">Japanese language pack</p>
				<ProgressBar label="Downloading Japanese" done={412_000_000} total={1_200_000_000} etaSeconds={170} />
				<ProgressBar label="Downloading Korean" done={0} />
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="primary">Continue</Button>
				<Button>Back</Button>
				<Button disabled>Disabled</Button>
				<Toolbar label="Icon buttons">
					<IconButton icon="copy" label="Copy translation" />
					<IconButton icon="original" label="Show original" pressed />
					<IconButton icon="close" label="Close" disabled />
				</Toolbar>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<Kbd keys={hotkeyKeys(SNIP_KEY.macos, "macos")} platform="macos" />
				<Kbd keys={hotkeyKeys(SNIP_KEY.windows, "windows")} platform="windows" />
				<StatusIndicator status="running" label="Live" />
				<StatusIndicator status="paused" label="Paused" />
				<StatusIndicator status="error" label="Paused" />
				<LocalIndicator />
				<EgressBadge provider="DeepL" remembered />
			</div>
			<div class="flex flex-wrap items-start gap-4">
				<div class="glim-tooltip">
					Copy translation{" "}
					<span class="text-text-secondary">
						({keyFor(props.os, hk("C", { meta: true }), hk("C", { ctrl: true }))})
					</span>
				</div>
				<div class="glim-menu w-56" role="presentation">
					<For each={["Japanese", "Korean", "Chinese (Simplified)"]}>
						{(name, i) => (
							<div class="glim-menu-item" data-highlighted={i() === 1 ? "" : undefined}>
								<span>{name}</span>
								<span class="glim-menu-secondary">{["日本語", "한국어", "简体中文"][i()]}</span>
								<Show when={i() === 0}>
									<Icon name="check" class="glim-menu-check" />
								</Show>
							</div>
						)}
					</For>
				</div>
			</div>
		</div>
	);
}

export function ComponentsPage(props: { params: GalleryParams }): JSX.Element {
	const os = () => props.params.os;
	return (
		<>
			<Section
				title="Snip popup"
				note="Built from PopupShell, BlockList, TextBlock, SkippedLine, the provider indicators and a Toolbar of IconButtons. Specimen widths are fixed here; the real popup takes its width from the region."
			>
				<SnipSpecimens os={os()} />
			</Section>
			<Section
				title="Live popup"
				note="Live blocks pad 20px at inline-start for the change mark. The flash specimen is frozen at its first frame."
			>
				<LiveSpecimens os={os()} />
			</Section>
			<Section title="Settings and onboarding controls">
				<SettingsSpecimen os={os()} />
				<MiscSpecimens os={os()} />
			</Section>
		</>
	);
}
