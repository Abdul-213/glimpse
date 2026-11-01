// GLIM-49: per-block language detection (rules from docs/decisions/GLIM-21-language-detection.md).
// The detector library is a port (`LanguageDetector`); the ELD implementation is in
// @glimpse/providers (src/language-detect/).

export * from "./decide.ts";
export * from "./detector.ts";
export * from "./normalize.ts";
export * from "./scripts.ts";
export * from "./session.ts";
