// Pure formatting helpers for component copy (DESIGN.md, snip-popup.md §12, live-popup.md §11).
// English strings are defaults; every component also takes the final string as a prop, so
// the i18n layer (later) can replace these without touching components.

export type Direction = "ltr" | "rtl";

/** Languages written right to left (primary subtags, plus scripts that force RTL). */
const RTL_LANGUAGES = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "iw", "ks", "ps", "sd", "ug", "ur", "yi"]);
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg"]);
const LTR_SCRIPTS = new Set(["Latn", "Cyrl"]);

/**
 * Writing direction of a BCP-47 tag: `ar` -> rtl, `ku-Arab` -> rtl, `az-Latn` -> ltr.
 * Used for the UI direction (`dir` on popup roots). Block text uses `dir="auto"` instead,
 * because OCR'd text can be mixed.
 */
export function languageDirection(tag: string): Direction {
	const parts = tag.split(/[-_]/);
	const primary = (parts[0] ?? "").toLowerCase();
	const script = parts.find((p, i) => i > 0 && p.length === 4);
	if (script) {
		const s = script[0]?.toUpperCase() + script.slice(1).toLowerCase();
		if (RTL_SCRIPTS.has(s)) return "rtl";
		if (LTR_SCRIPTS.has(s)) return "ltr";
	}
	return RTL_LANGUAGES.has(primary) ? "rtl" : "ltr";
}

/** Localised language name (`ja` in `en` -> "Japanese"). Falls back to the tag. */
export function languageName(tag: string, uiLocale = "en"): string {
	try {
		return new Intl.DisplayNames([uiLocale], { type: "language" }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}

/** A language's own name for itself (`ja` -> "日本語"), for the language picker. */
export function nativeLanguageName(tag: string): string {
	return languageName(tag, tag);
}

/** "Japanese, Korean" (DESIGN.md uses ", " joins in English). */
export function joinList(items: readonly string[], uiLocale = "en"): string {
	try {
		return new Intl.ListFormat([uiLocale], { type: "unit", style: "short" }).format(items);
	} catch {
		return items.join(", ");
	}
}

/** "1 block skipped · Korean" / "3 blocks skipped · Japanese, Korean" (snip.skipped). */
export function skippedLabel(count: number, languages: readonly string[], uiLocale = "en"): string {
	const noun = new Intl.PluralRules([uiLocale]).select(count) === "one" ? "block" : "blocks";
	const head = `${count} ${noun} skipped`;
	return languages.length > 0 ? `${head} · ${joinList(languages, uiLocale)}` : head;
}

/** live.age.*: "just now" (< 60 s), "{n} min ago" (< 60 min), "over an hour ago". */
export function staleAge(capturedAtMs: number, nowMs: number): string {
	const seconds = Math.max(0, (nowMs - capturedAtMs) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	return "over an hour ago";
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Decimal byte sizes, as both OSes show them: 31 MB, 1.2 GB, 412 MB. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "–";
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < UNITS.length - 1) {
		value /= 1000;
		unit++;
	}
	const digits = unit === 0 || value >= 10 ? 0 : 1;
	return `${value.toFixed(digits).replace(/\.0$/, "")} ${UNITS[unit]}`;
}

/** "about 3 min left", "less than a minute left", "about 2 h left". */
export function formatEta(seconds: number): string {
	if (seconds < 60) return "less than a minute left";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `about ${minutes} min left`;
	return `about ${Math.round(minutes / 60)} h left`;
}

/** Download progress line (DESIGN.md Model download): "412 MB of 1.2 GB · about 3 min left". */
export function progressLine(done: number, total: number, etaSeconds?: number): string {
	const head = `${formatBytes(done)} of ${formatBytes(total)}`;
	return etaSeconds === undefined || done >= total ? head : `${head} · ${formatEta(etaSeconds)}`;
}

/**
 * Skeleton bar width (snip-popup.md §2.2): the detected box's width as a share of the
 * region's width, clamped to 30–100 %. Returns a percentage.
 */
export function skeletonWidth(boxWidth: number, regionWidth: number): number {
	if (!(regionWidth > 0) || !Number.isFinite(boxWidth)) return 100;
	return Math.round(Math.min(100, Math.max(30, (boxWidth / regionWidth) * 100)));
}

export type StripLayout = "compact" | "regular" | "wide";

/** Live control strip widths (DESIGN.md Layout > Live popup): < 300, 300–359, ≥ 360. */
export function stripLayout(width: number): StripLayout {
	if (width < 300) return "compact";
	if (width < 360) return "regular";
	return "wide";
}
