// GLIM-64: renders the OCR benchmark corpus (corpus/*.png) and its ground truth (corpus.json).
// Not part of the build; the PNGs and the JSON are committed. Each case records, per block in
// reading order, the language and every line's text and ink box (from measureText), so the
// benchmark can score recognition per line, grouping per block and detection per block.
//
// Two kinds of frame:
// - "rendered": clean UI text on flat backgrounds (dialogs, menus, articles).
// - "screenshot-like": what a capture really looks like: 1x anti-aliased small text, low
//   contrast, outlined subtitles over a busy "video" frame, JPEG artefacts, a game dialogue
//   box over a scene.
//
// Fonts are the Noto files the GLIM-17 spike cached (spikes/inference/scripts/make-samples.ts).
// To re-render:
//   (cd ~/.cache/glimpse-fixture-tools && bun add @napi-rs/canvas@1.1.0)
//   CANVAS=~/.cache/glimpse-fixture-tools/node_modules/@napi-rs/canvas/index.js bun make-corpus.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { createCanvas, GlobalFonts, loadImage } = await import(process.env.CANVAS ?? "@napi-rs/canvas");
const FONTS = process.env.GLIM_FONT_DIR ?? join(homedir(), ".cache", "glim17", "fonts");
for (const family of [
	"Noto Sans",
	"Noto Sans JP",
	"Noto Sans SC",
	"Noto Sans KR",
	"Noto Sans Arabic",
	"Noto Sans Devanagari",
	"Noto Sans Thai",
]) {
	GlobalFonts.registerFromPath(join(FONTS, `${family.replaceAll(" ", "")}.ttf`), family);
}
const DIR = import.meta.dir;
mkdirSync(join(DIR, "corpus"), { recursive: true });

/** Deterministic PRNG (mulberry32) so re-rendering gives the same pixels. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const cases = [];

/**
 * One corpus case. `line()` draws a line of text at a baseline and records its ink box in the
 * current block; `block(lang)` starts the next block (reading order = call order).
 */
function scene(id, width, height, meta) {
	const c = createCanvas(width, height);
	const g = c.getContext("2d");
	const blocks = [];
	let current = null;
	const api = {
		c,
		g,
		block(lang) {
			current = { lang, lines: [] };
			blocks.push(current);
			return api;
		},
		line(text, x, y, { font, color = "#111", align = "left", dir = "ltr", stroke = null } = {}) {
			g.font = font;
			g.textAlign = align;
			g.direction = dir;
			g.textBaseline = "alphabetic";
			if (stroke) {
				g.strokeStyle = stroke.color;
				g.lineWidth = stroke.width;
				g.lineJoin = "round";
				g.strokeText(text, x, y);
			}
			g.fillStyle = color;
			g.fillText(text, x, y);
			const m = g.measureText(text);
			const box = {
				x: Math.round(x - m.actualBoundingBoxLeft),
				y: Math.round(y - m.actualBoundingBoxAscent),
				width: Math.round(m.actualBoundingBoxLeft + m.actualBoundingBoxRight),
				height: Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent),
			};
			current.lines.push({ text, box });
			return api;
		},
		/** A vertical column (CJK vertical-rl): one glyph per step, top to bottom. */
		column(text, x, y, { font, size, color = "#111" }) {
			g.font = font;
			g.textAlign = "center";
			g.textBaseline = "top";
			g.fillStyle = color;
			const chars = [...text];
			for (const [k, ch] of chars.entries()) g.fillText(ch, x, y + k * size * 1.25);
			const box = {
				x: Math.round(x - size / 2),
				y: Math.round(y),
				width: size,
				height: Math.round(chars.length * size * 1.25),
			};
			current.lines.push({ text, box, vertical: true });
			return api;
		},
		async save({ jpeg } = {}) {
			let out = c;
			if (jpeg) {
				// Round-trip through JPEG for compression artefacts (video frames, shared screenshots).
				const img = await loadImage(c.toBuffer("image/jpeg", Math.round(jpeg * 100)));
				out = createCanvas(width, height);
				out.getContext("2d").drawImage(img, 0, 0);
			}
			writeFileSync(join(DIR, "corpus", `${id}.png`), out.toBuffer("image/png"));
			cases.push({ id, image: `corpus/${id}.png`, width, height, ...meta, ...(jpeg ? { jpeg } : {}), blocks });
		},
	};
	return api;
}

const rect = (g, x, y, w, h, fill, r = 0) => {
	g.fillStyle = fill;
	g.beginPath();
	g.roundRect(x, y, w, h, r);
	g.fill();
};
/** A button: rounded rect with centred label; the label is its own block. */
const button = (s, lang, label, x, y, w, h, { fill, color, font }) => {
	rect(s.g, x, y, w, h, fill, 6);
	s.block(lang).line(label, x + w / 2, y + h / 2 + 5, { font, color, align: "center" });
};
/** A busy, moving-video-like background: gradient + blurred blobs + noise. */
function videoBackground(g, w, h, seed) {
	const r = rng(seed);
	const grad = g.createLinearGradient(0, 0, w, h);
	grad.addColorStop(0, "#2a4d6e");
	grad.addColorStop(0.5, "#8a6a3a");
	grad.addColorStop(1, "#3b6b3b");
	g.fillStyle = grad;
	g.fillRect(0, 0, w, h);
	for (let i = 0; i < 40; i++) {
		g.fillStyle = `hsla(${Math.floor(r() * 360)}, 50%, ${30 + Math.floor(r() * 50)}%, 0.35)`;
		g.beginPath();
		g.arc(r() * w, r() * h, 10 + r() * 60, 0, Math.PI * 2);
		g.fill();
	}
	const img = g.getImageData(0, 0, w, h);
	for (let i = 0; i < img.data.length; i += 4) {
		const n = (r() - 0.5) * 30;
		img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
		img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
		img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
	}
	g.putImageData(img, 0, 0);
}

const LATIN = ["en", "de", "fr", "es"];
const CJK = ["ja", "zh-Hans", "ko", "en"];
const CYR = ["ru", "uk", "bg", "en"];
const F = (px, family = "Noto Sans", weight = "") => `${weight ? `${weight} ` : ""}${px}px "${family}"`;

// ---- Latin -----------------------------------------------------------------------------

{
	const s = scene("latin-en-dialog", 520, 200, {
		script: "Latin",
		kind: "rendered",
		sources: LATIN,
		note: "light dialog: title, wrapped body, two buttons",
	});
	rect(s.g, 0, 0, 520, 200, "#f4f4f6");
	s.block("en").line("Save changes to this document?", 24, 42, { font: F(20, "Noto Sans", "600") });
	s.block("en")
		.line("If you close it now, the edits you made since the last", 24, 80, { font: F(15) })
		.line("save will be lost and cannot be recovered.", 24, 102, { font: F(15) });
	button(s, "en", "Cancel", 300, 144, 90, 34, { fill: "#e1e1e6", color: "#111", font: F(14) });
	button(s, "en", "Save", 404, 144, 90, 34, { fill: "#2f6fde", color: "#fff", font: F(14) });
	await s.save();
}
{
	const s = scene("latin-de-settings-dark", 460, 230, {
		script: "Latin",
		kind: "rendered",
		sources: LATIN,
		note: "dark settings list: one label per row",
	});
	rect(s.g, 0, 0, 460, 230, "#1e1f24");
	const items = [
		"Allgemein",
		"Benachrichtigungen anzeigen",
		"Beim Start automatisch öffnen",
		"Sprache und Region",
		"Tastenkürzel",
	];
	for (const [i, t] of items.entries()) s.block("de").line(t, 24, 40 + i * 42, { font: F(16), color: "#e8e8ec" });
	await s.save();
}
{
	const s = scene("latin-fr-article", 600, 210, {
		script: "Latin",
		kind: "rendered",
		sources: LATIN,
		note: "heading + three-line paragraph",
	});
	rect(s.g, 0, 0, 600, 210, "#ffffff");
	s.block("fr").line("Mise à jour disponible", 24, 44, { font: F(24, "Noto Sans", "700") });
	s.block("fr")
		.line("Une nouvelle version de l'application est prête à être", 24, 96, { font: F(17) })
		.line("installée. Elle corrige plusieurs problèmes de stabilité", 24, 124, { font: F(17) })
		.line("et améliore la vitesse de démarrage.", 24, 152, { font: F(17) });
	await s.save();
}
{
	const s = scene("latin-es-small-1x", 420, 70, {
		script: "Latin",
		kind: "screenshot-like",
		sources: LATIN,
		note: "12 px menu bar and status line at 1x",
	});
	rect(s.g, 0, 0, 420, 70, "#ececec");
	for (const [i, t] of ["Archivo", "Editar", "Ver", "Ayuda"].entries())
		s.block("es").line(t, 10 + i * 70, 18, { font: F(12) });
	s.block("es").line("Guardado hace dos minutos en la carpeta Documentos", 10, 56, { font: F(12), color: "#444" });
	await s.save();
}
{
	const s = scene("latin-vi-notice", 560, 130, {
		script: "Latin",
		kind: "rendered",
		sources: ["vi", "en"],
		note: "Vietnamese diacritics",
	});
	rect(s.g, 0, 0, 560, 130, "#fffbea");
	s.block("vi")
		.line("Bạn có muốn cài đặt bản cập nhật mới nhất cho ứng", 20, 46, { font: F(18) })
		.line("dụng này ngay bây giờ không?", 20, 76, { font: F(18) });
	await s.save();
}
{
	const s = scene("latin-en-subtitle-video", 640, 200, {
		script: "Latin",
		kind: "screenshot-like",
		sources: LATIN,
		note: "outlined subtitle over a busy video frame, JPEG q60",
	});
	videoBackground(s.g, 640, 200, 7);
	const opts = { font: F(26, "Noto Sans", "600"), color: "#fff", align: "center", stroke: { color: "#000", width: 5 } };
	s.block("en")
		.line("I told you we should have left", 320, 128, opts)
		.line("before the storm reached the coast.", 320, 164, opts);
	await s.save({ jpeg: 0.6 });
}
{
	const s = scene("latin-en-lowcontrast", 480, 120, {
		script: "Latin",
		kind: "screenshot-like",
		sources: LATIN,
		note: "placeholder and disabled text, about 2.3:1 contrast",
	});
	rect(s.g, 0, 0, 480, 120, "#ffffff");
	rect(s.g, 16, 16, 448, 40, "#f2f2f2", 8);
	s.block("en").line("Search messages and people", 30, 42, { font: F(15), color: "#9b9b9b" });
	s.block("en").line("Sending is turned off while you are offline", 20, 92, { font: F(14), color: "#a3a3a3" });
	await s.save();
}

// ---- Latin, fastText subsets (GLIM-142) ------------------------------------------------
// Subsets with a language ELD lacks (id, sw, uz), so `planDetector` picks fastText lid.176.
// Their own script group so the ELD Latin numbers stay comparable.

{
	const s = scene("latin-id-settings", 480, 300, {
		script: "Latin (fastText)",
		kind: "rendered",
		sources: ["id", "en"],
		note: "Indonesian settings list + buttons (fastText)",
	});
	rect(s.g, 0, 0, 480, 300, "#f6f6f8");
	s.block("id").line("Pengaturan", 24, 40, { font: F(20, "Noto Sans", "600") });
	for (const [i, t] of [
		"Umum",
		"Notifikasi",
		"Privasi dan keamanan",
		"Bahasa dan wilayah",
		"Periksa pembaruan",
	].entries())
		s.block("id").line(t, 24, 84 + i * 36, { font: F(15) });
	button(s, "id", "Batal", 256, 248, 96, 34, { fill: "#e1e1e6", color: "#111", font: F(14) });
	button(s, "id", "Simpan", 364, 248, 96, 34, { fill: "#2f6fde", color: "#fff", font: F(14) });
	await s.save();
}
{
	const s = scene("latin-sw-shop", 560, 220, {
		script: "Latin (fastText)",
		kind: "screenshot-like",
		sources: ["sw", "en"],
		note: "Swahili shop page with an English sign-in button, JPEG q75 (fastText)",
	});
	rect(s.g, 0, 0, 560, 220, "#ffffff");
	s.block("sw").line("Kikapu cha ununuzi", 20, 38, { font: F(19, "Noto Sans", "700") });
	s.block("sw").line("Usafirishaji bure kwa oda zote zaidi ya shilingi elfu hamsini", 20, 74, {
		font: F(14),
		color: "#555",
	});
	button(s, "en", "Sign in with Google", 20, 104, 200, 34, { fill: "#eef0f4", color: "#222", font: F(14) });
	button(s, "sw", "Ongeza kwenye kikapu", 20, 164, 210, 38, { fill: "#f59e0b", color: "#111", font: F(15) });
	button(s, "sw", "Nunua sasa", 246, 164, 140, 38, { fill: "#16a34a", color: "#fff", font: F(15) });
	await s.save({ jpeg: 0.75 });
}
{
	const s = scene("latin-uz-chat", 500, 260, {
		script: "Latin (fastText)",
		kind: "screenshot-like",
		sources: ["uz", "ru", "en"],
		note: "Uzbek (Latin) chat bubbles, 1x (fastText)",
	});
	rect(s.g, 0, 0, 500, 260, "#dfe7ee");
	rect(s.g, 16, 16, 330, 40, "#ffffff", 14);
	s.block("uz").line("Hali yoʻldaman, tirbandlik juda katta", 30, 42, { font: F(15) });
	rect(s.g, 180, 76, 304, 40, "#c7f0c2", 14);
	s.block("uz").line("Xoʻp, bekat oldida kutib turaman", 194, 102, { font: F(15) });
	rect(s.g, 16, 136, 350, 40, "#ffffff", 14);
	s.block("uz").line("Soyabon olishni unutma, yomgʻir yogʻadi", 30, 162, { font: F(15) });
	rect(s.g, 290, 196, 194, 40, "#c7f0c2", 14);
	s.block("uz").line("Katta rahmat, doʻstim!", 304, 222, { font: F(15) });
	await s.save();
}

// ---- CJK -------------------------------------------------------------------------------

{
	const s = scene("cjk-ja-game-dialogue", 640, 240, {
		script: "CJK",
		kind: "screenshot-like",
		sources: CJK,
		note: "game dialogue box over a scene: speaker name + two lines",
	});
	videoBackground(s.g, 640, 240, 21);
	rect(s.g, 20, 110, 600, 116, "rgba(10,12,30,0.82)", 10);
	s.block("ja").line("アリス", 40, 142, { font: F(18, "Noto Sans JP", "700"), color: "#ffd479" });
	s.block("ja")
		.line("この先の森には、夜になると誰も近づかないの。", 40, 178, { font: F(20, "Noto Sans JP"), color: "#fff" })
		.line("それでも行くつもりなら、灯りを持っていって。", 40, 208, { font: F(20, "Noto Sans JP"), color: "#fff" });
	await s.save();
}
{
	const s = scene("cjk-ja-ui-mixed", 520, 170, {
		script: "CJK",
		kind: "rendered",
		sources: CJK,
		note: "Japanese UI with embedded Latin (Wi-Fi, Bluetooth)",
	});
	rect(s.g, 0, 0, 520, 170, "#f7f7f9");
	s.block("ja").line("設定を保存しました", 24, 44, { font: F(22, "Noto Sans JP", "700") });
	s.block("ja").line("Wi-Fiネットワークに接続されています", 24, 92, { font: F(17, "Noto Sans JP") });
	s.block("ja").line("Bluetoothはオフです", 24, 132, { font: F(17, "Noto Sans JP") });
	await s.save();
}
{
	const s = scene("cjk-zh-hans-article", 560, 210, {
		script: "CJK",
		kind: "rendered",
		sources: CJK,
		note: "Simplified Chinese paragraph + buttons",
	});
	rect(s.g, 0, 0, 560, 210, "#ffffff");
	s.block("zh-Hans")
		.line("您的账户已在另一台设备上登录。如果这不是您本人", 24, 48, { font: F(19, "Noto Sans SC") })
		.line("的操作，请立即修改密码并检查安全设置。", 24, 80, { font: F(19, "Noto Sans SC") });
	button(s, "zh-Hans", "取消", 320, 140, 96, 38, { fill: "#e6e6ea", color: "#111", font: F(16, "Noto Sans SC") });
	button(s, "zh-Hans", "修改密码", 430, 140, 110, 38, { fill: "#d33", color: "#fff", font: F(16, "Noto Sans SC") });
	await s.save();
}
{
	const s = scene("cjk-ko-chat", 480, 230, {
		script: "CJK",
		kind: "screenshot-like",
		sources: CJK,
		note: "chat bubbles left and right, 1x",
	});
	rect(s.g, 0, 0, 480, 230, "#b2c7da");
	rect(s.g, 16, 16, 300, 40, "#ffffff", 14);
	s.block("ko").line("오늘 저녁에 시간 괜찮아요?", 30, 42, { font: F(16, "Noto Sans KR") });
	rect(s.g, 170, 76, 294, 40, "#fee500", 14);
	s.block("ko").line("네, 일곱 시 이후에는 괜찮아요", 184, 102, { font: F(16, "Noto Sans KR") });
	rect(s.g, 16, 136, 360, 70, "#ffffff", 14);
	s.block("ko")
		.line("그럼 역 앞 카페에서 만나요. 도착하면", 30, 164, { font: F(16, "Noto Sans KR") })
		.line("메시지 보내 주세요.", 30, 190, { font: F(16, "Noto Sans KR") });
	await s.save();
}
{
	const s = scene("cjk-ja-vertical", 260, 380, {
		script: "CJK",
		kind: "rendered",
		sources: CJK,
		note: "vertical-rl: three columns, right to left",
	});
	rect(s.g, 0, 0, 260, 380, "#fbf8f0");
	const col = { font: F(24, "Noto Sans JP"), size: 24 };
	s.block("ja")
		.column("春はあけぼの", 210, 20, col)
		.column("やうやう白く", 160, 20, col)
		.column("なりゆく山ぎは", 110, 20, col);
	await s.save();
}

// ---- Arabic ----------------------------------------------------------------------------

{
	const s = scene("arabic-ar-article", 560, 190, {
		script: "Arabic",
		kind: "rendered",
		sources: ["ar", "en"],
		note: "RTL heading + right-aligned two-line paragraph",
	});
	rect(s.g, 0, 0, 560, 190, "#ffffff");
	const rtl = (px, w) => ({ font: F(px, "Noto Sans Arabic", w), align: "right", dir: "rtl" });
	s.block("ar").line("تحديث جديد متاح", 536, 46, rtl(24, "700"));
	s.block("ar")
		.line("يتضمن هذا الإصدار تحسينات في الأداء وإصلاحات", 536, 102, rtl(18))
		.line("لعدة مشكلات أبلغ عنها المستخدمون.", 536, 138, rtl(18));
	await s.save();
}
{
	const s = scene("arabic-ar-ui-dark", 480, 170, {
		script: "Arabic",
		kind: "screenshot-like",
		sources: ["ar", "en"],
		note: "dark UI, label + two buttons, JPEG q75",
	});
	rect(s.g, 0, 0, 480, 170, "#202226");
	s.block("ar").line("هل تريد حذف هذه الرسالة نهائياً؟", 456, 52, {
		font: F(18, "Noto Sans Arabic"),
		color: "#eee",
		align: "right",
		dir: "rtl",
	});
	button(s, "ar", "حذف", 340, 104, 116, 40, { fill: "#c33", color: "#fff", font: F(17, "Noto Sans Arabic") });
	button(s, "ar", "إلغاء", 210, 104, 116, 40, { fill: "#3a3d44", color: "#eee", font: F(17, "Noto Sans Arabic") });
	await s.save({ jpeg: 0.75 });
}

// ---- Cyrillic --------------------------------------------------------------------------

{
	const s = scene("cyrillic-ru-dialog", 540, 200, {
		script: "Cyrillic",
		kind: "rendered",
		sources: CYR,
		note: "Russian dialog: title, body, buttons",
	});
	rect(s.g, 0, 0, 540, 200, "#f4f4f6");
	s.block("ru").line("Сохранить изменения?", 24, 42, { font: F(20, "Noto Sans", "600") });
	s.block("ru")
		.line("Если закрыть документ сейчас, все несохранённые", 24, 80, { font: F(15) })
		.line("изменения будут потеряны без возможности восстановления.", 24, 102, { font: F(15) });
	button(s, "ru", "Отмена", 300, 144, 100, 34, { fill: "#e1e1e6", color: "#111", font: F(14) });
	button(s, "ru", "Сохранить", 414, 144, 110, 34, { fill: "#2f6fde", color: "#fff", font: F(14) });
	await s.save();
}
{
	const s = scene("cyrillic-uk-subtitle-video", 640, 200, {
		script: "Cyrillic",
		kind: "screenshot-like",
		sources: CYR,
		note: "Ukrainian outlined subtitle over video, JPEG q60",
	});
	videoBackground(s.g, 640, 200, 33);
	const opts = { font: F(26, "Noto Sans", "600"), color: "#fff", align: "center", stroke: { color: "#000", width: 5 } };
	s.block("uk").line("Ми повернемося додому", 320, 128, opts).line("ще до світанку, обіцяю.", 320, 164, opts);
	await s.save({ jpeg: 0.6 });
}
{
	const s = scene("cyrillic-bg-menu", 420, 180, {
		script: "Cyrillic",
		kind: "rendered",
		sources: CYR,
		note: "Bulgarian menu items (generic Cyrillic recogniser)",
	});
	rect(s.g, 0, 0, 420, 180, "#ffffff");
	for (const [i, t] of ["Нов прозорец", "Отваряне на файл", "Последни документи", "Изход"].entries()) {
		s.block("bg").line(t, 24, 36 + i * 40, { font: F(16) });
	}
	await s.save();
}

// ---- Devanagari ------------------------------------------------------------------------

{
	const s = scene("devanagari-hi-article", 580, 190, {
		script: "Devanagari",
		kind: "rendered",
		sources: ["hi", "en"],
		note: "Hindi heading + two-line paragraph",
	});
	rect(s.g, 0, 0, 580, 190, "#ffffff");
	s.block("hi").line("नया अपडेट उपलब्ध है", 24, 48, { font: F(24, "Noto Sans Devanagari", "700") });
	s.block("hi")
		.line("इस संस्करण में प्रदर्शन में सुधार और उपयोगकर्ताओं", 24, 104, { font: F(18, "Noto Sans Devanagari") })
		.line("द्वारा बताई गई कई समस्याओं के समाधान शामिल हैं।", 24, 140, { font: F(18, "Noto Sans Devanagari") });
	await s.save();
}
{
	const s = scene("devanagari-hi-ui-dark", 480, 170, {
		script: "Devanagari",
		kind: "screenshot-like",
		sources: ["hi", "en"],
		note: "dark UI label + buttons, JPEG q75",
	});
	rect(s.g, 0, 0, 480, 170, "#1f2329");
	s.block("hi").line("क्या आप यह संदेश हटाना चाहते हैं?", 24, 52, { font: F(18, "Noto Sans Devanagari"), color: "#eee" });
	button(s, "hi", "रद्द करें", 220, 104, 116, 40, { fill: "#3a3d44", color: "#eee", font: F(16, "Noto Sans Devanagari") });
	button(s, "hi", "हटाएँ", 348, 104, 116, 40, { fill: "#c33", color: "#fff", font: F(16, "Noto Sans Devanagari") });
	await s.save({ jpeg: 0.75 });
}

// ---- Others: Thai, Greek, mixed screen --------------------------------------------------

{
	const s = scene("thai-th-notice", 520, 130, {
		script: "Thai",
		kind: "rendered",
		sources: ["th", "en"],
		note: "Thai, no spaces between words",
	});
	rect(s.g, 0, 0, 520, 130, "#ffffff");
	s.block("th").line("บันทึกการตั้งค่าเรียบร้อยแล้ว", 20, 50, { font: F(22, "Noto Sans Thai") });
	s.block("th").line("กรุณาเริ่มโปรแกรมใหม่อีกครั้ง", 20, 100, { font: F(18, "Noto Sans Thai") });
	await s.save();
}
{
	const s = scene("greek-el-dialog", 500, 140, {
		script: "Greek",
		kind: "rendered",
		sources: ["el", "en"],
		note: "Greek title + body",
	});
	rect(s.g, 0, 0, 500, 140, "#f4f4f6");
	s.block("el").line("Αποθήκευση αλλαγών;", 24, 44, { font: F(20, "Noto Sans", "600") });
	s.block("el").line("Οι αλλαγές σας θα χαθούν αν κλείσετε το παράθυρο.", 24, 92, { font: F(15) });
	await s.save();
}
{
	const s = scene("mixed-ja-en-window", 760, 300, {
		script: "Mixed",
		kind: "screenshot-like",
		sources: ["ja", "en", "de"],
		note: "one window, Japanese and English blocks; detection must tell them apart",
	});
	rect(s.g, 0, 0, 760, 300, "#d9dde3");
	rect(s.g, 30, 24, 700, 252, "#ffffff", 10);
	rect(s.g, 30, 24, 700, 36, "#eef0f3", 10);
	s.block("ja").line("ダウンロードが完了しました", 50, 49, { font: F(15, "Noto Sans JP") });
	s.block("en")
		.line("The file was saved to your Downloads folder. You can", 50, 102, { font: F(16) })
		.line("open it now or find it later in the list of recent files.", 50, 126, { font: F(16) });
	s.block("ja")
		.line("ファイルはダウンロードフォルダーに保存されました。", 50, 182, { font: F(16, "Noto Sans JP") })
		.line("今すぐ開くか、後で最近のファイルから探してください。", 50, 208, { font: F(16, "Noto Sans JP") });
	button(s, "en", "Open file", 600, 232, 110, 32, { fill: "#2f6fde", color: "#fff", font: F(14) });
	await s.save();
}
{
	// GLIM-125: with a CJK language in the subset `ch` reads first, and it reads Cyrillic as
	// Latin look-alikes; the look-alike rule must hand those lines to eslav.
	const s = scene("mixed-ja-ru-window", 640, 240, {
		script: "Mixed",
		kind: "rendered",
		sources: ["ja", "ru", "en"],
		note: "Japanese, Russian and English blocks in one window (ch reads first)",
	});
	rect(s.g, 0, 0, 640, 240, "#d9dde3");
	rect(s.g, 20, 16, 600, 208, "#ffffff", 10);
	s.block("ja").line("設定を保存しますか", 40, 52, { font: F(18, "Noto Sans JP", "600") });
	s.block("ru").line("Настройки будут применены после перезапуска.", 40, 96, { font: F(16) });
	s.block("en").line("Settings apply after a restart.", 40, 134, { font: F(16) });
	button(s, "ru", "Отмена", 360, 172, 110, 34, { fill: "#e1e1e6", color: "#111", font: F(14) });
	button(s, "ru", "ПРИМЕНИТЬ", 484, 172, 120, 34, { fill: "#2f6fde", color: "#fff", font: F(14, "Noto Sans", "600") });
	await s.save();
}

writeFileSync(join(DIR, "corpus.json"), `${JSON.stringify({ schema: 1, cases }, null, "\t")}\n`);
console.log(`wrote ${cases.length} cases`);
