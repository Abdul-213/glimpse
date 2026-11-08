// Snip popup copy (snip-popup.md §12). English for now; every string the popup shows
// comes from here, so the i18n layer can replace this table without touching components.
import {
	downloadNeedsConfirm,
	type PackKind,
	type PipelineErrorKind,
	type SnipPackRow,
	type SnipPopupState,
	type SnipStatus,
} from "@glimpse/core";
// The pure helpers only: this module is also unit-tested without a DOM (GLIM-80).
import { formatBytes, languageName } from "@glimpse/ui/format";
import type { SnipAction } from "../../shared/popup-rpc.ts";

export const COPY = {
	dialog: "Translation",
	list: "Translated text",
	reading: "Reading text",
	local: "On device",
	localTooltip: "Text was read and translated on this device. Nothing was sent.",
	private: "Private",
	privateTooltip: "Private is on. Nothing from this Snip is remembered.",
	close: "Close",
	actions: "Translation actions",
	failed: "Not translated",
	retry: "Retry",
	translateThese: "Translate these",
	editSources: "Edit source languages…",
	useCloudOcr: "Use cloud OCR…",
	clipboardUnchanged: "Clipboard not changed",
	showingOriginal: "Showing original",
	copied: "Copied",
	copyTranslation: "Copy translation",
	showOriginal: "Show original",
	showTranslation: "Show translation",
	// GLIM-152: overlay mode and numbered markers.
	showOnScreen: "Show translations on screen",
	hideFromScreen: "Back to the list only",
} as const;

export const translatingText = (done: number, total: number) => `Translating ${done} of ${total}`;
export const partialText = (done: number, total: number) => `Translated ${done} of ${total}`;
/** GLIM-126: "Vietnamese tone marks are often lost when text is read on this device." */
export const partialOcrText = (languages: readonly string[]) =>
	`${languages.join(", ")} tone marks are often lost when text is read on this device.`;
export const alreadyIn = (target: string, uiLang: string) => `Already in ${languageName(target, uiLang)}`;

/** GLIM-152: overlay mode's status line names the peek key ("Hold Shift to peek", "Hold ⇧ to peek"). */
export const peekText = (key: string) => `Hold ${key} to peek`;

/** The visible footer status (§2.4). `peekKey`: the peek key's label for the overlay status. */
export function statusText(s: SnipStatus, peekKey = "Shift"): string {
	switch (s.kind) {
		case "overlay":
			return peekText(peekKey);
		case "none":
			return "";
		case "reading":
			return COPY.reading;
		case "translating":
			return translatingText(s.done, s.total);
		case "partial":
			return partialText(s.done, s.total);
		case "clipboardUnchanged":
			return COPY.clipboardUnchanged;
		case "original":
			return COPY.showingOriginal;
		case "copied":
			return COPY.copied;
	}
}

/**
 * What the status region announces (§10): only "Reading text", "Translating" and the
 * final line, never each block.
 */
export function announcement(s: SnipStatus, translated: number, finished: boolean, autoCopied = false): string {
	if (s.kind === "reading") return COPY.reading;
	if (s.kind === "translating") return "Translating";
	if (s.kind === "clipboardUnchanged") return "";
	if (s.kind === "original") return COPY.showingOriginal;
	if (s.kind === "copied" && !finished) return COPY.copied;
	if (!finished || translated === 0) return s.kind === "copied" ? COPY.copied : "";
	const head = `Translated ${translated} ${translated === 1 ? "block" : "blocks"}.`;
	return autoCopied ? `${head} Copied to clipboard.` : head;
}

// ---- Pack rows (§2.2) and error bodies (§4.1) ------------------------------------------

/** The SMaLL-100 download's name in the popups (Settings › Models: "More languages (SMaLL-100)"). */
export const LONG_TAIL_MODEL = "More languages model";

export const packRowText = (lang: string, uiLang: string, kind?: PackKind) =>
	kind === "long-tail-model"
		? `${languageName(lang, uiLang)} needs the ${LONG_TAIL_MODEL}.`
		: `${languageName(lang, uiLang)} isn't downloaded yet.`;
export const packDownloadText = (bytes: number) => (bytes > 0 ? `Download (${formatBytes(bytes)})` : "Download");
export const packProgressText = (done: number, total: number) => `${formatBytes(done)} of ${formatBytes(total)}`;
export const packOfflineText = "Connect to the internet to download it.";
export const packFailedText = "The download didn't finish.";
export const packProgressLabel = (lang: string, uiLang: string, kind?: PackKind) =>
	kind === "long-tail-model" ? `Downloading the ${LONG_TAIL_MODEL}` : `Downloading ${languageName(lang, uiLang)}`;

/**
 * GLIM-138: the question a large download asks first (`downloadNeedsConfirm`): what it is, its
 * size and what it's for. The long-tail model also says what it costs to run.
 */
export function packConfirmText(row: { lang: string; bytes: number; kind?: PackKind }, uiLang: string): string {
	const name = languageName(row.lang, uiLang);
	// A no-break space keeps "618 MB" on one line in the narrow popup.
	const size = formatBytes(row.bytes).replace(" ", "\u00a0");
	if (row.kind === "long-tail-model") {
		return (
			`Download the ${LONG_TAIL_MODEL} (${size})? It translates ${name} and about 100 other languages ` +
			"on this device. It's slower than language packs and uses about 1 GB of memory while it translates."
		);
	}
	return `Download ${size} to translate ${name}? This is a large download.`;
}
export const packConfirmCancel = "Not now";

export interface ErrorButton {
	readonly action: SnipAction;
	readonly label: string;
	readonly primary: boolean;
	readonly lang?: string;
	/** GLIM-138: a large download asks this first ("Download" / "Not now") before acting. */
	readonly confirm?: string;
}

export interface ErrorBody {
	readonly title: string;
	readonly body: string;
	/** `danger` for E3/E4/E7 (something broke), `neutral` for E1/E2/E5. */
	readonly tone: "danger" | "neutral";
	readonly buttons: readonly ErrorButton[];
	/** E2/E3: the original text is listed under the body. */
	readonly showOriginal: boolean;
}

function providerName(s: SnipPopupState): string {
	if (s.translatorProvider?.kind === "cloud") return s.translatorProvider.name;
	return s.provider.kind === "cloud" ? s.provider.name : "The translation provider";
}

function packTitle(rows: readonly SnipPackRow[], uiLang: string): string {
	const [only] = rows;
	if (rows.length === 1 && only) return `${languageName(only.lang, uiLang)} isn't downloaded yet`;
	return `${rows.length} languages aren't downloaded yet`;
}

/** The error body for a finished run's error kind (§12 `snip.e*`), or null. */
export function errorBody(
	kind: PipelineErrorKind,
	s: SnipPopupState,
	os: "macos" | "windows" | "linux",
	uiLang: string,
	/** "Translate on this device" is offered: the needed local packs are installed (§12). */
	localAvailable = false,
): ErrorBody {
	const close: ErrorButton = { action: "close", label: "Close", primary: false };
	const local: ErrorButton[] = localAvailable
		? [{ action: "local", label: "Translate on this device", primary: false }]
		: [];
	const snipAgain: ErrorButton = { action: "snipAgain", label: "Snip again", primary: true };
	const provider = providerName(s);
	switch (kind) {
		case "noText":
			return {
				title: "No text found",
				body: "Glimpse couldn't find any text in this area. Try a larger area, or zoom in so the text is bigger.",
				tone: "neutral",
				buttons: [snipAgain, close],
				showOriginal: false,
			};
		case "packMissing": {
			const rows = s.packs;
			const [only] = rows;
			const name = only ? languageName(only.lang, uiLang) : "";
			const bytes = rows.reduce((n, r) => n + r.bytes, 0);
			const size = bytes > 0 ? ` (${formatBytes(bytes)})` : "";
			const offline = rows.length > 0 && rows.every((r) => r.state === "offline");
			const longTail = rows.length === 1 && only?.kind === "long-tail-model";
			const confirm =
				only && downloadNeedsConfirm({ bytes })
					? rows.length === 1
						? packConfirmText(only, uiLang)
						: `Download ${formatBytes(bytes)} to translate these languages? This is a large download.`
					: undefined;
			return {
				title: packTitle(rows, uiLang),
				body: longTail
					? `The text was read, but Glimpse needs the ${LONG_TAIL_MODEL} to translate ${name}. The original text is below.`
					: rows.length === 1
						? `The text was read, but Glimpse needs the ${name} language pack to translate it. The original text is below.`
						: "The text was read, but Glimpse needs these language packs to translate it. The original text is below.",
				tone: "neutral",
				buttons: [
					...(offline
						? []
						: [
								{
									action: "download" as const,
									label: longTail
										? `Download${size}`
										: rows.length === 1
											? `Download ${name}${size}`
											: `Download all${size}`,
									primary: true,
									...(only && rows.length === 1 ? { lang: only.lang } : {}),
									...(confirm ? { confirm } : {}),
								},
							]),
					{ action: "copyOriginal", label: "Copy original", primary: offline },
				],
				showOriginal: true,
			};
		}
		case "providerKey":
			return {
				title: `${provider} rejected the API key`,
				body: "Nothing was translated. Check the key in Settings.",
				tone: "danger",
				buttons: [
					{ action: "checkKey", label: "Check key…", primary: true },
					...(localAvailable ? local : [{ action: "retry" as const, label: "Retry", primary: false }]),
				],
				showOriginal: true,
			};
		case "providerQuota":
			return {
				title: `${provider}'s quota for this key is used up`,
				body: `Nothing was translated. The quota resets on ${provider}'s schedule, or you can translate on this device.`,
				tone: "danger",
				// Retry would hit the same quota: on-device is the obvious way out when there is one.
				buttons: localAvailable
					? [{ action: "local", label: "Translate on this device", primary: true }]
					: [{ action: "retry", label: "Retry", primary: false }],
				showOriginal: true,
			};
		case "spendCap":
			// GLIM-120: Glimpse paused cloud use itself; nothing was sent. Not an error, a limit the user set.
			return {
				title: "Cloud use is paused for this month",
				body: "You've used Google's free tier this month, so Glimpse stopped sending to Google Cloud. Nothing was sent. Continuing may cost money.",
				tone: "neutral",
				// Free first: on-device (when the packs are there) leads; continuing is one click.
				buttons: [
					...(localAvailable ? [{ action: "local" as const, label: "Translate on this device", primary: true }] : []),
					{ action: "continueCloud", label: "Continue this month", primary: !localAvailable },
				],
				showOriginal: true,
			};
		case "providerTimeout":
			return {
				title: `${provider} didn't answer within 10 seconds`,
				body: `The text may have reached ${provider}, but no translation came back.`,
				tone: "danger",
				buttons: [{ action: "retry", label: "Retry", primary: true }, ...local],
				showOriginal: true,
			};
		case "offline":
			return {
				title: "You're offline",
				body: "Nothing was sent. Connect to the internet, or translate on this device.",
				tone: "danger",
				buttons: [{ action: "retry", label: "Retry", primary: true }, ...local],
				showOriginal: true,
			};
		case "screenAccess":
			return os === "macos"
				? {
						title: "Glimpse can't see your screen",
						body: "Screen Recording permission is off, or was reset by an update. The capture came back blank.",
						tone: "danger",
						buttons: [
							{ action: "openSystemSettings", label: "Open System Settings", primary: true },
							{ action: "why", label: "Why does this happen?", primary: false },
						],
						showOriginal: false,
					}
				: captureBlank(snipAgain, close);
		case "captureBlank":
		case "captureFailed":
			return captureBlank(snipAgain, close);
		case "nothingToTranslate":
			return {
				title: "Nothing to translate",
				body: "Every block is in a language outside your source languages.",
				tone: "neutral",
				buttons: [],
				showOriginal: false,
			};
		case "ocrFailed":
			return {
				title: "Text recognition stopped",
				body: "Glimpse's text recognition model failed to run. Snip again, and if it keeps happening, reinstall Glimpse.",
				tone: "danger",
				buttons: [snipAgain, close],
				showOriginal: false,
			};
	}
}

function captureBlank(snipAgain: ErrorButton, close: ErrorButton): ErrorBody {
	return {
		title: "Glimpse couldn't capture this area",
		body: "The capture came back blank. Protected video and some fullscreen games block screen capture.",
		tone: "danger",
		buttons: [snipAgain, close],
		showOriginal: false,
	};
}
