// @glimpse/providers: OCR and translation engines behind the @glimpse/core provider
// interfaces. May use Bun APIs, fetch, WASM and onnxruntime; never Electrobun
// (ARCHITECTURE.md section 4). One folder per engine: src/ocr/<engine>, src/translation/<engine>,
// plus language detectors behind core's LanguageDetector port in src/language-detect/.

export * from "./language-detect/index.ts";
export * from "./ocr/paddle/index.ts";
export * from "./translation/bergamot/index.ts";
