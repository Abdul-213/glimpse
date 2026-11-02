// Live popup copy (live-popup.md §11). English for now; every string the popup shows comes
// from here, so the i18n layer can replace this table without touching components.
import type { LiveError, LivePopupState } from "@glimpse/core";
import { staleAge } from "@glimpse/ui";

export const COPY = {
	region: "Live translation",
	list: "Live text",
	controls: "Live controls",
	live: "Live",
	updating: "Updating",
	paused: "Paused",
	local: "On device",
	localTooltip: "Text is read and translated on this device. Nothing is sent.",
	repin: "Pick a new area",
	privateOn: "Private is on. This session's translations are forgotten when it ends.",
	privateOff: "Turn on Private to forget this session's translations when it ends",
	empty: "No text in this area right now. Watching for changes.",
	changed: "Changed",
	failed: "Not translated",
	consentLocal: "Use on-device",
	consentCancel: "Cancel",
	consentRemember: "Don't ask again for Live",
	resume: "Resume",
	stop: "Stop Live",
	locked: "Paused while the screen was locked",
	changesLog: "Live changes",
	a11yPaused: "Live paused",
	a11yResumed: "Live resumed",
	alreadyIn: "Already in",
	// Skipped line actions (GLIM-131), Snip's `snip.skipped.*` copy.
	translateThese: "Translate these",
	editSources: "Edit source languages…",
} as const;

export const statusLabel = (label: "live" | "updating" | "paused", privateOn: boolean, compact: boolean): string => {
	const base = label === "live" ? COPY.live : label === "updating" ? COPY.updating : COPY.paused;
	return privateOn && !compact ? `${base} · Private` : base;
};

export const pauseLabel = (paused: boolean) => (paused ? "Resume" : "Pause");
export const staleText = (capturedAt: number, now: number) => `Showing text from ${staleAge(capturedAt, now)}`;
export const egressTooltip = (provider: string) => `Changes in this area are sent to ${provider} as text`;

/** The company for short copy ("Google" from "Google Cloud Translation"). */
export const company = (name: string) => name.split(" ")[0] ?? name;

export interface LiveConsentCopy {
	title: string;
	body: string;
	primary: string;
}

export function consentCopy(s: LivePopupState): LiveConsentCopy | null {
	const q = s.consent;
	const provider = q?.providers[0]?.name;
	if (!q || !provider) return null;
	const image = q.reason === "cloud-ocr";
	return {
		title: `Live will send ${image ? "images of this area" : "text"} to ${provider}`,
		body: image
			? `While this area is pinned, an image of it is sent to ${provider} each time it changes, using your API key.`
			: `While this area is pinned, its text is sent to ${provider} each time it changes, using your API key.`,
		primary: `Pin with ${company(provider)}`,
	};
}

export type LiveErrorAction = "resume" | "repin" | "stop";

export interface LiveErrorCopy {
	title: string;
	body: string;
	actions: { action: LiveErrorAction; label: string; primary: boolean }[];
}

/** L14–L16, L-gone: heading, body, and a keyboard-reachable recovery first. */
export function errorCopy(error: LiveError): LiveErrorCopy {
	const stop = { action: "stop" as const, label: COPY.stop, primary: false };
	switch (error.kind) {
		case "screenAccess":
			return {
				title: "Glimpse can't see the screen",
				body: "Screen Recording permission is off, or was reset by an update. Live is paused.",
				actions: [{ action: "resume", label: COPY.resume, primary: true }, stop],
			};
		case "areaGone":
			return {
				title: "The Live area is no longer on a screen",
				body: "Its display was disconnected or changed resolution.",
				actions: [{ action: "repin", label: COPY.repin, primary: true }, stop],
			};
		case "captureFailed":
			return {
				title: "Glimpse can't see the screen",
				body: "The screen couldn't be captured. Live is paused.",
				actions: [{ action: "resume", label: COPY.resume, primary: true }, stop],
			};
		case "ocrFailed":
			return {
				title: "Text recognition stopped",
				body: "Live is paused. Resume to try again.",
				actions: [{ action: "resume", label: COPY.resume, primary: true }, stop],
			};
	}
}

// L12 pack rows and the skipped line share Snip's copy (live-popup.md §11: `snip.pack.*`).
export {
	packDownloadText,
	packFailedText,
	packOfflineText,
	packProgressLabel,
	packProgressText,
	packRowText,
} from "../popup/copy.ts";
