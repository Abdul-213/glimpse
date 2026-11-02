// GLIM-142: text fixtures for calibrating language detection on the languages ELD can't cover,
// where `planDetector` switches to fastText lid.176 (GLIM-104). Each capture is what one Snip
// of a window would hand the detector after OCR: its blocks in reading order with the
// expected language, and the source subset a user reading it would plausibly have. Target is
// always English.
//
// Kinds: `ui` (settings lists, menus, dialogs with buttons: mostly 1-3 word labels), `chat`
// (one message per block), `article` (sentences), `mixed` (a window in the subset language
// with English or Russian blocks in it). Several labels are spelled the same in a neighbouring
// language (gl "Cancelar" = es/pt, mk "Нов прозорец" = bg, ne "सामान्य" = hi, ps "تنظیمات" = fa):
// that is what real windows look like, and only the capture's other blocks can settle them.
//
// Written for this benchmark (not taken from a dataset), modelled on the strings of common
// desktop and mobile apps; not reviewed by native speakers.

export interface DetectionBlock {
	readonly lang: string;
	readonly text: string;
}

export type CaptureKind = "ui" | "chat" | "article" | "mixed";

export interface DetectionCapture {
	readonly id: string;
	readonly kind: CaptureKind;
	/** The user's source subset (BCP-47). Target is English. */
	readonly sources: readonly string[];
	readonly blocks: readonly DetectionBlock[];
}

const all = (lang: string, texts: readonly string[]): DetectionBlock[] => texts.map((text) => ({ lang, text }));
const capture = (
	id: string,
	kind: CaptureKind,
	sources: readonly string[],
	...blocks: readonly (DetectionBlock | readonly DetectionBlock[])[]
): DetectionCapture => ({ id, kind, sources, blocks: blocks.flat() });
const b = (lang: string, text: string): DetectionBlock => ({ lang, text });

const ID = ["id", "en"];
const SW = ["sw", "en"];
const UZ = ["uz", "ru", "en"];
const AF = ["af", "nl", "en"];
const GL = ["gl", "es", "pt", "en"];
const MK = ["mk", "bg", "en"];
const KK = ["kk", "ru", "en"];
const MN = ["mn", "en"];
const NE = ["ne", "hi", "en"];
const PS = ["ps", "fa", "en"];

export const DETECTION_CORPUS: readonly DetectionCapture[] = [
	// ---- Indonesian ----------------------------------------------------------------------
	capture(
		"id-settings",
		"ui",
		ID,
		all("id", [
			"Pengaturan",
			"Umum",
			"Tampilan",
			"Notifikasi",
			"Privasi dan keamanan",
			"Bahasa dan wilayah",
			"Pintasan keyboard",
			"Buka otomatis saat komputer dinyalakan",
			"Periksa pembaruan",
		]),
	),
	capture(
		"id-dialog",
		"ui",
		["id"],
		all("id", [
			"Simpan perubahan?",
			"Jika Anda menutup dokumen ini sekarang, semua perubahan yang belum disimpan akan hilang.",
			"Batal",
			"Jangan simpan",
			"Simpan",
		]),
	),
	capture(
		"id-chat",
		"chat",
		ID,
		all("id", [
			"Kamu sudah sampai di mana?",
			"Masih di jalan, macet banget",
			"Oke, aku tunggu di depan stasiun ya",
			"Jangan lupa bawa payung, katanya nanti hujan",
			"Siap, makasih!",
		]),
	),
	capture(
		"id-shop-mixed",
		"mixed",
		ID,
		b("id", "Keranjang belanja"),
		b("id", "Gratis ongkir untuk semua pesanan di atas Rp100.000"),
		b("en", "Sign in with Google"),
		b("id", "Tambah ke keranjang"),
		b("id", "Beli sekarang"),
		b("id", "Stok terbatas"),
	),
	capture(
		"id-article",
		"article",
		["id"],
		all("id", [
			"Pemerintah mengumumkan bahwa jadwal libur nasional tahun depan akan diumumkan pada akhir bulan ini setelah rapat bersama kementerian terkait.",
			"Warga diminta untuk tetap memantau informasi resmi melalui situs web dan akun media sosial pemerintah.",
		]),
	),
	capture(
		"id-subtitle",
		"chat",
		ID,
		all("id", ["Aku tidak percaya kita berhasil keluar dari sana.", "Ayo, kita harus pergi sebelum mereka kembali."]),
	),

	// ---- Swahili -------------------------------------------------------------------------
	capture(
		"sw-settings",
		"ui",
		SW,
		all("sw", [
			"Mipangilio",
			"Jumla",
			"Arifa",
			"Faragha na usalama",
			"Lugha na eneo",
			"Onyesho",
			"Sasisha programu",
			"Fungua kiotomatiki kompyuta inapowashwa",
		]),
	),
	capture(
		"sw-dialog",
		"ui",
		["sw"],
		all("sw", [
			"Hifadhi mabadiliko?",
			"Ukifunga hati hii sasa, mabadiliko yote ambayo hayajahifadhiwa yatapotea.",
			"Ghairi",
			"Usihifadhi",
			"Hifadhi",
		]),
	),
	capture(
		"sw-chat",
		"chat",
		SW,
		all("sw", [
			"Habari yako? Umefika wapi?",
			"Bado niko njiani, kuna foleni kubwa sana",
			"Sawa, nitakusubiri karibu na kituo cha basi",
			"Usisahau kuleta mwavuli, mvua itanyesha",
			"Asante sana rafiki yangu!",
		]),
	),
	capture(
		"sw-shop-mixed",
		"mixed",
		SW,
		b("sw", "Kikapu cha ununuzi"),
		b("sw", "Usafirishaji bure kwa oda zote zaidi ya shilingi elfu hamsini"),
		b("en", "Sign in with Google"),
		b("sw", "Ongeza kwenye kikapu"),
		b("sw", "Nunua sasa"),
		b("sw", "Bidhaa chache zimebaki"),
	),
	capture(
		"sw-article",
		"article",
		["sw"],
		all("sw", [
			"Serikali imetangaza kwamba ratiba ya likizo za kitaifa za mwaka ujao itatolewa mwishoni mwa mwezi huu baada ya mkutano na wizara husika.",
			"Wananchi wanaombwa kufuatilia taarifa rasmi kupitia tovuti na mitandao ya kijamii ya serikali.",
		]),
	),
	capture(
		"sw-subtitle",
		"chat",
		SW,
		all("sw", ["Siamini kwamba tumefanikiwa kutoka huko.", "Twende, lazima tuondoke kabla hawajarudi."]),
	),

	// ---- Uzbek (Latin) ---------------------------------------------------------------------
	capture(
		"uz-settings",
		"ui",
		UZ,
		all("uz", [
			"Sozlamalar",
			"Umumiy",
			"Bildirishnomalar",
			"Maxfiylik va xavfsizlik",
			"Til va mintaqa",
			"Ekran",
			"Yangilanishlarni tekshirish",
			"Kompyuter yoqilganda avtomatik ochish",
		]),
	),
	capture(
		"uz-dialog",
		"ui",
		["uz"],
		all("uz", [
			"Oʻzgarishlar saqlansinmi?",
			"Agar hujjatni hozir yopsangiz, saqlanmagan barcha oʻzgarishlar yoʻqoladi.",
			"Bekor qilish",
			"Saqlamaslik",
			"Saqlash",
		]),
	),
	capture(
		"uz-chat",
		"chat",
		UZ,
		all("uz", [
			"Qayerdasan? Yetib keldingmi?",
			"Hali yoʻldaman, tirbandlik juda katta",
			"Xoʻp, bekat oldida kutib turaman",
			"Soyabon olishni unutma, yomgʻir yogʻadi",
			"Katta rahmat, doʻstim!",
		]),
	),
	// The same chat as PaddleOCR reads it (bench:ocr latin-uz-chat): ʻ comes back as ASCII ',
	// which the detection copy drops, and fastText's Uzbek hangs on ʻ.
	capture(
		"uz-chat-ocr",
		"chat",
		UZ,
		all("uz", [
			"Hali yo'ldaman, tirbandlik juda katta",
			"Xo'p, bekat oldida kutib turaman",
			"Soyabon olishni unutma, yomg'ir yog'adi",
			"Katta rahmat, do'stim!",
		]),
	),
	capture(
		"uz-article",
		"article",
		["uz"],
		all("uz", [
			"Hukumat kelgusi yil uchun milliy bayramlar jadvali shu oy oxirida tegishli vazirliklar bilan yigʻilishdan soʻng eʼlon qilinishini maʼlum qildi.",
			"Fuqarolardan rasmiy maʼlumotlarni hukumat sayti va ijtimoiy tarmoqlardagi sahifalari orqali kuzatib borish soʻraladi.",
		]),
	),
	capture(
		"uz-login-mixed",
		"mixed",
		UZ,
		b("uz", "Kirish"),
		b("uz", "Telefon raqamingizni kiriting"),
		b("ru", "Забыли пароль?"),
		b("uz", "Parolni unutdingizmi?"),
		b("uz", "Roʻyxatdan oʻtish"),
		b("ru", "Продолжить на русском языке"),
	),

	// ---- Afrikaans -------------------------------------------------------------------------
	capture(
		"af-settings",
		"ui",
		AF,
		all("af", [
			"Instellings",
			"Algemeen",
			"Kennisgewings",
			"Privaatheid en sekuriteit",
			"Taal en streek",
			"Kontroleer vir opdaterings",
			"Maak outomaties oop wanneer die rekenaar aanskakel",
		]),
	),
	capture(
		"af-dialog",
		"ui",
		["af"],
		all("af", [
			"Stoor veranderinge?",
			"As jy hierdie dokument nou toemaak, sal alle veranderinge wat nie gestoor is nie, verlore gaan.",
			"Kanselleer",
			"Moenie stoor nie",
			"Stoor",
		]),
	),
	capture(
		"af-chat",
		"chat",
		AF,
		all("af", [
			"Waar is jy nou?",
			"Nog op pad, die verkeer is baie erg",
			"Goed, ek wag vir jou by die stasie",
			"Moenie vergeet om 'n sambreel te bring nie, dit gaan reën",
			"Baie dankie, my vriend!",
		]),
	),

	// ---- Galician --------------------------------------------------------------------------
	capture(
		"gl-settings",
		"ui",
		GL,
		all("gl", [
			"Axustes",
			"Xeral",
			"Notificacións",
			"Privacidade e seguranza",
			"Idioma e rexión",
			"Buscar actualizacións",
			"Abrir automaticamente ao acender o ordenador",
		]),
	),
	capture(
		"gl-dialog",
		"ui",
		GL,
		all("gl", [
			"Queres gardar os cambios?",
			"Se pechas este documento agora, perderanse todos os cambios que non se gardaron.",
			"Cancelar",
			"Non gardar",
			"Gardar",
		]),
	),
	capture(
		"gl-article",
		"article",
		GL,
		all("gl", [
			"O Concello anunciou que as obras da praza principal comezarán a próxima semana e durarán arredor de tres meses.",
			"Os veciños poderán consultar os cortes de tráfico na páxina web municipal.",
		]),
	),

	// ---- Macedonian ------------------------------------------------------------------------
	capture(
		"mk-menu",
		"ui",
		MK,
		all("mk", ["Датотека", "Уреди", "Поглед", "Помош", "Нов прозорец", "Неодамнешни документи", "Зачувај како"]),
	),
	capture(
		"mk-dialog",
		"ui",
		MK,
		all("mk", [
			"Да се зачуваат промените?",
			"Ако го затворите документот сега, сите незачувани промени ќе бидат изгубени.",
			"Откажи",
			"Не зачувувај",
			"Зачувај",
		]),
	),
	capture(
		"mk-chat",
		"chat",
		MK,
		all("mk", [
			"Каде си сега?",
			"Уште сум на пат, има голем метеж",
			"Добро, ќе те чекам пред станицата",
			"Не заборавај чадор, ќе врне дожд",
			"Ти благодарам многу!",
		]),
	),

	// ---- Kazakh ----------------------------------------------------------------------------
	capture(
		"kk-settings",
		"ui",
		KK,
		all("kk", [
			"Баптаулар",
			"Жалпы",
			"Хабарландырулар",
			"Құпиялылық және қауіпсіздік",
			"Тіл және аймақ",
			"Жаңартуларды тексеру",
			"Компьютер қосылғанда автоматты түрде ашу",
		]),
	),
	capture(
		"kk-chat",
		"chat",
		KK,
		all("kk", [
			"Қазір қайдасың?",
			"Әлі жолдамын, кептеліс өте үлкен",
			"Жарайды, бекеттің алдында күтемін",
			"Қолшатыр алуды ұмытпа, жаңбыр жауады",
			"Көп рахмет, досым!",
		]),
	),
	capture(
		"kk-login-mixed",
		"mixed",
		KK,
		b("kk", "Кіру"),
		b("kk", "Телефон нөміріңізді енгізіңіз"),
		b("ru", "Забыли пароль?"),
		b("kk", "Тіркелу"),
		b("ru", "Продолжить на русском языке"),
	),

	// ---- Mongolian -------------------------------------------------------------------------
	capture(
		"mn-settings",
		"ui",
		MN,
		all("mn", [
			"Тохиргоо",
			"Ерөнхий",
			"Мэдэгдэл",
			"Нууцлал ба аюулгүй байдал",
			"Хэл ба бүс нутаг",
			"Шинэчлэл шалгах",
			"Компьютер асахад автоматаар нээх",
		]),
	),
	capture(
		"mn-chat",
		"chat",
		MN,
		all("mn", [
			"Чи одоо хаана байна?",
			"Замдаа явж байна, түгжрэл их байна",
			"За, буудлын өмнө хүлээж байя",
			"Шүхрээ мартуузай, бороо орно",
			"Баярлалаа, найз минь!",
		]),
	),

	// ---- Nepali ----------------------------------------------------------------------------
	capture(
		"ne-settings",
		"ui",
		NE,
		all("ne", ["सेटिङहरू", "सामान्य", "सूचनाहरू", "गोपनीयता र सुरक्षा", "भाषा र क्षेत्र", "अद्यावधिकहरू जाँच गर्नुहोस्"]),
	),
	capture(
		"ne-dialog",
		"ui",
		NE,
		all("ne", [
			"परिवर्तनहरू सुरक्षित गर्ने?",
			"यदि तपाईंले अहिले यो कागजात बन्द गर्नुभयो भने, सुरक्षित नगरिएका सबै परिवर्तनहरू हराउनेछन्।",
			"रद्द गर्नुहोस्",
			"सुरक्षित गर्नुहोस्",
		]),
	),
	capture(
		"ne-chat",
		"chat",
		NE,
		all("ne", [
			"तिमी अहिले कहाँ छौ?",
			"अझै बाटोमै छु, धेरै जाम छ",
			"हुन्छ, म स्टेसन अगाडि पर्खन्छु",
			"छाता ल्याउन नबिर्सनू, पानी पर्छ",
			"धेरै धन्यवाद साथी!",
		]),
	),

	// ---- Pashto ----------------------------------------------------------------------------
	capture(
		"ps-settings",
		"ui",
		PS,
		all("ps", ["تنظیمات", "عمومي", "خبرتیاوې", "محرمیت او امنیت", "ژبه او سیمه", "تازه معلومات وګورئ"]),
	),
	capture(
		"ps-chat",
		"chat",
		PS,
		all("ps", [
			"ته اوس چیرته یې؟",
			"لا هم په لاره کې یم، ډېره ګڼه ګوڼه ده",
			"ښه، زه به د سټیشن مخې ته انتظار وکړم",
			"چترۍ مه هېروه، باران به وشي",
			"ډېره مننه ملګریه!",
		]),
	),
];
