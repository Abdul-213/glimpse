// Live popup copy (live-popup.md §11). English for now; every string the popup shows comes
// from here, so the i18n layer can replace this table without touching components.
import type { LiveError, LivePopupState } from "@glimpse/core";
import { staleAge } from "@glimpse/ui";
import type { LiveMarksUnavailable } from "../../shared/live-rpc.ts";

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
	continueCloud: "Continue this month",
	locked: "Paused while the screen was locked",
	changesLog: "Live changes",
	a11yPaused: "Live paused",
	a11yResumed: "Live resumed",
	alreadyIn: "Already in",
	// Skipped line actions (GLIM-131), Snip's `snip.skipped.*` copy.
	translateThese: "Translate these",
	editSources: "Edit source languages…",
	// GLIM-151: moving, docking, Pin (live-popup.md §3.3).
	pin: "Keep on top of other windows",
	dock: "Dock next to the area",
	docked: "Popup docked next to the area",
	moved: "Popup moved",
	// GLIM-154: overlay mode (Snip's GLIM-152 copy).
	showOnScreen: "Show translations on screen",
	hideFromScreen: "Back to the list only",
	// GLIM-158: the toggle's visible label.
	onScreen: "On screen",
	// GLIM-163: the toggle's tooltip when the frame can't draw the cards.
	onScreenNotExcluded: "On screen isn't available here: Glimpse can't hide its overlay from its own capture",
	onScreenNoFrame: "On screen isn't available here: Glimpse can't draw over this area",
	onScreenNotYet: "On screen isn't available yet",
	// GLIM-157: Update mode and Refresh.
	refresh: "Refresh",
	manualOn: "Only update when I refresh",
	manualNote: "Updates only when you refresh.",
} as const;

/** GLIM-151: read with the popup (aria-describedby): how to move it from the keyboard. */
export const moveHint = (mac: boolean) =>
	`Drag the top bar to move. ${mac ? "Option" : "Alt"}+arrow keys move it too, with Shift for bigger steps.`;

const EDGE_NAMES = { left: "left", right: "right", top: "top", bottom: "bottom" } as const;

/** GLIM-151: the polite announcement after a keyboard move or Dock. */
export function moveAnnouncement(kind: "moved" | "docked", edges: readonly (keyof typeof EDGE_NAMES)[]): string {
	if (kind === "docked") return COPY.docked;
	if (edges.length === 0) return COPY.moved;
	const names = edges.map((e) => EDGE_NAMES[e]);
	return `Popup at the ${names.join(" and ")} edge of the screen`;
}

export const statusLabel = (label: "live" | "updating" | "paused", privateOn: boolean, compact: boolean): string => {
	const base = label === "live" ? COPY.live : label === "updating" ? COPY.updating : COPY.paused;
	return privateOn && !compact ? `${base} · Private` : base;
};

/** GLIM-163: why the On screen toggle is disabled (absent: main hasn't said yet). */
export const onScreenUnavailable = (reason: LiveMarksUnavailable | undefined): string =>
	reason === "not-excluded"
		? COPY.onScreenNotExcluded
		: reason === "no-frame"
			? COPY.onScreenNoFrame
			: COPY.onScreenNotYet;

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

/** `continueCloud`: the spend guard's "Continue this month" (GLIM-120). */
export type LiveErrorAction = "resume" | "repin" | "stop" | "continueCloud";

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
		case "spendCap":
			// GLIM-120: a limit the user set, not a failure. Continuing is one click, and may cost money.
			return {
				title: "Cloud use is paused for this month",
				body: "You've used Google's free tier this month, so Live stopped sending to Google Cloud. Continuing may cost money.",
				actions: [{ action: "continueCloud", label: COPY.continueCloud, primary: true }, stop],
			};
	}
}

// L12 pack rows and the skipped line share Snip's copy (live-popup.md §11: `snip.pack.*`).
export {
	packConfirmCancel,
	packConfirmText,
	packDownloadText,
	packFailedText,
	packOfflineText,
	packProgressLabel,
	packProgressText,
	packRowText,
} from "../popup/copy.ts";
