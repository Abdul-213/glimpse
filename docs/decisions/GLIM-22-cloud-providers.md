# GLIM-22: Decision on the first cloud OCR and translation providers

Status: **Accepted, provisional** (2026-11-01, adopted so build work can start; the owner can override) · Date: 2026-10-30 · Scope: Windows + macOS; the first cloud OCR provider (ticket 9.3) and the first cloud translation provider (9.4), plus a ranked list for later. Bring-your-own-key only, with keys in the OS keychain, called with plain `fetch` from the Bun process. Assumes the GLIM-85 (local model) and GLIM-20 (cache) proposals, neither accepted yet. Pricing and terms were read from public pages on 2026-10-30. No accounts were created and no APIs were called. Not legal advice.

## Recommendation

**First OCR provider: Google Cloud Vision** (`images:annotate` with `TEXT_DETECTION`, switching to `DOCUMENT_TEXT_DETECTION` for dense paragraphs).

**First translation provider: Google Cloud Translation, Basic (v2)** (`/language/translate/v2`, NMT model).

**One Google Cloud API key, restricted to those two APIs, covers both.** The user creates one project, enables billing once, enables two APIs, and pastes one key. Glimpse stores it once in the keychain.

**Recommended pairing: local OCR (PaddleOCR) plus cloud translation.** Make it the default cloud setup, and the only cloud option suggested for Live. Cloud OCR is a separate, explicit opt-in, aimed at Snip.

Why:

1. **It is the only option that covers every script we must support, for both OCR and translation, with a key that works from `fetch`.** Vision fully supports Chinese (Simplified and Traditional), Japanese, Korean, Arabic, Hebrew, Hindi, Thai and Cyrillic. It returns per-block `detectedLanguages`, which GLIM-21 can use as a hint. Translation v2 lists about 190 language codes. The rivals each fail one of these tests:
   - Azure Image Analysis 4.0 Read lacks Hebrew and Thai, and retires in September 2028.
   - Azure Document Intelligence covers the scripts, but it works by submit-then-poll.
   - Textract and Rekognition read only 6 and 8 languages respectively, with no CJK.
   - Amazon Translate and Google v3 need SigV4 or OAuth.
2. **The data terms match the privacy stance without the user changing any setting.** For both services Google says it does not use the content to train its models. Vision says online request images are "processed in memory and not persisted to disk", and Translation says text is "held briefly in-memory". Contrast:
   - AWS uses Textract and Translate inputs to improve its services unless the user sets up an AWS Organizations opt-out.
   - DeepL's free API plan reserves the right to "perpetually store" content.
   - Gemini's free tier lets Google use the content and have humans review it.
3. **One account and one key halve the onboarding and the engineering.** There is one key-entry screen, one "how to get a key" guide, one keychain entry, and one error and quota model (Google's standard JSON errors). The cloud indicator names one company. The free tiers never expire: Vision gives 1,000 images/month, and Translation gives 500k characters/month as a $10 monthly credit. That makes typical Snip use free. Live with local OCR costs roughly $0–15/month for Google (estimate below).

What we are *not* recommending first, and why:

- **DeepL.** It has the best API features for our text: a free `context` field, formality, glossaries. Many users will ask for it, and it is #3 on the list. But the free plan is now the *Developer* plan: 1M characters once, never reset, with a "perpetually store" clause in DeepL's terms (§1.13, §3.3.2). Clean terms need the paid Growth plan, a monthly subscription (price not shown server-side; third parties cite about €24–30/month, unverified). A paid subscription is a poor first experience for a BYOK desktop tool.
- **Azure Translator, as the first translator.** On translation alone it is the strongest rival: $10/1M, 2M free chars/month, a "No Trace" policy, 1,000 strings per request, and an official 150–300 ms latency figure for short text. It is #2. It loses here because Azure's OCR is the weaker half (above), and pairing Azure translation with Google OCR would mean two cloud accounts and two keys.
- **LLM APIs (Claude, GPT, Gemini) as the first provider.** WMT24 and WMT25 found that frontier LLMs now beat the online NMT services on translation, and paid small models are cheap. But they bring:
  - output that varies between calls (the cache helps but doesn't fix it),
  - prompt injection from text on screen,
  - the need for an output validator,
  - higher and more variable latency.

  Gemini's free tier also conflicts with the privacy stance. They belong in a second wave as an "LLM translator" provider, built after the first provider has defined the provider interface.
- **Cloud OCR in Live mode as a recommended setup.** It sends every changed frame of the region as an image. It costs several times more than sending text (estimate below) and exposes everything in the region, not only the text being translated.

## Ranked list for later

**OCR**

| Rank | Provider | Why it's here | Main caveat |
|---|---|---|---|
| 1 | **Google Cloud Vision** | Recommended first (above) | Billing account and card required |
| 2 | **Azure AI Document Intelligence, Read model** (`prebuilt-read`, v4.0) | Covers every script we need (adds Hebrew, Thai, Greek and Ukrainian over Vision 4.0) and returns detected languages. Input and results are deleted within 24 h. One Azure AI services (multi-service) key also covers Translator. | Asynchronous (POST, then poll with `retry-after`), so each Snip costs an extra round trip. The F0 tier gives only 500 pages/month at 1 request/s. |
| 3 | **Gemini API, paid tier, as OCR** (Flash-Lite class) | Strongest LLM on multilingual and CJK OCR (CC-OCR V2: Gemini 3.1 Flash 93.6 vs Claude Sonnet 4.6 82.9 and GPT-5.5 74.3). Returns native `box_2d` boxes. Can OCR and translate in one call. | Hallucination and omission failure modes, prompt injection, latency. The free tier allows training and human review, so we would need to tell users to use a billed key. Box precision is below a dedicated OCR engine's. |
| 4 | **OCR.space** | Easiest key of any provider (free key by e-mail, 25k requests/month), German company, "all uploaded documents are deleted after processing" | Engine 2 covers 33 languages and its coverage of Thai, Hindi and Hebrew is unverified. Engine 3 (200+ languages) is slower, with a separate 1k/month quota. Training use isn't addressed. No SLA. 1 MB file limit on the free tier. |
| 5 | **Mistral OCR 3** | $2/1,000 pages; strong on documents | Returns markdown and blocks, not word boxes, so it suits pasted paragraphs more than an overlay. Claims "40+ languages". Data-use defaults unverified (training opt-out toggle in the admin panel). |
| n/a | *Rejected:* AWS Textract (6 Latin languages), AWS Rekognition DetectText (8 languages, no CJK, 100 words max), Azure Image Analysis 4.0 Read (no Hebrew or Thai, retires 2028-09-25), Claude and GPT as OCR (weaker on non-Latin scripts in CC-OCR V2; OpenAI's own docs warn about Japanese and Korean) | | |

**Translation**

| Rank | Provider | Why it's here | Main caveat |
|---|---|---|---|
| 1 | **Google Cloud Translation Basic (v2)** | Recommended first (above) | $20/1M is twice Azure's price. No formality, glossary or context options on v2. Its quality on short text has no independent benchmark (Google isn't de-anonymised in WMT). |
| 2 | **Azure AI Translator** (global resource, S1/F0) | Cheapest ($10/1M) with the biggest free tier (2M chars/month). "No Trace". 1,000 strings or 50k chars per request suits Live batching. Official latency of 150–300 ms for text under 100 chars. 138 languages. | Azure signup (phone plus card), creating a resource in the portal, region header for regional or multi-service keys. |
| 3 | **DeepL API, Growth or Pro (paid) only** | `context` (free, not billed) suits dialogue and chat. Formality, glossaries, `custom_instructions`. DeepL's vendor blind tests rank it above Google and Microsoft. Simple header key. | Monthly subscription. Glimpse should **warn on Developer-plan keys** (`:fx` suffix, `api-free.deepl.com` host) that DeepL may store the text perpetually. Coverage is about 36 stable languages plus about 70 beta; beta availability per plan is unverified. |
| 4 | **LLM translator** (one provider class, one adapter per vendor: Claude, OpenAI, Gemini paid tier) | Top of WMT24 (Claude 3.5 Sonnet) and WMT25 (Gemini 2.5 Pro) human evaluations. Can take neighbouring lines as context. Cheap on small models ($0.10/$0.50 per 1M tokens for Claude Haiku 5.5 and gpt-6-luna). | Output varies between calls. Prompt injection. Needs JSON-schema output plus a validator (GLIM-20 already only caches validated output). Small-model time to first token ranges from 0.4 s to several seconds depending on reasoning settings. Gemini free keys conflict with the privacy stance. |
| 5 | **LibreTranslate, self-hosted** (user's own server URL and optional key) | AGPL server, nothing goes to a third party, returns `detectedLanguage` | Argos/OpenNMT models, weaker than the commercial engines (no WMT evidence). 51 languages. Mostly overlaps with Glimpse's own local models, so it is low value. The hosted plan ($29/month, no free tier) is not worth targeting. |
| n/a | *Rejected:* Amazon Translate (SigV4 signing, one string per call, inputs used for training unless the user sets up an Organizations opt-out, the 12-month free tier no longer applies to accounts created after 2025-07-15), Google Translation Advanced v3 and Translation LLM (no API-key auth; needs OAuth or a service account) | | |

## Comparison: OCR

"Unverified" means it came from a secondary source or a search snippet, not the provider's page as read.

| | Google Cloud Vision | Azure Doc Intelligence Read | Azure Vision 4.0 Read | AWS Textract | OCR.space | Gemini (paid) as OCR | Claude / GPT as OCR |
|---|---|---|---|---|---|---|---|
| **Quality evidence** | AIMultiple (Nov 2025, English only): 95% printed text, 85% printed media. No independent CJK or screenshot benchmark found. | AIMultiple: 96% printed (English) | Shares the Read engine (*unverified*) | AIMultiple: 95% (English) | None found | CC-OCR V2 recognition: 3.1 Flash 93.6, 3.1 Pro 94.0. OCRBench v2 (Sep 2026): Gemini 3 Pro 63.4 EN / 63.8 ZH; specialist OCR leads at 76.2. | CC-OCR V2: Claude Sonnet 4.6 82.9 ("weaker on East Asian text"), GPT-5.5 74.3 ("degradation on non-Latin scripts") |
| **Scripts we need** (CJK, Arabic, Hebrew, Devanagari, Thai, Cyrillic) | **All supported** (Hebrew code `iw`); about 230 codes | **All** | Missing Hebrew and Thai | Latin only (en, fr, de, it, pt, es) | Engine 2: 33 languages, rest unverified; Engine 3: 200+ claimed | All in practice | All, with weaker CJK |
| **Per-block language** | Yes (`detectedLanguages` with confidence) | Yes | No | No | No | If asked in the prompt | If asked in the prompt |
| **Boxes** | Word, block, paragraph, symbol polygons | Word and line polygons | Word and line polygons | Word and line | Word and line (overlay mode) | `box_2d`, 0–1000 scale | Approximate (Claude); weak (GPT) |
| **Call shape** | Sync; JSON with base64 `image.content`; 20 MB image / 10 MB request; 16 images per request | **Async** POST then poll (≤1 poll/2 s advised) | Sync; binary body; 50 px minimum side | Sync; JSON base64; 10 MB | Sync; multipart or base64 | Sync or SSE | Sync or SSE |
| **Latency** | 200–400 ms (*unverified*, third-party blog) | 1–3 s (anecdotal, MS Q&A) | 300–500 ms (anecdotal, MS Q&A) | 0.5–2 s (*unverified*) | Unknown; Engine 3 slower | 0.4 s TTFT for 2.5 Flash-Lite non-reasoning (Artificial Analysis); newer models are slower with thinking on | ~0.8–1 s TTFT non-reasoning |
| **Price** | $1.50 / 1,000 images to 5M, then $0.60 (*from search snippets of the official page; the page didn't render for us*) | $1.50 / 1,000 pages | $1.50 / 1,000 | $1.50 / 1,000 pages | Free, or PRO $30/month for 300k | Per token: 280 image tokens at low resolution; about $0.0001 per call on 3.1 Flash-Lite (*our arithmetic*) | Claude Haiku 5.5 about $0.0001 per call for an 800×200 crop (*our arithmetic*) |
| **Free tier** | 1,000 units/month, permanent | 500 pages/month, 1 req/s | 5,000 tx/month, 20/min (conflicting "12 months" wording on the free-account page) | 1,000 pages/month for 3 months, old accounts; new accounts get credits | 25,000/month, 500/day per IP | Yes, but **content used for training and human review** | None (Anthropic); OpenAI "Free" tier listing unclear |
| **Rate limits** | 1,800 req/min per project | S0: 15 analyze calls/s | 30 RPS paid (v3.2 doc) | 1–25 TPS by region | Unpublished | Shown in AI Studio only | Entry tiers 1,000–5,000 RPM |
| **Auth from `fetch`** | `?key=` or `x-goog-api-key` | `Ocp-Apim-Subscription-Key` + endpoint | Same | **SigV4** | `apikey` header | `x-goog-api-key` | `x-api-key` / `Bearer` |
| **Signup friction** | Google account, Cloud project, **billing enabled (card)**, enable API, create and restrict key | Azure account (phone plus card), create resource | Same | AWS account (card), IAM user, access keys | E-mail form | Google account, one click in AI Studio (free tier); billing for paid | Phone, card, prepaid credits |
| **Training on content** | **No** | **No** (deleted ≤24 h) | **No** | **Yes unless opted out** | Not stated (deleted after processing) | Paid: no. Free: yes. | No (API defaults) |
| **Same key does translation** | **Yes** (Translation v2) | Yes, with a multi-service key and region header | Same | Same IAM creds (*unverified*) | No | Same model, same call | Same |

## Comparison: translation

| | Google Translation v2 | Azure Translator | DeepL API | Amazon Translate | LibreTranslate | LLMs (small paid models) |
|---|---|---|---|---|---|---|
| **Quality evidence** | Not de-anonymised in WMT; no independent short-text data. Widely used baseline. | No independent 2025–26 evaluation found | Vendor blind tests (1.3× preferred over Google, 2.3× over Microsoft; *vendor claim*). Intento 2024/2025 reportedly best dedicated real-time engine (*secondary, unverified*). | Included in Intento 2025, results not public | No evaluations found; generally weaker (*unverified*) | WMT24: Claude 3.5 Sonnet best overall (9 pairs). WMT25: Gemini 2.5 Pro best overall; the anonymised online systems placed low (ONLINE-B: 0 wins, average rank 9.6). Large models were tested, not the small ones. |
| **Short text / CJK** | No data. GLIM-21 detection plus an explicit `source` avoids short-string misdetection. | Official latency figure for text under 100 chars; no quality data | `context` lets a short line carry its neighbours, unbilled. DeepL claims gains for ja and zh. | No data | No data | Can take context; may over-explain or add notes; needs a strict schema |
| **Languages** | ~190 codes | 138 | ~36 stable + ~70 beta (Nov 2025) | 75 | 51 (hosted) | Broad but uneven |
| **Price per 1M chars** | $20 | $10 | Growth: subscription plus overage (≈$27.50/1M cited; *unverified*) | $15 | $0 self-hosted | ≈$0.30–1 per 1M chars on Haiku 5.5 or gpt-6-luna class models (*estimate*, depends on tokenizer and prompt) |
| **Free tier** | 500k chars/month ($10 credit, shared with v3) | 2M chars/month (F0, ≤2M/hour, spread evenly) | Developer: 1M chars **once**, with a perpetual-storage clause | Credits only for new accounts | n/a | Gemini free tier only (training and review) |
| **Batching** | Multiple `q` per request (128-segment cap *unverified*); 100k bytes/request | 1,000 strings / 50k chars per request | `text[]` up to 128 KiB | One string, 10 KB | `q[]`, server `BATCH_LIMIT` | One prompt with a JSON array |
| **Rate limits** | 300k req/min, 6M chars/min per project | F0 2M chars/hour; S1 40M/hour | "At least 600 chars/min" guaranteed; 429 with backoff, 456 = quota out | Contact support | Self-set | 1,000–5,000 RPM entry tiers |
| **Latency (short text)** | ~0.2–0.6 s (*unverified*, third party) | **150–300 ms** (official, text under 100 chars) | ~0.5–1 s (*unverified*); `latency_optimized` model option | ~0.33 s (*unverified*) | Self-host dependent | 0.4–1 s TTFT non-reasoning; several seconds with reasoning |
| **Detected language returned** | Yes (`detectedSourceLanguage`, *from docs memory, unverified*) | Yes (*unverified*) | Yes (`detected_source_language`) | Yes | Yes, with confidence | If asked |
| **Auth from `fetch`** | `?key=` / `x-goog-api-key` (v2 only; v3 has no API keys) | `Ocp-Apim-Subscription-Key` (+ `-Region`) | `Authorization: DeepL-Auth-Key`; free host `api-free.deepl.com` | **SigV4** | `api_key` field | Header key |
| **Signup friction** | Billing account plus card; same project as Vision | Azure account (phone plus card), resource | Card required even for the free plan (*per third parties*) | AWS account, IAM | Own server | Phone, card, prepay (Claude, OpenAI); one click (Gemini free) |
| **Training / retention** | **Not used for training**; held briefly in memory | **No Trace**: not stored | Paid: temporary only, up to 72 h encrypted for error diagnosis, "no data training". **Developer (free): may store perpetually.** | **Used to improve services unless opted out** | Hosted: no text logs, IP and key kept 2 days | Claude: deleted within 30 days, no training. OpenAI: up to 30 days abuse logs, no training. Gemini paid: limited-period logging, no training. Gemini free: training and human review. |

## Privacy and data use

**What leaves the machine, and only when the user has chosen a cloud provider for that stage:**

| Pipeline | Sent to the cloud | Never sent |
|---|---|---|
| **Local OCR + cloud translation** (recommended) | Only the normalised text of *translate-class* segments that missed the cache (GLIM-21 decision, GLIM-20 key), with `source` and `target` codes | Pixels; neutral blocks (rule 1); blocks outside the source-language subset ("skipped"); blocks already in the target language; bounding boxes; app or window names. Neighbouring lines go only if a context option is on (DeepL `context`, LLM context), and that option is opt-in and stated in the UI. |
| **Cloud OCR** (opt-in) | The **cropped region only**, as lossless PNG, re-encoded from the raw capture buffer so it has no metadata. Never the full screen, and never Glimpse's own windows (excluded at OS level). | Anything outside the selected region |
| **Cloud OCR + cloud translation** | Both of the above, to the same company if the provider is Google | |

So local OCR plus cloud translation sends less than cloud OCR does. Images carry everything in the region: avatars, names, other people's messages, untranslated blocks. Text carries only the segments the user asked to translate. Text is also cheaper and faster, and it keeps the cache effective. That is why it is the recommended pairing. Cloud OCR is for Snips where local OCR struggles (stylised game fonts, low contrast, handwriting) and for scripts PaddleOCR handles poorly.

**Provider terms that matter (as read 2026-10-30):**

- **Google Cloud Vision:** for online requests, "the image data is processed in memory and not persisted to disk"; "Google does not use the content you send to train and improve our Cloud Vision features"; request metadata is logged temporarily. [3]
- **Google Cloud Translation:** text is "held briefly in-memory"; "Google does not use the content you send to train and improve our Google Translation features". [6]
- **Azure Translator:** "doesn't store customer data" (No Trace). **Azure OCR (Read):** input and results "deleted within 24 hours and not used for any other purpose" (doc updated 2025-10-15). [10][12]
- **DeepL:** paid plans store content "only temporarily… to the extent technically required" (§3.1.2), with a diagnostic exception of up to 72 h (§3.1.4). The free *Developer* plan "reserves the right to perpetually store any Content or Processed Content" (§3.3.2). [14]
- **AWS Textract and Translate:** inputs "may be stored and used" to improve AWS AI services. Opting out needs an AWS Organizations AI-services opt-out policy. That is too much to ask of a normal user, so AWS is rejected. [17][19]
- **Gemini API:** on unpaid services, Google uses content to improve products, and "human reviewers may read, annotate, and process your API input and output". Google says "Do not submit sensitive, confidential, or personal information to the Unpaid Services". Paid services aren't used for training. In the EEA, Switzerland and the UK, API clients offered to users there may use **only Paid Services**. A BYOK desktop app may fall under this, which needs a check (Additional Terms, effective 2026-03-23). [23]
- **Anthropic API:** inputs and outputs deleted within 30 days (exceptions: ZDR, Files API, policy flags up to 2 years, legal holds); not used for training without permission. **OpenAI API:** not used for training by default; abuse-monitoring logs kept up to 30 days. [21][22]

**Rules for Glimpse:**

1. Cloud is off until the user adds a key and picks a provider for a stage (OCR, translation, or both). No silent fall-through to the cloud: a missing local language pack (GLIM-85) shows "pack not installed", never a cloud call.
2. Keys go only into the OS keychain, never into settings files or logs. Requests come from the Bun process, never the webview. Onboarding tells the user to **restrict the Google key** to "Cloud Vision API" and "Cloud Translation API".
3. Show the provider's data terms, one sentence plus a link, on the key-entry screen. For providers whose free tier trains on content (Gemini free, DeepL Developer), show a warning there and, where the key or host shows the plan, on the result too.
4. Cached cloud results keep their cloud badge (GLIM-20). Changing or removing a key drops that provider's cache entries (GLIM-20).
5. Glimpse sends no telemetry about cloud use. Usage counters for the spend guard (Risks) stay local.

## The cloud-in-use indicator: how to name providers

- **Name the service and the company, per stage, on every result that used it.** Example: "Translated by Google Cloud Translation". If OCR was also cloud: "Text read by Google Cloud Vision · Translated by Google Cloud Translation". Local stages are named too ("Text read on this device"), so the difference is visible.
- **Say what was sent**, in the result's details or tooltip: "Image of the selected area sent to Google Cloud Vision" or "Text sent to Google Cloud Translation (3 segments)". Image versus text is the distinction users care about.
- **Tray / menu bar:** a persistent cloud state while any cloud provider is selected, naming the company ("Cloud: Google"). While a Live session sends requests, add an activity mark. Naming the company, not just "cloud", follows Principle 4.
- **LLM providers:** name vendor and model ("Gemini 3.1 Flash-Lite, Google"; "Claude Haiku 5.5, Anthropic"). The model affects quality and changes over time, and GLIM-20 keys on it anyway.
- **Use the provider's own product names**, not logos, so we avoid trademark questions and stay with the calm, non-branded visual style. Copy lives in one table in the provider registry so the names stay consistent across popup, tray and settings.
- **Cached cloud result:** same badge plus "(remembered)", because the text did leave the machine when it was first translated.

## Cost per month (estimates, not measured)

**These are estimates.** The usage profiles are assumptions. Prices are list prices from the pages cited, read 2026-10-30, and exclude tax. Cache hit rates come from GLIM-20's estimates, which are also unmeasured.

Assumptions:

- **Light Snip:** 20 snips/day, ~300 chars each, 30 days → 600 images, 180k chars.
- **Heavy Snip:** 100 snips/day → 3,000 images, 900k chars.
- **Live, game dialogue:** 2 h/day, 20 days/month. One new settled change about every 6 s (600 per hour) at ~80 chars each. Cache hits at 40% → **~1.15M billed chars**. With cloud OCR, one image per settled change → **24,000 images**.
- **Live, subtitles:** two 2-hour films a week, a line every ~3 s at ~50 chars, ~1M chars raw, cache hits at 50% → **~0.5M billed chars**. With cloud OCR, ~20,000 images.

| Profile | Google Vision OCR (1k free, then $1.50/1k) | Google Translation v2 (500k free, then $20/1M) | **Google total** | Azure Translator (2M free, then $10/1M) | DeepL Growth | Small LLM translator |
|---|---|---|---|---|---|---|
| Light Snip, cloud OCR + cloud translation | $0 | $0 | **$0** | $0 | Subscription (≈€24–30/month, *unverified*) | < $0.10 |
| Heavy Snip, cloud OCR + cloud translation | $3.00 | $8.00 | **≈ $11** | $0 | Subscription | < $0.50 |
| Live dialogue, **local OCR + cloud translation** | $0 | $13.00 | **≈ $13** | $0 | Subscription | ≈ $0.50–1 |
| Live dialogue, cloud OCR + cloud translation | $34.50 | $13.00 | **≈ $48** | (+ Google OCR $34.50) | | |
| Live subtitles, local OCR + cloud translation | $0 | ≈ $0.40 | **≈ $0–1** | $0 | Subscription | ≈ $0.25 |

What follows from this:

- Snip users fit almost entirely in Google's free tiers.
- **Cloud OCR in Live is the expensive case,** about 2.5× the translation cost in the dialogue profile. That supports the pairing above and a cost warning before a Live session uses cloud OCR.
- For heavy Live translation, Azure (2M free/month) or a small LLM is much cheaper than Google. That is the main reason Azure is #2 and a cheap LLM provider is on the list.
- LLM costs are rough: tokens per character vary by script and tokenizer (Claude 4.7+ models use ~30% more tokens per text), and the prompt and schema overhead per batch dominates for short strings.

## Integration notes

- **Provider interface.** Use GLIM-85's `translate(blocks[], src, tgt)` and an OCR equivalent `recognise(image, hints)`. Each provider declares `isCloud`, `sends: "image" | "text"`, `contextSensitive`, and the copy for the indicator. GLIM-20's `ProviderFingerprint` keys `cloud:google-translate-v2` with the model (`nmt`) and an options hash.
- **Google Vision call.** `POST https://vision.googleapis.com/v1/images:annotate` with the `x-goog-api-key` header (preferred over `?key=` so the key isn't in URLs or logs). Body: `{requests:[{image:{content:<base64 PNG>}, features:[{type:"TEXT_DETECTION"}], imageContext:{languageHints:[…]}}]}`. Pass the user's source subset as `languageHints` only when it is small. TEXT_DETECTION auto-detects only a subset of languages without hints, and DOCUMENT_TEXT_DETECTION detects all. Prefer DOCUMENT_TEXT_DETECTION for the any-script case: same price (*unverified*), and its blocks map better to our "block". Map `fullTextAnnotation` blocks to GLIM-21 blocks, and use `detectedLanguages` as a prior, not as the decision.
- **Google Translation call.** `POST https://translation.googleapis.com/language/translate/v2` with `q[]` (one per segment, a batch per Live frame), `source` (always set, from GLIM-21; this avoids auto-detect mistakes on short strings), `target`, and `format=text` (not HTML, so `<`/`&` in game text survive). Map FLORES codes to Google codes (`zho_Hans→zh-CN`, `zho_Hant→zh-TW`, `heb_Hebr→iw`/`he`, …).
- **Errors.** 403 `API_KEY_INVALID` / `SERVICE_DISABLED` / billing disabled each get a specific fix-it message (the most likely first-run failure is "Cloud Translation API not enabled"). 429 gets backoff; Live drops stale frames rather than queueing.
- **Spend guard (Glimpse side).** Keep a local monthly counter of images and characters per provider, show estimated spend in Settings, and offer a soft cap (default: warn when the free tier is used up; optional hard stop). Google Cloud budgets only alert; they don't stop spend. Also link the user to the per-API quota page, where they can cap requests per day.

## Risks

- **Signup friction is real.** A Google Cloud billing account needs a card, and creating a project and enabling APIs is a developer flow. Cloud is opt-in for a minority, so this is acceptable, but the guide must be step-by-step with screenshots, and it will go stale as Google changes the console. (OCR.space and Gemini free keys are easier, but fail the privacy or coverage bar.)
- **Surprise bills.** Nothing at Google hard-caps spend by default, and a Live session with cloud OCR can cost tens of dollars a month. Mitigation: the spend guard, a warning before Live uses cloud OCR, and quota-cap guidance.
- **API-key leakage.** An unrestricted Google key can call any enabled API in the project. Mitigation: insist on API restrictions in the guide, keep the key in the keychain and in headers only, never log it.
- **Translation v2 is the "Basic" legacy edition.** Google steers new features (Translation LLM, glossaries, adaptive) to v3, which has no API keys. If Google ever drops API keys for v2, the provider breaks. Mitigation: keep the provider small; Azure (#2) is the fallback. Azure's own retirement of Image Analysis 4.0 shows these changes happen.
- **Quality on our text is unmeasured.** No benchmark covers UI labels, game dialogue or subtitles for any provider. The LLM-vs-NMT evidence (WMT25) suggests Google NMT is not the quality leader. Users chasing quality will want DeepL or an LLM, which is the next provider to build.
- **Pricing and terms drift.** DeepL changed its plans in 2026, AWS its free tier in 2025, Gemini its free limits more than once. Restate prices with a date in the UI copy and re-check before each release.
- **Some figures are unverified.** The Google Vision price table didn't render for us (figures from search snippets of the official page). Latency numbers for Google, DeepL and Amazon are third-party. Several DeepL plan details come from secondary sources.
- **Gemini EEA/UK rule** (only paid services for API clients offered there) could affect a later Gemini provider. Needs a read before it ships.

## Open questions

1. **Google or Azure for translation?** This doc picks Google for the single key and broader coverage. Azure is half the price, has 4× the free tier, and publishes short-text latency. If the sign-off weighs Live cost over setup simplicity, swap them. The provider work is similar either way.
2. **Default pairing in Settings.** Should picking "Google" turn on only cloud translation (recommended), or both stages? And should cloud OCR in Live require a per-session confirmation or only a one-time warning?
3. **Spend-guard defaults.** Warn at the end of the free tier, or at a dollar amount? Should the hard stop be on by default?
4. **Context.** Should providers that support it (DeepL `context`, LLMs) ever get neighbouring lines by default? It improves dialogue translation but sends more text and cuts cache hits (GLIM-20).
5. **Which LLM vendor first** for the LLM translator (#4), and do we support Gemini free keys at all given the training and human-review terms? Can a free Gemini key be told apart from a paid one at runtime? (*unknown*)
6. **DeepL Developer keys:** block them, or allow them with a clear "DeepL may keep this text" warning?
7. **Test set.** Reuse GLIM-85 open question 6's real-OCR set (ja, ko, zh, es, de, ru, ar) to score Google, Azure, DeepL and one small LLM on short blocks before choosing the #2 provider. That needs keys and a small budget, which is out of scope for this doc.

## Sources

Read 2026-10-30 unless noted. "Snippet" means only a search-engine excerpt of the official page was readable.

1. Google Cloud Vision pricing (snippet; page didn't render): https://cloud.google.com/vision/pricing · free-tier summary (1,000 units/month): https://docs.cloud.google.com/free/docs/free-cloud-features
2. Vision OCR, request format and language hints: https://docs.cloud.google.com/vision/docs/ocr · languages: https://docs.cloud.google.com/vision/docs/languages · response reference (`detectedLanguages`): https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse · quotas: https://docs.cloud.google.com/vision/quotas · setup (billing): https://docs.cloud.google.com/vision/docs/setup
3. Vision data usage: https://docs.cloud.google.com/vision/docs/data-usage
4. Cloud Translation pricing (500k free as a $10 credit; v2/v3 NMT $20/1M; LLM $10+$10): https://cloud.google.com/translate/pricing
5. Translation authentication (v2 API keys, v3 none): https://docs.cloud.google.com/translate/docs/authentication · setup (billing required): https://docs.cloud.google.com/translate/docs/setup · quotas: https://docs.cloud.google.com/translate/quotas · languages: https://docs.cloud.google.com/translate/docs/languages
6. Translation data usage: https://docs.cloud.google.com/translate/data-usage
7. Azure Image Analysis 4.0 overview and retirement (2028-09-25): https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-image-analysis · migration: https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/migration-options · language support: https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/language-support · call guide: https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/how-to/call-analyze-image-40
8. Azure Document Intelligence pricing: https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/ · limits: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits · OCR languages: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/ocr
9. Azure retail prices API (Read $1.50/1k; Translator S1 $10/1M effective 2025-05-01): https://prices.azure.com/api/retail/prices · Vision pricing (F0): https://azure.microsoft.com/en-us/pricing/details/cognitive-services/computer-vision/ · free account (phone, card): https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account
10. Azure OCR data privacy (updated 2025-10-15): https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/computer-vision/ocr-data-privacy-security
11. Azure Translator pricing: https://azure.microsoft.com/en-us/pricing/details/translator/ · service limits and latency (2026-08-11): https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits · languages: https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support · auth: https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication
12. Azure Translator data privacy (No Trace): https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/translator/data-privacy-security
13. Azure latency anecdote (MS Q&A, June 2026): https://learn.microsoft.com/en-us/answers/questions/5923493/ocr-latency-azure-ai-vision-imageanalysis-analyze
14. DeepL terms (§1.13 Developer = free API, §3.1.2, §3.1.4, §3.3.2): https://www.deepl.com/en/pro-license · plans: https://www.deepl.com/en/pro-api · privacy policy: https://www.deepl.com/en/privacy
15. DeepL Developer plan (1M chars total, not reset; snippet of support article): https://support.deepl.com/hc/en-us/articles/360021200939 · card at signup (third party): https://translatepress.com/docs/addons/deepl-automatic-translation/ · Growth pricing (third party, unverified): https://flexprice.io/pricing-index/deepl-translator, https://simplelocalize.io/blog/posts/ai-machine-translation-cost-comparison/
16. DeepL API reference (`context`, formality, `tag_handling`, 128 KiB): https://developers.deepl.com/api-reference/translate · usage limits: https://developers.deepl.com/docs/resources/usage-limits · languages: https://www.deepl.com/en/press-release/deepl-accelerates-global-business-connectivity-and-document-translation-with-new-languages, https://www.deepl.com/en/press-release/deepl_unveils_next-gen_language_ai_tools_and_game-changing_agentic_productivity_solution · vendor quality claims: https://www.deepl.com/en/blog/next-gen-language-model
17. AWS Textract pricing: https://aws.amazon.com/textract/pricing/ · FAQ (languages, data use): https://aws.amazon.com/textract/faqs/ · limits: https://docs.aws.amazon.com/textract/latest/dg/limits-document.html · quotas: https://docs.aws.amazon.com/general/latest/gr/textract.html · Rekognition text: https://docs.aws.amazon.com/rekognition/latest/dg/text-detection.html
18. AWS Free Tier change (accounts from 2025-07-15): https://aws.amazon.com/free/ · https://aws.amazon.com/blogs/aws/aws-free-tier-update-new-customers-can-get-started-and-explore-aws-with-up-to-200-in-credits
19. Amazon Translate pricing: https://aws.amazon.com/translate/pricing/ · FAQ (data use): https://aws.amazon.com/translate/faqs/ · TranslateText: https://docs.aws.amazon.com/translate/latest/APIReference/API_TranslateText.html · AI-services opt-out: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html
20. OCR.space API and limits: https://ocr.space/ocrapi · privacy: https://ocr.space/privacypolicy · Mistral OCR 3: https://mistral.ai/news/mistral-ocr-3, https://docs.mistral.ai/capabilities/document_ai/basic_ocr · LibreTranslate: https://portal.libretranslate.com/, https://portal.libretranslate.com/privacy.html, https://docs.libretranslate.com/guides/api_usage/
21. Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing · vision (tokens per image, limitations): https://platform.claude.com/docs/en/build-with-claude/vision · retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data · data use: https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention · rate limits: https://platform.claude.com/docs/en/api/rate-limits
22. OpenAI pricing: https://developers.openai.com/api/docs/pricing · vision guide (non-Latin caveat): https://developers.openai.com/api/docs/guides/images-vision · data controls: https://developers.openai.com/api/docs/guides/your-data · rate limits: https://developers.openai.com/api/docs/guides/rate-limits
23. Gemini API pricing (free vs paid, "used to improve our products"): https://ai.google.dev/gemini-api/docs/pricing · Additional Terms (effective 2026-03-23): https://ai.google.dev/gemini-api/terms · image understanding (`box_2d`): https://ai.google.dev/gemini-api/docs/image-understanding · media resolution: https://ai.google.dev/gemini-api/docs/media-resolution · API keys: https://ai.google.dev/gemini-api/docs/api-key
24. WMT24 findings: https://aclanthology.org/2024.wmt-1.1/ · WMT25 findings: https://aclanthology.org/2025.wmt-1.22/ · WMT25 preliminary automatic ranking: https://arxiv.org/abs/2508.14909
25. CC-OCR V2: https://arxiv.org/abs/2605.03903 · CC-OCR: https://arxiv.org/abs/2412.02210 · OCRBench v2 leaderboard: https://99franklin.github.io/ocrbench_v2/ · AIMultiple OCR accuracy (English): https://aimultiple.com/ocr-accuracy
26. Latency (third party, unverified): https://artificialanalysis.ai/leaderboards/models · https://machinetranslation.com/blog/translation-engines-benchmark · https://wxrks.com/blog/best-machine-translation-api · https://imagetotable.ai/blog/google-vs-aws-vs-azure-ocr-2026
27. Image prompt injection: https://arxiv.org/abs/2603.03637 · https://arxiv.org/abs/2603.29418
28. Related Glimpse decisions: `docs/decisions/GLIM-21-language-detection.md` · GLIM-85 (branch `glim-85-translation-model`) · GLIM-20 (branch `glim-20-translation-cache`)
