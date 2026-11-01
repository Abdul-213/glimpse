// Search for the language picker. Pure: ranks options by how well the query matches the
// localised name, the language's own name, or its code.

export interface LanguageOption {
	/** BCP-47 tag. */
	readonly code: string;
	/** Name in the UI language ("Japanese"). */
	readonly name: string;
	/** The language's own name ("日本語"); optional. */
	readonly nativeName?: string;
	readonly disabled?: boolean;
}

/** Lowercase and strip diacritics, so "espanol" finds "Español" and "francais" finds "Français". */
export function foldForSearch(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLocaleLowerCase("en")
		.trim();
}

function score(option: LanguageOption, q: string): number {
	const code = option.code.toLowerCase();
	if (code === q) return 0;
	const fields = [option.name, option.nativeName ?? ""].map(foldForSearch);
	if (fields.some((f) => f.startsWith(q))) return 1;
	if (fields.some((f) => f.split(/[\s(),-]+/).some((w) => w.startsWith(q)))) return 2;
	if (code.startsWith(q)) return 3;
	if (fields.some((f) => f.includes(q))) return 4;
	return -1;
}

/**
 * Options matching `query`, best first: exact code, name prefix, word prefix, code prefix,
 * substring. Ties keep the input order (which callers sort by name). Empty query: all.
 */
export function filterLanguages<T extends LanguageOption>(options: readonly T[], query: string): T[] {
	const q = foldForSearch(query);
	if (q === "") return [...options];
	return options
		.map((option, index) => ({ option, index, s: score(option, q) }))
		.filter((r) => r.s >= 0)
		.sort((a, b) => a.s - b.s || a.index - b.index)
		.map((r) => r.option);
}
