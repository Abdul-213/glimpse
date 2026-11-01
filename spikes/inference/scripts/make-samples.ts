// Renders the benchmark/test images to samples/*.png with @napi-rs/canvas (Skia + HarfBuzz,
// so Arabic/Devanagari/Thai shape correctly). Fonts (Noto, OFL) are fetched once into
// ~/.cache/glim17/fonts. Run: bun scripts/make-samples.ts
import { type Canvas, createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FONT_DIR = process.env.GLIM_FONT_DIR ?? join(homedir(), ".cache", "glim17", "fonts");
const GF = "https://raw.githubusercontent.com/google/fonts/main/ofl";
const FONTS: Record<string, string> = {
  "Noto Sans": "notosans/NotoSans%5Bwdth,wght%5D.ttf",
  "Noto Sans JP": "notosansjp/NotoSansJP%5Bwght%5D.ttf",
  "Noto Sans SC": "notosanssc/NotoSansSC%5Bwght%5D.ttf",
  "Noto Sans KR": "notosanskr/NotoSansKR%5Bwght%5D.ttf",
  "Noto Sans Arabic": "notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf",
  "Noto Sans Devanagari": "notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf",
  "Noto Sans Thai": "notosansthai/NotoSansThai%5Bwdth,wght%5D.ttf",
};

async function fonts(): Promise<void> {
  mkdirSync(FONT_DIR, { recursive: true });
  for (const [family, path] of Object.entries(FONTS)) {
    const dest = join(FONT_DIR, family.replaceAll(" ", "") + ".ttf");
    if (!existsSync(dest)) {
      const r = await fetch(`${GF}/${path}`);
      if (!r.ok) throw new Error(`font ${family}: ${r.status}`);
      writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
    }
    GlobalFonts.registerFromPath(dest, family);
  }
}

const OUT = join(import.meta.dir, "..", "samples");

function save(name: string, canvas: Canvas): void {
  writeFileSync(join(OUT, name), canvas.toBuffer("image/png"));
  console.log("wrote samples/" + name);
}

/** 600x200 region with ~5 lines: the "Live re-OCR of a small region" case. */
function region(name: string, family: string, lines: string[], opts: { rtl?: boolean; size?: number; bg?: string; fg?: string } = {}): void {
  const c = createCanvas(600, 200);
  const g = c.getContext("2d");
  g.fillStyle = opts.bg ?? "#ffffff";
  g.fillRect(0, 0, 600, 200);
  g.fillStyle = opts.fg ?? "#1a1a1a";
  const size = opts.size ?? 22;
  g.font = `${size}px "${family}"`;
  g.textBaseline = "top";
  g.direction = opts.rtl ? "rtl" : "ltr";
  g.textAlign = opts.rtl ? "right" : "left";
  lines.forEach((l, i) => g.fillText(l, opts.rtl ? 580 : 16, 12 + i * 37));
  save(name, c);
}

function windowChrome(g: SKRSContext2D, x: number, y: number, w: number, h: number, title: string, dark = false): void {
  g.fillStyle = dark ? "#1f2329" : "#ffffff";
  g.fillRect(x, y, w, h);
  g.fillStyle = dark ? "#2b3038" : "#e9ebef";
  g.fillRect(x, y, w, 36);
  g.fillStyle = dark ? "#d6d9de" : "#30343a";
  g.font = `15px "Noto Sans JP"`;
  g.textBaseline = "middle";
  g.fillText(title, x + 14, y + 18);
  g.textBaseline = "top";
}

/** Full 1920x1080 desktop-like screenshot: settings window, chat, game dialogue box, subtitles. */
function screenshot(): void {
  const c = createCanvas(1920, 1080);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1920, 1080);
  grad.addColorStop(0, "#3a5f7d");
  grad.addColorStop(1, "#7b4d6b");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1920, 1080);
  g.textBaseline = "top";

  // Settings window (Japanese UI)
  windowChrome(g, 80, 80, 720, 520, "設定 — Glimpse Sample");
  g.fillStyle = "#222";
  g.font = `20px "Noto Sans JP"`;
  ["一般", "表示", "ショートカット", "アカウント", "詳細設定"].forEach((t, i) => g.fillText(t, 104, 140 + i * 48));
  g.font = `18px "Noto Sans JP"`;
  ["起動時に自動的に開く", "通知を表示する", "翻訳先の言語：英語", "変更を保存しますか？"].forEach((t, i) => g.fillText(t, 330, 140 + i * 48));
  g.fillStyle = "#2f6fdf";
  g.fillRect(600, 530, 170, 44);
  g.fillStyle = "#fff";
  g.fillText("保存する", 649, 541);

  // Chat window (Chinese + German)
  windowChrome(g, 880, 80, 900, 460, "Chat", true);
  g.font = `19px "Noto Sans SC"`;
  const chat: [string, string][] = [
    ["Li Wei", "你好！今天晚上一起玩游戏吗？"],
    ["Anna", "Ja, gerne! Ich bin um acht Uhr online."],
    ["Li Wei", "好的，我们在服务器上见。"],
    ["Anna", "Vergiss nicht, das Update zu installieren."],
    ["Li Wei", "已经下载好了，谢谢提醒。"],
  ];
  chat.forEach(([who, msg], i) => {
    g.fillStyle = "#8ab4f8";
    g.font = `16px "Noto Sans"`;
    g.fillText(who, 910, 140 + i * 72);
    g.fillStyle = "#e8eaed";
    g.font = `19px "Noto Sans SC"`;
    g.fillText(msg, 910, 164 + i * 72);
  });

  // Game dialogue box (Korean)
  g.fillStyle = "rgba(10,10,20,0.82)";
  g.fillRect(160, 700, 1600, 200);
  g.fillStyle = "#ffd76a";
  g.font = `24px "Noto Sans KR"`;
  g.fillText("상인", 200, 724);
  g.fillStyle = "#ffffff";
  g.font = `26px "Noto Sans KR"`;
  g.fillText("어서 오세요! 오늘은 특별한 물건이 많이 있습니다.", 200, 772);
  g.fillText("무엇을 도와드릴까요?", 200, 824);

  // Subtitle (English, white on dark band)
  g.fillStyle = "rgba(0,0,0,0.6)";
  g.fillRect(560, 950, 800, 56);
  g.fillStyle = "#fff";
  g.font = `28px "Noto Sans"`;
  g.textAlign = "center";
  g.fillText("We have to leave before the storm arrives.", 960, 961);
  save("screen-1920x1080.png", c);
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  await fonts();
  region("region-en.png", "Noto Sans", ["Settings saved successfully.", "Do you want to install the update now?", "Your session will expire in 5 minutes.", "Click Continue to keep working.", "Error 404: file not found"]);
  region("region-de.png", "Noto Sans", ["Die Datei konnte nicht gespeichert werden.", "Möchten Sie die Änderungen übernehmen?", "Wir sehen uns morgen am Bahnhof.", "Größe: 12 MB · Übertragung läuft", "Abbrechen   Weiter"]);
  region("region-ja.png", "Noto Sans JP", ["設定を保存しました。", "このアイテムを使用しますか？", "明日の会議は午後三時に始まります。", "ダウンロードが完了しました", "キャンセル　　次へ"]);
  region("region-zh.png", "Noto Sans SC", ["你好，世界！", "请输入您的密码。", "这个游戏的剧情非常精彩。", "下载已完成，请重新启动。", "取消　　确定"]);
  region("region-ko.png", "Noto Sans KR", ["설정이 저장되었습니다.", "이 아이템을 사용하시겠습니까?", "내일 회의는 오후 세 시에 시작합니다.", "다운로드가 완료되었습니다", "취소   다음"]);
  region("region-ru.png", "Noto Sans", ["Настройки сохранены.", "Вы хотите установить обновление?", "Встретимся завтра на вокзале.", "Загрузка завершена", "Отмена   Далее"]);
  region("region-ar.png", "Noto Sans Arabic", ["تم حفظ الإعدادات بنجاح", "هل تريد تثبيت التحديث الآن؟", "سنلتقي غداً في المحطة", "اكتمل التنزيل"], { rtl: true });
  region("region-hi.png", "Noto Sans Devanagari", ["सेटिंग्स सहेजी गईं", "क्या आप अभी अपडेट करना चाहते हैं?", "कल स्टेशन पर मिलते हैं", "डाउनलोड पूरा हुआ"]);
  region("region-th.png", "Noto Sans Thai", ["บันทึกการตั้งค่าแล้ว", "คุณต้องการติดตั้งการอัปเดตหรือไม่", "พบกันพรุ่งนี้ที่สถานี", "ดาวน์โหลดเสร็จแล้ว"]);
  region("region-game-dark.png", "Noto Sans JP", ["勇者よ、よくぞ来た！", "この先は危険な森だ。", "準備はできているか？", "▶ はい　　いいえ"], { bg: "#15182a", fg: "#f4f1e6", size: 24 });
  screenshot();
}
