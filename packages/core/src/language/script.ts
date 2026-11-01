// Writing systems. Script codes are ISO 15924 (`Latn`, `Cyrl`, `Hans`), the same subtags
// BCP-47 uses, so a script can be read straight off a tag like `zh-Hant` or `ks-Deva`.

/** An ISO 15924 script code, title case (`Latn`, `Arab`, `Hans`). */
export type ScriptCode = string;

export type TextDirection = "ltr" | "rtl";

/** Scripts written right to left. Everything else Glimpse meets is left to right. */
const RTL_SCRIPTS: ReadonlySet<ScriptCode> = new Set([
	"Adlm", // Adlam (Fulani)
	"Arab",
	"Hebr",
	"Mand", // Mandaic
	"Mend", // Mende Kikakui
	"Nkoo", // N'Ko
	"Rohg", // Hanifi Rohingya
	"Samr", // Samaritan
	"Syrc", // Syriac
	"Thaa", // Thaana (Dhivehi)
]);

export function scriptDirection(script: ScriptCode): TextDirection {
	return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
}

/** True for `Hans`, `Hant`, `Hani`, `Jpan` (scripts made mostly of Han characters). */
export function isHanScript(script: ScriptCode): boolean {
	return script === "Hans" || script === "Hant" || script === "Hani" || script === "Jpan";
}
