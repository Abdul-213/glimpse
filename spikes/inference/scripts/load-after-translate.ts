// Does loading a second pack after translating with the first break the runtime?
// (Reported by @molecule/api-ai-translation-bergamot as "memory access out of bounds".)
//   bun scripts/load-after-translate.ts
import { join } from "node:path";
import { loadPack, loadRuntime, Translator } from "../src/bergamot";
import { MODELS } from "../src/models";

const dir = join(MODELS, "bergamot");
const { mod } = await loadRuntime(dir);
const tr = new Translator(mod);
const order = ["en-de", "ja-en", "de-en", "zh-Hans-en"];
const loaded: Record<string, ReturnType<typeof loadPack>["model"]> = {};
const probe: Record<string, string> = { "en-de": "The file could not be saved.", "ja-en": "設定を保存しました。", "de-en": "Wir sehen uns morgen.", "zh-Hans-en": "请输入您的密码。" };
for (const p of order) {
  loaded[p] = loadPack(mod, join(dir, p)).model;
  for (const q of Object.keys(loaded)) console.log(`after loading ${p}: ${q} -> ${tr.translate([probe[q]!], loaded[q]!)[0]}`);
}
console.log(`peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
