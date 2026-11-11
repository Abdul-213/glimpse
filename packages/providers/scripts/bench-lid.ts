// Cost of GLIM-49 detection: ELD load time and RSS, ms per block for the detector alone and for
// the full GLIM-21 rule pass.   bun scripts/bench-lid.ts
import { type DetectInput, detectCaptureLanguages, languageCode } from "@glimpse/core";
import { loadEldDetector } from "../src/language-detect/eld.ts";

const rss0 = process.memoryUsage().rss;
const t0 = performance.now();
const eld = await loadEldDetector();
const loadMs = performance.now() - t0;
const rssMb = (process.memoryUsage().rss - rss0) / 1e6;

const texts = [
	"Settings saved successfully.",
	"Möchten Sie die Änderungen übernehmen?",
	"Вы хотите установить обновление?",
	"¿Quieres guardar los cambios?",
	"設定を保存しました",
	"请输入您的密码。",
	"OK",
	"Weiter",
	"Vergiss nicht, das Update zu installieren.",
	"설정이 저장되었습니다",
];
const N = 20_000;
let t = performance.now();
for (let i = 0; i < N; i++) eld.detect(texts[i % texts.length] as string);
const detectMs = (performance.now() - t) / N;

const blocks: DetectInput[] = texts.map((text, i) => ({ id: `b${i}`, text, confidence: 0.95 }));
const opts = { subset: ["de", "ja", "es"].map(languageCode), target: languageCode("en"), detector: eld };
t = performance.now();
const R = 2000;
for (let i = 0; i < R; i++) detectCaptureLanguages(blocks, opts);
const ruleMs = (performance.now() - t) / (R * blocks.length);

console.log(`| ELD medium load | ${loadMs.toFixed(0)} ms |`);
console.log(`| RSS after load | +${rssMb.toFixed(0)} MB |`);
console.log(`| eld.detect per block | ${detectMs.toFixed(3)} ms |`);
console.log(`| full rule pass per block (10-block capture) | ${ruleMs.toFixed(3)} ms |`);
