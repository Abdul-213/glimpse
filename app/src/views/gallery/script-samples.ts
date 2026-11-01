// Font fallback and RTL test matrix (GLIM-51). One sample per script group the
// translation model covers (NLLB-200's scripts), plus the bidi and length cases popups
// must survive. `script` is the ISO 15924 code the tag resolves to; a test checks it.

export interface ScriptSample {
	/** BCP-47 tag the block would carry. */
	lang: string;
	/** ISO 15924 script, as `Intl.Locale(lang).maximize().script` gives it. */
	script: string;
	/** Short phrase in that language. */
	text: string;
	/** Fonts expected to render it (from the stacks in .impeccable/design.json, or OS fallback). */
	macos: string;
	windows: string;
	/** What to look at: conjuncts, stacked marks, joining, line height. */
	check?: string;
}

export const SCRIPT_SAMPLES: readonly ScriptSample[] = [
	{
		lang: "en",
		script: "Latn",
		text: "The quick brown fox jumps over the lazy dog.",
		macos: "SF Pro",
		windows: "Segoe UI Variable",
	},
	{
		lang: "vi",
		script: "Latn",
		text: "Tiếng Việt có dấu: ắ ằ ẳ ẵ ặ, ở đây.",
		macos: "SF Pro",
		windows: "Segoe UI Variable",
		check: "stacked diacritics clear the line above",
	},
	{
		lang: "ru",
		script: "Cyrl",
		text: "Съешь же ещё этих мягких французских булок, да выпей чаю.",
		macos: "SF Pro",
		windows: "Segoe UI Variable",
	},
	{
		lang: "el",
		script: "Grek",
		text: "Γειά σου κόσμε· ξεσκεπάζω την ψυχοφθόρα βδελυγμία.",
		macos: "SF Pro",
		windows: "Segoe UI Variable",
	},
	{ lang: "ka", script: "Geor", text: "გამარჯობა მსოფლიო", macos: "Helvetica (system fallback)", windows: "Segoe UI" },
	{ lang: "hy", script: "Armn", text: "Բարեւ աշխարհ", macos: "Mshtakan (system fallback)", windows: "Segoe UI" },
	{ lang: "am", script: "Ethi", text: "ሰላም ዓለም", macos: "Kefa", windows: "Ebrima" },
	{ lang: "zgh", script: "Tfng", text: "ⴰⵣⵓⵍ ⴼⵍⵍⴰⵡⵏ", macos: "system fallback (verify)", windows: "Ebrima" },
	{
		lang: "ar",
		script: "Arab",
		text: "تم حفظ الملف في مجلد «المستندات» بنجاح.",
		macos: "SF Arabic",
		windows: "Segoe UI",
		check: "letters join; 16px step; no letter-spacing",
	},
	{ lang: "fa", script: "Arab", text: "سلام دنیا، این یک آزمایش است.", macos: "SF Arabic", windows: "Segoe UI" },
	{
		lang: "ur",
		script: "Arab",
		text: "اردو ایک خوبصورت زبان ہے۔",
		macos: "Noto Nastaliq Urdu",
		windows: "Urdu Typesetting if installed, else Segoe UI (naskh)",
		check: "Nastaliq needs the 2.0 leading",
	},
	{ lang: "he", script: "Hebr", text: "שלום עולם, זוהי בדיקה.", macos: "SF Hebrew", windows: "Segoe UI" },
	{
		lang: "hi",
		script: "Deva",
		text: "नमस्ते दुनिया, क्षत्रिय और द्वारा।",
		macos: "Kohinoor Devanagari",
		windows: "Nirmala UI",
		check: "conjuncts and the headstroke",
	},
	{ lang: "bn", script: "Beng", text: "হ্যালো বিশ্ব, এটি একটি পরীক্ষা।", macos: "Kohinoor Bangla", windows: "Nirmala UI" },
	{
		lang: "pa",
		script: "Guru",
		text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਦੁਨੀਆ",
		macos: "Gurmukhi MN (system fallback)",
		windows: "Nirmala UI",
	},
	{
		lang: "gu",
		script: "Gujr",
		text: "નમસ્તે દુનિયા",
		macos: "Gujarati Sangam MN (system fallback)",
		windows: "Nirmala UI",
	},
	{ lang: "or", script: "Orya", text: "ନମସ୍କାର ଦୁନିଆ", macos: "Oriya Sangam MN (system fallback)", windows: "Nirmala UI" },
	{ lang: "ta", script: "Taml", text: "வணக்கம் உலகம்", macos: "Tamil Sangam MN (system fallback)", windows: "Nirmala UI" },
	{
		lang: "te",
		script: "Telu",
		text: "నమస్కారం ప్రపంచం",
		macos: "Kohinoor Telugu (system fallback)",
		windows: "Nirmala UI",
	},
	{
		lang: "kn",
		script: "Knda",
		text: "ನಮಸ್ಕಾರ ಜಗತ್ತು",
		macos: "Kannada Sangam MN (system fallback)",
		windows: "Nirmala UI",
	},
	{
		lang: "ml",
		script: "Mlym",
		text: "നമസ്കാരം ലോകം",
		macos: "Malayalam Sangam MN (system fallback)",
		windows: "Nirmala UI",
	},
	{
		lang: "si",
		script: "Sinh",
		text: "ආයුබෝවන් ලෝකය",
		macos: "Sinhala Sangam MN (system fallback)",
		windows: "Nirmala UI",
	},
	{
		lang: "th",
		script: "Thai",
		text: "สวัสดีชาวโลก นี่คือการทดสอบ",
		macos: "Thonburi",
		windows: "Leelawadee UI",
		check: "marks above and below; no clipping",
	},
	{ lang: "lo", script: "Laoo", text: "ສະບາຍດີ ໂລກ", macos: "Lao Sangam MN", windows: "Lao UI or Leelawadee UI" },
	{ lang: "km", script: "Khmr", text: "សួស្តី ពិភពលោក", macos: "Khmer Sangam MN", windows: "Khmer UI or Leelawadee UI" },
	{
		lang: "my",
		script: "Mymr",
		text: "မင်္ဂလာပါ ကမ္ဘာလောက",
		macos: "Myanmar Sangam MN",
		windows: "Myanmar Text",
		check: "tall stacks need the 1.9 leading",
	},
	{ lang: "bo", script: "Tibt", text: "བཀྲ་ཤིས་བདེ་ལེགས།", macos: "Kailasa", windows: "Microsoft Himalaya" },
	{
		lang: "ja",
		script: "Jpan",
		text: "吾輩は猫である。名前はまだ無い。",
		macos: "Hiragino Sans",
		windows: "Yu Gothic UI",
		check: "Japanese glyph forms; strict line breaks",
	},
	{
		lang: "zh-Hans",
		script: "Hans",
		text: "按任意键继续。保存失败，是否重试？",
		macos: "PingFang SC",
		windows: "Microsoft YaHei UI",
	},
	{
		lang: "zh-Hant",
		script: "Hant",
		text: "按任意鍵繼續。儲存失敗，是否重試？",
		macos: "PingFang TC",
		windows: "Microsoft JhengHei UI",
		check: "Traditional forms, not Simplified",
	},
	{
		lang: "ko",
		script: "Kore",
		text: "계속하려면 아무 키나 누르세요.",
		macos: "Apple SD Gothic Neo",
		windows: "Malgun Gothic",
		check: "keep-all: words don't break mid-word",
	},
];

export interface BidiCase {
	label: string;
	lang: string;
	text: string;
	/** What correct rendering looks like. */
	expect: string;
}

export const BIDI_CASES: readonly BidiCase[] = [
	{
		label: "Hebrew with a number and an English word",
		lang: "he",
		text: "גרסה 3.2 זמינה – לחצו על Update",
		expect: "Right-aligned; “3.2” and “Update” read left to right inside the line.",
	},
	{
		label: "Arabic with a size in parentheses",
		lang: "ar",
		text: "حدّث إلى الإصدار 3.2 (12 MB)",
		expect: "Right-aligned; the parentheses mirror around “12 MB”.",
	},
	{
		label: "English with an Arabic file name",
		lang: "en",
		text: "Open «تقرير.pdf» from Documents.",
		expect: "Left-aligned; the Arabic name stays one run.",
	},
	{
		label: "Arabic with a URL and a phone number",
		lang: "ar",
		text: "زوروا example.com/ar أو اتصلوا على ‎+1 555 0100",
		expect: "Right-aligned; URL and number keep their order.",
	},
	{
		label: "RTL text starting with a Latin word",
		lang: "ar",
		text: "Glimpse يترجم النص على جهازك",
		expect: "dir=auto sees “G” first, so this line is left-aligned. Known limit of first-strong detection.",
	},
	{
		label: "Two paragraphs, two directions, one block",
		lang: "he",
		text: "שלום, זה חלון התרגום.\nThis second line is English.",
		expect: "Each line aligns to its own direction (unicode-bidi: plaintext).",
	},
];

export const LENGTH_CASES = {
	short: "OK",
	compound: "Donaudampfschifffahrtsgesellschaftskapitänsmütze",
	url: "https://example.com/a/very/long/path/that/never/breaks/on/its/own?with=query&and=more",
	paragraph:
		"Long blocks wrap at the popup's measure and are never truncated or clamped. This paragraph is long enough to wrap several times at the 480px maximum width, so the line height, the measure and the space between blocks can be judged on real text rather than a single line.",
} as const;
