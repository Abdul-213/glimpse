// The language catalogue: one row per language Glimpse knows how to name, detect, OCR or
// translate, with that language's code in every external scheme we talk to.
//
// Canonical identity is the BCP-47 tag in `code` (ARCHITECTURE.md section 8). Each tag is
// already in `Intl.getCanonicalLocales` form, and no two rows share one (tests check both).
//
// Schemes:
// - flores:   FLORES-200 / NLLB-200 (`jpn_Jpan`). Every one of NLLB's 202 codes has a row.
//             Source: transformers `tokenization_nllb.py` FAIRSEQ_LANGUAGE_CODES.
// - m2m:      M2M-100 and SMaLL-100 language tokens (`__ja__` without the underscores).
//             Both models share M2M-100's 100 codes (transformers `tokenization_m2m_100.py`).
// - bergamot: Firefox Translations / Remote Settings `translations-models-v2` codes (59 languages
//             on 2026-11-01, spikes/inference/FINDINGS.md).
// - google:   Google Cloud Translation v2 codes. A snapshot of the documented list; the cloud
//             provider should refresh it from `GET /language/translate/v2/languages` (GLIM-22).
// - eld:      ELD (Efficient Language Detector) labels, 60 languages (GLIM-21).
// - fasttext: fastText `lid.176` labels (`__label__xx` without the prefix), 176 languages (GLIM-21).
//
// Several rows may share a scheme code (`zh` in ELD covers zh-Hans and zh-Hant). Reverse
// lookups take the first such row unless a script hint picks another, so put the default first.

import type { ScriptCode } from "./script.ts";

export type LanguageScheme = "flores" | "m2m" | "bergamot" | "google" | "eld" | "fasttext";

export const LANGUAGE_SCHEMES: readonly LanguageScheme[] = ["flores", "m2m", "bergamot", "google", "eld", "fasttext"];

export interface CatalogEntry {
	/** Canonical BCP-47 tag. */
	readonly code: string;
	/** ISO 15924 script the language is written in (for this row). */
	readonly script: ScriptCode;
	readonly flores?: string;
	readonly m2m?: string;
	readonly bergamot?: string;
	readonly google?: string;
	readonly eld?: string;
	readonly fasttext?: string;
}

type Overrides = Partial<Record<Exclude<LanguageScheme, "flores">, string>>;

/**
 * `flags` lists the schemes whose code equals `code`: m = m2m, b = bergamot, g = google,
 * e = eld, f = fasttext. `overrides` sets a scheme's code when it differs from `code`.
 */
function row(
	code: string,
	script: ScriptCode,
	flores: string | null,
	flags = "",
	overrides: Overrides = {},
): CatalogEntry {
	const entry: { -readonly [K in keyof CatalogEntry]: CatalogEntry[K] } = { code, script };
	if (flores) entry.flores = flores;
	if (flags.includes("m")) entry.m2m = code;
	if (flags.includes("b")) entry.bergamot = code;
	if (flags.includes("g")) entry.google = code;
	if (flags.includes("e")) entry.eld = code;
	if (flags.includes("f")) entry.fasttext = code;
	return { ...entry, ...overrides };
}

// biome-ignore format: one row per line reads better than biome's wrapping
export const CATALOG: readonly CatalogEntry[] = [
	// ---- Bergamot languages first (most used), then the rest alphabetically by FLORES code.
	row("en", "Latn", "eng_Latn", "mbgef"),
	row("zh-Hans", "Hans", "zho_Hans", "b", { m2m: "zh", google: "zh-CN", eld: "zh", fasttext: "zh" }),
	row("zh-Hant", "Hant", "zho_Hant", "b", { m2m: "zh", google: "zh-TW", eld: "zh", fasttext: "zh" }),
	row("ja", "Jpan", "jpn_Jpan", "mbgef"),
	row("ko", "Hang", "kor_Hang", "mbgef"),
	row("af", "Latn", "afr_Latn", "mbgf"),
	row("ar", "Arab", "arb_Arab", "mbgef"),
	row("az", "Latn", "azj_Latn", "mbgef"),
	row("be", "Cyrl", "bel_Cyrl", "mbgef"),
	row("bg", "Cyrl", "bul_Cyrl", "mbgef"),
	row("bn", "Beng", "ben_Beng", "mbgef"),
	row("bs", "Latn", "bos_Latn", "mbgf"),
	row("ca", "Latn", "cat_Latn", "mbgef"),
	row("cs", "Latn", "ces_Latn", "mbgef"),
	row("da", "Latn", "dan_Latn", "mbgef"),
	row("de", "Latn", "deu_Latn", "mbgef"),
	row("el", "Grek", "ell_Grek", "mbgef"),
	row("es", "Latn", "spa_Latn", "mbgef"),
	row("et", "Latn", "est_Latn", "mbgef"),
	row("eu", "Latn", "eus_Latn", "bgef"),
	row("fa", "Arab", "pes_Arab", "mbgef"),
	row("fi", "Latn", "fin_Latn", "mbgef"),
	row("fr", "Latn", "fra_Latn", "mbgef"),
	row("gl", "Latn", "glg_Latn", "mbgf"),
	row("gu", "Gujr", "guj_Gujr", "mbgef"),
	row("he", "Hebr", "heb_Hebr", "mbef", { google: "iw" }),
	row("hi", "Deva", "hin_Deva", "mbgef"),
	row("hr", "Latn", "hrv_Latn", "mbgef"),
	row("hu", "Latn", "hun_Latn", "mbgef"),
	row("id", "Latn", "ind_Latn", "mbgf"),
	row("is", "Latn", "isl_Latn", "mbgef"),
	row("it", "Latn", "ita_Latn", "mbgef"),
	row("kn", "Knda", "kan_Knda", "mbgef"),
	row("lt", "Latn", "lit_Latn", "mbgef"),
	row("lv", "Latn", "lvs_Latn", "mbgef"),
	row("ml", "Mlym", "mal_Mlym", "mbgef"),
	row("mr", "Deva", "mar_Deva", "mbgef"),
	row("ms", "Latn", "zsm_Latn", "mbgef"),
	row("nb", "Latn", "nob_Latn", "b", { m2m: "no", google: "no", eld: "no", fasttext: "no" }),
	row("nl", "Latn", "nld_Latn", "mbgef"),
	row("nn", "Latn", "nno_Latn", "bf"),
	row("pl", "Latn", "pol_Latn", "mbgef"),
	row("pt", "Latn", "por_Latn", "mbgef"),
	row("ro", "Latn", "ron_Latn", "mbgef"),
	row("ru", "Cyrl", "rus_Cyrl", "mbgef"),
	row("sk", "Latn", "slk_Latn", "mbgef"),
	row("sl", "Latn", "slv_Latn", "mbgef"),
	row("sq", "Latn", "als_Latn", "mbgef"),
	row("sr", "Cyrl", "srp_Cyrl", "mbgef"),
	row("sv", "Latn", "swe_Latn", "mbgef"),
	row("ta", "Taml", "tam_Taml", "mbgef"),
	row("te", "Telu", "tel_Telu", "mbgef"),
	row("th", "Thai", "tha_Thai", "mbgef"),
	row("tl", "Latn", "tgl_Latn", "mbgef"),
	row("tr", "Latn", "tur_Latn", "mbgef"),
	row("ug", "Arab", "uig_Arab", "bgf"),
	row("uk", "Cyrl", "ukr_Cyrl", "mbgef"),
	row("ur", "Arab", "urd_Arab", "mbgef"),
	row("vi", "Latn", "vie_Latn", "mbgef"),

	// ---- Other FLORES-200 languages
	row("ace", "Latn", "ace_Latn", "g"),
	row("ace-Arab", "Arab", "ace_Arab"),
	row("acm", "Arab", "acm_Arab"),
	row("acq", "Arab", "acq_Arab"),
	row("aeb", "Arab", "aeb_Arab"),
	row("ajp", "Arab", "ajp_Arab"),
	row("ak", "Latn", "aka_Latn", "g"),
	row("am", "Ethi", "amh_Ethi", "mge"),
	row("apc", "Arab", "apc_Arab"),
	row("ars", "Arab", "ars_Arab"),
	row("ary", "Arab", "ary_Arab"),
	row("arz", "Arab", "arz_Arab", "f"),
	row("as", "Beng", "asm_Beng", "gf"),
	row("ast", "Latn", "ast_Latn", "mf"),
	row("awa", "Deva", "awa_Deva", "g"),
	row("ay", "Latn", "ayr_Latn", "g"),
	row("azb", "Arab", "azb_Arab", "f"),
	row("ba", "Cyrl", "bak_Cyrl", "mgf"),
	row("bm", "Latn", "bam_Latn", "g"),
	row("ban", "Latn", "ban_Latn", "g"),
	row("bem", "Latn", "bem_Latn", "g"),
	row("bho", "Deva", "bho_Deva", "g", { fasttext: "bh" }),
	row("bjn", "Latn", "bjn_Latn"),
	row("bjn-Arab", "Arab", "bjn_Arab"),
	row("bo", "Tibt", "bod_Tibt", "gf"),
	row("bug", "Latn", "bug_Latn"),
	row("ceb", "Latn", "ceb_Latn", "mgf"),
	row("cjk", "Latn", "cjk_Latn"),
	// ELD's `ku` is "Kurdish (Arabic)", i.e. Sorani; fastText's and Google's `ku` is Kurmanji.
	row("ckb", "Arab", "ckb_Arab", "gf", { eld: "ku" }),
	row("crh", "Latn", "crh_Latn", "g"),
	row("cy", "Latn", "cym_Latn", "mgf"),
	row("dik", "Latn", "dik_Latn"),
	row("dyu", "Latn", "dyu_Latn", "g"),
	row("dz", "Tibt", "dzo_Tibt", "g"),
	row("eo", "Latn", "epo_Latn", "gf"),
	row("ee", "Latn", "ewe_Latn", "g"),
	row("fo", "Latn", "fao_Latn", "g"),
	row("fj", "Latn", "fij_Latn", "g"),
	row("fon", "Latn", "fon_Latn", "g"),
	row("fur", "Latn", "fur_Latn", "g"),
	row("fuv", "Latn", "fuv_Latn"),
	row("gd", "Latn", "gla_Latn", "mgf"),
	row("ga", "Latn", "gle_Latn", "mgf"),
	row("gn", "Latn", "grn_Latn", "gf"),
	row("ht", "Latn", "hat_Latn", "mgf"),
	row("ha", "Latn", "hau_Latn", "mg"),
	row("hne", "Deva", "hne_Deva"),
	row("hy", "Armn", "hye_Armn", "mgef"),
	row("ig", "Latn", "ibo_Latn", "mg"),
	row("ilo", "Latn", "ilo_Latn", "mgf"),
	row("jv", "Latn", "jav_Latn", "mf", { google: "jw" }),
	row("kab", "Latn", "kab_Latn"),
	row("kac", "Latn", "kac_Latn", "g"),
	row("kam", "Latn", "kam_Latn"),
	row("ks", "Arab", "kas_Arab"),
	row("ks-Deva", "Deva", "kas_Deva"),
	row("ka", "Geor", "kat_Geor", "mgef"),
	row("knc", "Latn", "knc_Latn"),
	row("knc-Arab", "Arab", "knc_Arab"),
	row("kk", "Cyrl", "kaz_Cyrl", "mgf"),
	row("kbp", "Latn", "kbp_Latn"),
	row("kea", "Latn", "kea_Latn"),
	row("km", "Khmr", "khm_Khmr", "mgf"),
	row("ki", "Latn", "kik_Latn"),
	row("rw", "Latn", "kin_Latn", "g"),
	row("ky", "Cyrl", "kir_Cyrl", "gf"),
	row("kmb", "Latn", "kmb_Latn"),
	row("kg", "Latn", "kon_Latn", "g"),
	row("ku", "Latn", "kmr_Latn", "gf"),
	row("lo", "Laoo", "lao_Laoo", "mgef"),
	row("lij", "Latn", "lij_Latn", "g"),
	row("li", "Latn", "lim_Latn", "gf"),
	row("ln", "Latn", "lin_Latn", "mg"),
	row("lmo", "Latn", "lmo_Latn", "gf"),
	row("ltg", "Latn", "ltg_Latn", "g"),
	row("lb", "Latn", "ltz_Latn", "mgf"),
	row("lua", "Latn", "lua_Latn"),
	row("lg", "Latn", "lug_Latn", "mg"),
	row("luo", "Latn", "luo_Latn", "g"),
	row("lus", "Latn", "lus_Latn", "g"),
	row("mag", "Deva", "mag_Deva"),
	row("mai", "Deva", "mai_Deva", "gf"),
	row("min", "Latn", "min_Latn", "f"),
	row("mk", "Cyrl", "mkd_Cyrl", "mgf"),
	row("mg", "Latn", "plt_Latn", "mgf"),
	row("mt", "Latn", "mlt_Latn", "gf"),
	row("mni", "Beng", "mni_Beng"),
	row("mn", "Cyrl", "khk_Cyrl", "mgf"),
	row("mos", "Latn", "mos_Latn"),
	row("mi", "Latn", "mri_Latn", "g"),
	row("my", "Mymr", "mya_Mymr", "mgf"),
	row("ne", "Deva", "npi_Deva", "mgf"),
	row("nso", "Latn", "nso_Latn", "g", { m2m: "ns" }),
	row("nus", "Latn", "nus_Latn", "g"),
	row("ny", "Latn", "nya_Latn", "g"),
	row("oc", "Latn", "oci_Latn", "mgf"),
	row("om", "Latn", "gaz_Latn", "g"),
	row("or", "Orya", "ory_Orya", "mgef"),
	row("pag", "Latn", "pag_Latn", "g"),
	row("pa", "Guru", "pan_Guru", "mgef"),
	row("pap", "Latn", "pap_Latn", "g"),
	// Dari. No M2M/Bergamot/detector code of its own; Persian models read it.
	row("fa-AF", "Arab", "prs_Arab", "g", { m2m: "fa", bergamot: "fa", eld: "fa", fasttext: "fa" }),
	row("ps", "Arab", "pbt_Arab", "mgf"),
	row("qu", "Latn", "quy_Latn", "gf"),
	row("rn", "Latn", "run_Latn", "g"),
	row("sg", "Latn", "sag_Latn", "g"),
	row("sa", "Deva", "san_Deva", "gf"),
	// NLLB labels Santali `sat_Beng`, but its data is Ol Chiki (FLORES-200 itself says sat_Olck).
	row("sat", "Olck", "sat_Beng"),
	row("scn", "Latn", "scn_Latn", "gf"),
	row("shn", "Mymr", "shn_Mymr", "g"),
	row("si", "Sinh", "sin_Sinh", "mgf"),
	row("sm", "Latn", "smo_Latn", "g"),
	row("sn", "Latn", "sna_Latn", "g"),
	row("sd", "Arab", "snd_Arab", "mgf"),
	row("so", "Latn", "som_Latn", "mgf"),
	row("st", "Latn", "sot_Latn", "g"),
	row("sc", "Latn", "srd_Latn", "f"),
	row("ss", "Latn", "ssw_Latn", "mg"),
	row("su", "Latn", "sun_Latn", "mgf"),
	row("sw", "Latn", "swh_Latn", "mgf"),
	row("szl", "Latn", "szl_Latn"),
	row("tt", "Cyrl", "tat_Cyrl", "gf"),
	row("tg", "Cyrl", "tgk_Cyrl", "gf"),
	row("ti", "Ethi", "tir_Ethi", "g"),
	row("taq", "Latn", "taq_Latn"),
	row("taq-Tfng", "Tfng", "taq_Tfng"),
	row("tpi", "Latn", "tpi_Latn", "g"),
	row("tn", "Latn", "tsn_Latn", "mg"),
	row("ts", "Latn", "tso_Latn", "g"),
	row("tk", "Latn", "tuk_Latn", "gf"),
	row("tum", "Latn", "tum_Latn"),
	row("tw", "Latn", "twi_Latn"),
	row("tzm-Tfng", "Tfng", "tzm_Tfng"),
	row("umb", "Latn", "umb_Latn"),
	row("uz", "Latn", "uzn_Latn", "mgf"),
	row("vec", "Latn", "vec_Latn", "f"),
	row("war", "Latn", "war_Latn", "gf"),
	row("wo", "Latn", "wol_Latn", "mg"),
	row("xh", "Latn", "xho_Latn", "mg"),
	row("yi", "Hebr", "ydd_Hebr", "mgf"),
	row("yo", "Latn", "yor_Latn", "mgef"),
	row("yue", "Hant", "yue_Hant", "gf"),
	row("zu", "Latn", "zul_Latn", "mg"),

	// ---- Not in FLORES-200, but in M2M-100, Google or a detector
	row("br", "Latn", null, "mf"),
	row("co", "Latn", null, "gf"),
	row("doi", "Deva", null, "g"),
	row("dv", "Thaa", null, "gf"),
	row("ff", "Latn", null, "mg"),
	row("fy", "Latn", null, "mgf"),
	row("gom", "Deva", null, "gf"),
	row("gsw", "Latn", null, "", { fasttext: "als" }), // fastText's `als` is Alemannic, not Albanian
	row("haw", "Latn", null, "g"),
	row("hmn", "Latn", null, "g"),
	row("kri", "Latn", null, "g"),
	row("la", "Latn", null, "gf"),
	row("mni-Mtei", "Mtei", null, "g"),
];
