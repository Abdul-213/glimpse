// GLIM-80: the cloud-in-use indicator's words and its footer layout (snip-popup.md §2.4,
// §12 `snip.egress*`; live-popup.md uses the same pill). Pure: the view measures, this decides.
import type { SnipProviderBadge } from "./snip-state.ts";

type CloudBadge = Extract<SnipProviderBadge, { kind: "cloud" }>;

export interface EgressCopy {
	/** "Sent to Google Cloud Translation" (+ " (remembered)"). */
	readonly label: string;
	/** "Sent to Google": used when the full label doesn't fit the popup width. */
	readonly shortLabel: string;
	/** What left the device, for the tooltip and the accessible description. */
	readonly tooltip: string;
}

/**
 * The pill's text. `shortName` is the registry's short name for the provider (its vendor,
 * "Google"); without one the full name is used. Segments use `Intl.PluralRules` (English).
 */
export function egressCopy(badge: CloudBadge, shortName: string | null): EgressCopy {
	const remembered = badge.remembered ? " (remembered)" : "";
	const label = `Sent to ${badge.name}${remembered}`;
	const shortLabel = `Sent to ${shortName ?? badge.name}${remembered}`;
	let tooltip: string;
	if (badge.sent === "both" && badge.ocrName && badge.translatorName) {
		tooltip = `Text read by ${badge.ocrName} · Translated by ${badge.translatorName}`;
	} else if (badge.sent === "image" || (badge.sent === "both" && badge.ocrName)) {
		tooltip = `Image of the selected area sent to ${badge.ocrName ?? badge.name}`;
	} else if (badge.segments > 0) {
		const unit = new Intl.PluralRules("en").select(badge.segments) === "one" ? "segment" : "segments";
		tooltip = `Text sent to ${badge.name} (${badge.segments} ${unit})`;
	} else {
		tooltip = `Text sent to ${badge.name}`;
	}
	if (badge.remembered) tooltip = `${tooltip}. Shown from memory; nothing was sent again.`;
	return { label, shortLabel, tooltip };
}

export interface FooterWidths {
	/** The footer's inner width (popup width minus its inline padding). */
	readonly footer: number;
	/** The pill with its full label, and with the short one. */
	readonly pill: number;
	readonly shortPill: number;
	/** Everything else in the row: Private mark, status, the icon buttons, gaps. */
	readonly rest: number;
}

export interface FooterLayout {
	/** The pill gets its own row above the status row. */
	readonly ownRow: boolean;
	/** The pill shows the short name (full text stays in its tooltip and accessible name). */
	readonly short: boolean;
}

/**
 * §2.4 "Cloud footer wrap": never truncate the pill mid-name. One row if everything fits;
 * else the pill moves to its own row; if even alone it doesn't fit, it uses the short name.
 */
export function footerLayout(w: FooterWidths): FooterLayout {
	if (w.pill + w.rest <= w.footer) return { ownRow: false, short: false };
	return { ownRow: true, short: w.pill > w.footer && w.shortPill < w.pill };
}
