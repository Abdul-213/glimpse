// Bun Worker that owns one Bergamot runtime, so translation never blocks the main thread.
// Messages: {type:"init", dir, packs:string[]} -> {type:"ready", ms}
//           {type:"translate", id, texts, route:string[]} -> {type:"result", id, texts, ms}
import { join } from "node:path";
import { type BergamotModule, loadPack, loadRuntime, type TranslationModel, Translator } from "./bergamot";

declare const self: Worker;

let tr: Translator | null = null;
let mod: BergamotModule | null = null;
const models = new Map<string, TranslationModel>();

type Msg = { type: "init"; dir: string; packs: string[] } | { type: "translate"; id: number; texts: string[]; route: string[] };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      mod = (await loadRuntime(m.dir)).mod;
      for (const p of m.packs) models.set(p, loadPack(mod, join(m.dir, p)).model);
      tr = new Translator(mod);
      self.postMessage({ type: "ready", ms: performance.now() - t0 });
    } else {
      if (!tr) throw new Error("not initialised");
      const [a, b] = m.route.map((r) => {
        const x = models.get(r);
        if (!x) throw new Error(`pack ${r} not loaded`);
        return x;
      });
      const t0 = performance.now();
      const texts = tr.translate(m.texts, a!, b);
      self.postMessage({ type: "result", id: m.id, texts, ms: performance.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: "id" in m ? m.id : -1, error: String(err) });
  }
};
