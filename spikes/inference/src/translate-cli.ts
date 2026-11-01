// Quick Bergamot check: bun src/translate-cli.ts
// Translates fixed sentences ja->en, zh->en, de->en, en->de and pivots ja->en->de.
import { join } from "node:path";
import { loadPack, loadRuntime, Translator } from "./bergamot";

const dir = join(import.meta.dir, "..", "models", "bergamot");
const t0 = performance.now();
const { mod, gemm } = await loadRuntime(dir);
console.log(`runtime ${(performance.now() - t0).toFixed(0)} ms; gemm: ${gemm}`);

const packs: Record<string, ReturnType<typeof loadPack>> = {};
for (const p of ["ja-en", "zh-Hans-en", "de-en", "en-de"]) {
  const t = performance.now();
  packs[p] = loadPack(mod, join(dir, p));
  console.log(`load ${p} v${packs[p].manifest.version} ${(performance.now() - t).toFixed(0)} ms`);
}
const tr = new Translator(mod);
const m = (k: string) => {
  const p = packs[k];
  if (!p) throw new Error(k);
  return p.model;
};
const cases: [string, string, string[], string?][] = [
  ["ja→en", "ja-en", ["設定を保存しました。", "このアイテムを使用しますか？", "明日の会議は午後三時に始まります。"]],
  ["zh→en", "zh-Hans-en", ["你好，世界！", "请输入您的密码。", "这个游戏的剧情非常精彩。"]],
  ["de→en", "de-en", ["Einstellungen", "Die Datei konnte nicht gespeichert werden.", "Wir sehen uns morgen am Bahnhof."]],
  ["en→de", "en-de", ["Settings", "The file could not be saved.", "See you tomorrow at the station."]],
  ["ja→en→de", "ja-en", ["設定を保存しました。", "明日の会議は午後三時に始まります。"], "en-de"],
];
for (const [label, a, texts, b] of cases) {
  // First call per route warms caches; time the second.
  tr.translate(texts.slice(0, 1), m(a), b ? m(b) : undefined);
  const t = performance.now();
  const out = tr.translate(texts, m(a), b ? m(b) : undefined);
  const ms = performance.now() - t;
  console.log(`\n${label}  (${ms.toFixed(0)} ms for ${texts.length} sentences, batch)`);
  texts.forEach((s, i) => console.log(`  ${s}\n    -> ${out[i]}`));
}
console.log(`\nRSS ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
