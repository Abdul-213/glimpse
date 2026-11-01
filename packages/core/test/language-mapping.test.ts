import { describe, expect, test } from "bun:test";
import {
	allLanguages,
	CATALOG,
	directionOf,
	displayName,
	fromBergamot,
	fromFlores,
	fromGoogle,
	fromM2m,
	fromScheme,
	LANGUAGE_SCHEMES,
	type LanguageCode,
	type LanguageCodeMap,
	type LanguagePair,
	languageCode,
	lookupLanguage,
	nativeName,
	normalizeLanguage,
	planRoute,
	planRouteWithDownloads,
	recognizerFor,
	recognizersFor,
	sameLanguage,
	schemeLanguageMap,
	scriptOf,
	toBergamot,
	toFlores,
	toGoogle,
	toM2m,
	toScheme,
} from "../src/index.ts";

const L = languageCode;

// transformers `tokenization_nllb.py` FAIRSEQ_LANGUAGE_CODES (NLLB-200), copied verbatim.
// biome-ignore format: data
const NLLB = ["ace_Arab","ace_Latn","acm_Arab","acq_Arab","aeb_Arab","afr_Latn","ajp_Arab","aka_Latn","amh_Ethi","apc_Arab","arb_Arab","ars_Arab","ary_Arab","arz_Arab","asm_Beng","ast_Latn","awa_Deva","ayr_Latn","azb_Arab","azj_Latn","bak_Cyrl","bam_Latn","ban_Latn","bel_Cyrl","bem_Latn","ben_Beng","bho_Deva","bjn_Arab","bjn_Latn","bod_Tibt","bos_Latn","bug_Latn","bul_Cyrl","cat_Latn","ceb_Latn","ces_Latn","cjk_Latn","ckb_Arab","crh_Latn","cym_Latn","dan_Latn","deu_Latn","dik_Latn","dyu_Latn","dzo_Tibt","ell_Grek","eng_Latn","epo_Latn","est_Latn","eus_Latn","ewe_Latn","fao_Latn","pes_Arab","fij_Latn","fin_Latn","fon_Latn","fra_Latn","fur_Latn","fuv_Latn","gla_Latn","gle_Latn","glg_Latn","grn_Latn","guj_Gujr","hat_Latn","hau_Latn","heb_Hebr","hin_Deva","hne_Deva","hrv_Latn","hun_Latn","hye_Armn","ibo_Latn","ilo_Latn","ind_Latn","isl_Latn","ita_Latn","jav_Latn","jpn_Jpan","kab_Latn","kac_Latn","kam_Latn","kan_Knda","kas_Arab","kas_Deva","kat_Geor","knc_Arab","knc_Latn","kaz_Cyrl","kbp_Latn","kea_Latn","khm_Khmr","kik_Latn","kin_Latn","kir_Cyrl","kmb_Latn","kon_Latn","kor_Hang","kmr_Latn","lao_Laoo","lvs_Latn","lij_Latn","lim_Latn","lin_Latn","lit_Latn","lmo_Latn","ltg_Latn","ltz_Latn","lua_Latn","lug_Latn","luo_Latn","lus_Latn","mag_Deva","mai_Deva","mal_Mlym","mar_Deva","min_Latn","mkd_Cyrl","plt_Latn","mlt_Latn","mni_Beng","khk_Cyrl","mos_Latn","mri_Latn","zsm_Latn","mya_Mymr","nld_Latn","nno_Latn","nob_Latn","npi_Deva","nso_Latn","nus_Latn","nya_Latn","oci_Latn","gaz_Latn","ory_Orya","pag_Latn","pan_Guru","pap_Latn","pol_Latn","por_Latn","prs_Arab","pbt_Arab","quy_Latn","ron_Latn","run_Latn","rus_Cyrl","sag_Latn","san_Deva","sat_Beng","scn_Latn","shn_Mymr","sin_Sinh","slk_Latn","slv_Latn","smo_Latn","sna_Latn","snd_Arab","som_Latn","sot_Latn","spa_Latn","als_Latn","srd_Latn","srp_Cyrl","ssw_Latn","sun_Latn","swe_Latn","swh_Latn","szl_Latn","tam_Taml","tat_Cyrl","tel_Telu","tgk_Cyrl","tgl_Latn","tha_Thai","tir_Ethi","taq_Latn","taq_Tfng","tpi_Latn","tsn_Latn","tso_Latn","tuk_Latn","tum_Latn","tur_Latn","twi_Latn","tzm_Tfng","uig_Arab","ukr_Cyrl","umb_Latn","urd_Arab","uzn_Latn","vec_Latn","vie_Latn","war_Latn","wol_Latn","xho_Latn","ydd_Hebr","yor_Latn","yue_Hant","zho_Hans","zho_Hant","zul_Latn"];

// transformers `tokenization_m2m_100.py` (M2M-100; SMaLL-100 uses the same set).
// biome-ignore format: data
const M2M = ["af","am","ar","ast","az","ba","be","bg","bn","br","bs","ca","ceb","cs","cy","da","de","el","en","es","et","fa","ff","fi","fr","fy","ga","gd","gl","gu","ha","he","hi","hr","ht","hu","hy","id","ig","ilo","is","it","ja","jv","ka","kk","km","kn","ko","lb","lg","ln","lo","lt","lv","mg","mk","ml","mn","mr","ms","my","ne","nl","no","ns","oc","or","pa","pl","ps","pt","ro","ru","sd","si","sk","sl","so","sq","sr","ss","su","sv","sw","ta","th","tl","tn","tr","uk","ur","uz","vi","wo","xh","yi","yo","zh","zu"];

// Remote Settings translations-models-v2, every source/target language on 2026-11-01.
// biome-ignore format: data
const BERGAMOT = ["af","ar","az","be","bg","bn","bs","ca","cs","da","de","el","en","es","et","eu","fa","fi","fr","gl","gu","he","hi","hr","hu","id","is","it","ja","kn","ko","lt","lv","ml","mr","ms","nb","nl","nn","pl","pt","ro","ru","sk","sl","sq","sr","sv","ta","te","th","tl","tr","ug","uk","ur","vi","zh-Hans","zh-Hant"];

// ELD README, 60 languages.
// biome-ignore format: data
const ELD = ["am","ar","az","be","bg","bn","ca","cs","da","de","el","en","es","et","eu","fa","fi","fr","gu","he","hi","hr","hu","hy","is","it","ja","ka","kn","ko","ku","lo","lt","lv","ml","mr","ms","nl","no","or","pa","pl","pt","ro","ru","sk","sl","sq","sr","sv","ta","te","th","tl","tr","uk","ur","vi","yo","zh"];

describe("catalogue invariants", () => {
	test("every code is canonical BCP-47 and unique", () => {
		const seen = new Set<string>();
		for (const e of CATALOG) {
			expect(Intl.getCanonicalLocales(e.code)[0]).toBe(e.code);
			expect(seen.has(e.code)).toBe(false);
			seen.add(e.code);
		}
	});

	test("FLORES codes are unique and well formed", () => {
		const flores = CATALOG.flatMap((e) => (e.flores ? [e.flores] : []));
		expect(new Set(flores).size).toBe(flores.length);
		for (const f of flores) expect(f).toMatch(/^[a-z]{3}_[A-Z][a-z]{3}$/);
	});

	test("rows whose script differs from the language's likely script spell it in the tag", () => {
		for (const e of CATALOG) {
			const tagScript = new Intl.Locale(e.code).script;
			if (tagScript) expect(tagScript).toBe(e.script);
		}
	});

	test("every scheme code round-trips through its default row", () => {
		for (const scheme of LANGUAGE_SCHEMES) {
			for (const e of allLanguages()) {
				const value = e[scheme];
				if (!value) continue;
				const back = fromScheme(scheme, value, e.script);
				expect(back, `${scheme}:${value}`).not.toBeNull();
				if (back) expect(toScheme(back, scheme)).toBe(value);
			}
		}
	});
});

describe("coverage", () => {
	test("covers every NLLB-200 language, and FLORES round-trips", () => {
		expect(NLLB.length).toBe(202);
		for (const flores of NLLB) {
			const code = fromFlores(flores);
			expect(code, flores).not.toBeNull();
			if (code) expect(toFlores(code)).toBe(flores);
		}
	});

	test("covers every M2M-100 / SMaLL-100 language", () => {
		expect(M2M.length).toBe(100);
		for (const m of M2M) {
			const code = fromM2m(m);
			expect(code, m).not.toBeNull();
			if (code) expect(toM2m(code)).toBe(m);
		}
	});

	test("covers every Bergamot language", () => {
		for (const b of BERGAMOT) {
			const code = fromBergamot(b);
			expect(code, b).not.toBeNull();
			if (code) expect(toBergamot(code)).toBe(b);
		}
		expect(allLanguages().filter((e) => e.bergamot).length).toBe(BERGAMOT.length + 1); // + Dari reading fa
	});

	test("covers every ELD language", () => {
		expect(ELD.length).toBe(60);
		for (const label of ELD) {
			const code = fromScheme("eld", label);
			expect(code, label).not.toBeNull();
			if (code) expect(toScheme(code, "eld")).toBe(label);
		}
	});

	test("every row has a display name in English", () => {
		for (const e of allLanguages()) expect(displayName(e.code)).not.toBe("");
	});
});

describe("mapping edge cases", () => {
	test("Chinese variants", () => {
		expect(toFlores(L("zh"))).toBe("zho_Hans");
		expect(toFlores(L("zh-TW"))).toBe("zho_Hant");
		expect(toFlores(L("zh-HK"))).toBe("zho_Hant");
		expect(toBergamot(L("zh-CN"))).toBe("zh-Hans");
		expect(toGoogle(L("zh-Hant"))).toBe("zh-TW");
		expect(fromGoogle("zh-CN")).toBe(L("zh-Hans"));
		expect(fromGoogle("zh")).toBe(L("zh-Hans"));
		expect(fromScheme("eld", "zh")).toBe(L("zh-Hans"));
		expect(fromScheme("eld", "zh", "Hant")).toBe(L("zh-Hant"));
		expect(fromScheme("fasttext", "__label__yue")).toBe(L("yue"));
	});

	test("Google's legacy codes", () => {
		expect(toGoogle(L("he"))).toBe("iw");
		expect(fromGoogle("iw")).toBe(L("he"));
		expect(fromGoogle("he")).toBe(L("he"));
		expect(toGoogle(L("jv"))).toBe("jw");
		expect(fromGoogle("jw")).toBe(L("jv"));
		expect(fromGoogle("fil")).toBe(L("tl"));
		expect(toGoogle(L("nb"))).toBe("no");
	});

	test("Norwegian, Kurdish, Persian, Serbian", () => {
		expect(lookupLanguage(L("no"))?.code).toBe(L("nb"));
		expect(toBergamot(L("no"))).toBe("nb");
		expect(fromM2m("no")).toBe(L("nb"));
		expect(fromScheme("eld", "ku")).toBe(L("ckb"));
		expect(fromScheme("fasttext", "ku")).toBe(L("ku"));
		expect(toFlores(L("ku"))).toBe("kmr_Latn");
		expect(toFlores(L("fa-AF"))).toBe("prs_Arab");
		expect(toBergamot(L("fa-AF"))).toBe("fa");
		expect(toFlores(L("sr"))).toBe("srp_Cyrl");
		expect(toFlores(L("sr-Latn"))).toBeNull(); // NLLB has Cyrillic Serbian only
		expect(fromScheme("fasttext", "als")).toBe(L("gsw"));
		expect(fromScheme("fasttext", "sh")).toBe(L("hr"));
		expect(fromScheme("fasttext", "bh")).toBe(L("bho"));
	});

	test("regional variants fall back to the language", () => {
		expect(normalizeLanguage(L("pt-BR"))).toBe(L("pt"));
		expect(normalizeLanguage(L("en-GB"))).toBe(L("en"));
		expect(normalizeLanguage(L("es-419"))).toBe(L("es"));
		expect(toFlores(L("ar-EG"))).toBe("arb_Arab");
		expect(sameLanguage(L("pt-BR"), L("pt"))).toBe(true);
		expect(sameLanguage(L("zh-Hans"), L("zh-Hant"))).toBe(false);
	});

	test("Santali has both FLORES spellings", () => {
		expect(fromFlores("sat_Olck")).toBe(L("sat"));
		expect(fromFlores("sat_Beng")).toBe(L("sat"));
	});

	test("unknown codes", () => {
		expect(fromFlores("xxx_Latn")).toBeNull();
		expect(toFlores(L("tlh"))).toBeNull();
		expect(fromScheme("fasttext", "nds")).toBe(L("nds")); // not catalogued, still a valid tag
		expect(lookupLanguage("not a tag")).toBeUndefined();
	});
});

describe("script and direction", () => {
	test("scripts", () => {
		expect(scriptOf(L("ja"))).toBe("Jpan");
		expect(scriptOf(L("ko"))).toBe("Hang");
		expect(scriptOf(L("zh-TW"))).toBe("Hant");
		expect(scriptOf(L("ks-Deva"))).toBe("Deva");
		expect(scriptOf(L("tlh"))).toBe("Zyyy");
	});

	test("RTL languages", () => {
		for (const c of ["ar", "fa", "he", "ur", "ps", "yi", "ug", "ckb", "dv", "fa-AF"]) {
			expect(directionOf(L(c))).toBe("rtl");
		}
		for (const c of ["en", "ja", "ru", "hi", "ks-Deva", "ku"]) expect(directionOf(L(c))).toBe("ltr");
	});
});

describe("display names", () => {
	test("in the user's locale and natively", () => {
		expect(displayName(L("ja"))).toBe("Japanese");
		expect(displayName(L("ja"), "fr")).toBe("japonais");
		// CLDR data differs by runtime: Bun on Linux/Windows vs the system ICU on macOS.
		expect(["Chinese (Traditional)", "Chinese, Traditional"]).toContain(
			displayName(L("zh-Hant"), "en", { style: "standard" }),
		);
		expect(nativeName(L("de"))).toBe("Deutsch");
		expect(nativeName(L("ja"))).toBe("日本語");
		expect(displayName(L("ja"), "not a locale")).toBe("Japanese");
	});
});

describe("OCR recognisers", () => {
	test("per language", () => {
		expect(recognizersFor(L("en"))).toEqual(["en", "latin", "ch"]);
		expect(recognizerFor(L("ja"))).toBe("ch");
		expect(recognizerFor(L("zh-TW"))).toBe("ch");
		expect(recognizerFor(L("ko"))).toBe("korean");
		expect(recognizerFor(L("de"))).toBe("latin");
		expect(recognizerFor(L("vi"))).toBe("latin");
		expect(recognizersFor(L("ru"))).toEqual(["eslav", "cyrillic"]);
		expect(recognizersFor(L("bg"))).toEqual(["cyrillic", "eslav"]);
		expect(recognizerFor(L("ar"))).toBe("arabic");
		expect(recognizerFor(L("hi"))).toBe("devanagari");
		expect(recognizerFor(L("th"))).toBe("th");
		expect(recognizerFor(L("el"))).toBe("el");
		expect(recognizerFor(L("ta"))).toBe("ta");
		expect(recognizersFor(L("he"))).toEqual([]); // PP-OCRv5 has no Hebrew recogniser
	});
});

describe("route planning", () => {
	const p = (s: string, t: string): LanguagePair => ({ source: L(s), target: L(t) });
	const packs = [p("ja", "en"), p("en", "de"), p("de", "en"), p("zh-Hans", "en"), p("pt", "en")];

	test("identity, direct and pivot", () => {
		expect(planRoute(L("en"), L("en-GB"), packs)).toEqual({ kind: "identity" });
		expect(planRoute(L("ja"), L("en"), packs)).toEqual({ kind: "direct", hops: [p("ja", "en")] });
		expect(planRoute(L("ja"), L("de"), packs)).toEqual({
			kind: "pivot",
			pivot: L("en"),
			hops: [p("ja", "en"), p("en", "de")],
		});
	});

	test("loose matching returns the pack's own codes", () => {
		expect(planRoute(L("pt-BR"), L("en"), packs)).toEqual({ kind: "direct", hops: [p("pt", "en")] });
		expect(planRoute(L("zh"), L("de"), packs)?.kind).toBe("pivot");
		expect(planRoute(L("zh-TW"), L("en"), packs)).toBeNull();
	});

	test("no route", () => {
		expect(planRoute(L("ko"), L("en"), packs)).toBeNull();
		expect(planRoute(L("en"), L("ja"), packs)).toBeNull();
		expect(planRoute(L("ja"), L("de"), packs, { pivots: [] })).toBeNull();
	});

	test("with downloads: fewest downloads, then fewest hops", () => {
		const catalogue = [p("ko", "en"), p("en", "ko"), p("en", "fr"), p("ja", "fr")];
		expect(planRouteWithDownloads(L("ja"), L("de"), packs, catalogue)).toEqual({
			route: { kind: "pivot", pivot: L("en"), hops: [p("ja", "en"), p("en", "de")] },
			downloads: [],
		});
		expect(planRouteWithDownloads(L("ko"), L("de"), packs, catalogue)).toEqual({
			route: { kind: "pivot", pivot: L("en"), hops: [p("ko", "en"), p("en", "de")] },
			downloads: [p("ko", "en")],
		});
		// A direct ja->fr download (1 file set) beats ja->en->fr (also 1 download, 2 hops).
		expect(planRouteWithDownloads(L("ja"), L("fr"), packs, catalogue)?.route).toEqual({
			kind: "direct",
			hops: [p("ja", "fr")],
		});
		expect(planRouteWithDownloads(L("th"), L("en"), packs, catalogue)).toBeNull();
	});

	test("type of a planned hop is a LanguageCode pair", () => {
		const route = planRoute(L("ja"), L("de"), packs);
		const codes: LanguageCode[] = route && route.kind !== "identity" ? route.hops.map((h) => h.source) : [];
		expect(codes).toEqual([L("ja"), L("en")]);
	});
});

describe("provider seam", () => {
	test("schemeLanguageMap satisfies the providers' LanguageCodeMap", () => {
		const map: LanguageCodeMap = schemeLanguageMap("google");
		expect(map.toProvider(L("zh-Hant"))).toBe("zh-TW");
		expect(map.fromProvider("iw")).toBe(L("he"));
		expect(schemeLanguageMap("flores").toProvider(L("ja"))).toBe("jpn_Jpan");
	});
});
