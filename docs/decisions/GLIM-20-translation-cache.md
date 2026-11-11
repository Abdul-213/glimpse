# GLIM-20: Decision on the translation cache

Status: **Accepted, provisional** (2026-11-01, adopted so build work can start; the owner can override) · Date: 2026-10-30 · Scope: Windows + macOS; translation, language-detection and OCR result caching for Snip and Live; Bun/TypeScript first, Rust sidecar or Tauri fallback. Assumes the GLIM-85 proposal (Bergamot packs with an English pivot, optional Hy-MT2 "Enhanced", SMaLL-100 long tail), which is not yet accepted. The design doesn't depend on that choice. Only the key fields would change.

## Recommendation

**Yes, cache. Memory only, at sentence level, exact match, one cache shared by every provider. No disk cache in v1.**

1. **Translation cache (app-wide, in memory, for the life of the process).** One LRU shared by Snip and Live, holding **one entry per translated segment** (a sentence, after the splitting GLIM-85 asks for) and **per hop** (`ja→en` and `en→de` are separate entries). Key: `hash(normalised segment) + src + tgt + provider fingerprint (provider id, model revision, options hash, context hash if the provider uses context)`. Limits: **16 MB or 20,000 entries**, whichever comes first, evicting by least-recent use. In-flight requests are de-duplicated (single-flight), so a slow cloud call isn't fired again on every Live frame.
2. **Language-detection cache (per Live session).** Stores the GLIM-21 decision (`iso`, `flores`, `conf`, `rule`) keyed by the detection copy of the text. It exists for GLIM-21 rule 5a and the hysteresis rule (stability), not for speed: detection costs ~0.05 ms. Thrown away when the Live session ends.
3. **OCR reuse (per Live session), two cheap mechanisms, both exact:**
   - **Unchanged block regions keep their text.** If the pixel diff inside a block's bounding box is zero (or below the diff threshold) the block's previous OCR text is reused without running recognition on it. Pixel evidence, not text similarity, decides "unchanged".
   - **A ring of the last 8 frame hashes → OCR result.** Catches A→B→A toggling (blinking prompts, alternating menu states) where the whole region returns to a previous exact state.
4. **Exact matching only. No fuzzy matching** of near-duplicate text in v1. OCR jitter is handled upstream (point 3) and measured before any fuzzy rule is added.
5. **No disk persistence in v1.** If added later, it is opt-in, off by default, encrypted with a key held in the OS keychain, capped and expiring (spec below).
6. **Privacy controls:** a **Private** toggle (tray and Live popup) that gives the session its own isolated cache, discarded at the end. A **Clear translation cache** action in the tray and Settings. Automatic wipe on quit (inherent), on screen lock or system sleep, and after 15 minutes with no Snip or Live activity.
7. **Cloud results are cached the same way, with provenance.** A cached cloud result keeps its "translated by <provider>" badge. Switching to a local provider never shows a cloud-produced translation, because the provider id is in the key.
8. **Only cache successful, complete, validated output.** Never errors, cancellations, truncated streams, empty output, or LLM output that failed validation. A per-block "Retranslate" action bypasses the cache and overwrites the entry.

Why:

1. **Live mode needs it to meet "show change, not churn".** Ticket 7.7 (re-translate only changed blocks) is really a cache: "same source text, same settings → same result, no work". Exact caching also makes the output *deterministic*. An unchanged line can never change translation between frames, which matters for Hy-MT2 (an LLM) and for any cloud LLM provider whose output varies from call to call.
2. **Sentence- and hop-level entries are where the hits are.** In a chat pane a new message scrolls every older message into a new position and, often, a new block grouping. Block-level keys miss all of them; sentence-level keys hit all of them. With the English pivot, a cached `ja→en` hop is reused when the user changes target language, and the `en→de` hop is shared by every source language.
3. **Memory-only is enough for the speed benefit and keeps the privacy promise simple.** Live sessions are where repetition happens, and they live inside one app run. Across restarts the saving is small for a local model (tens of ms per segment, *estimated*) and the cost is captured screen content sitting on disk. "Leaves without a trace" (Product Principle 1) stays true by default.

## Reasoning

### What to cache, and at what granularity

| Layer | Cache? | Scope | Key | Why |
|---|---|---|---|---|
| Frame → OCR blocks | Yes, tiny ring (8) | Live session | 64-bit hash of the captured, cropped pixel buffer (exact) | A→B→A toggling. Rarely hits over video, and costs almost nothing. |
| Block region → block text | Yes (reuse, not a cache) | Live session | Block bbox + "pixel diff inside bbox below threshold" | Removes most OCR jitter at the source: if the pixels didn't change, neither did the text. |
| Detection decision | Yes | Live session | Detection copy of the text (GLIM-21) + detector id/version | Stability (rule 5a, hysteresis). Not cached app-wide: rule 5b depends on the other blocks in the capture. |
| Translation, per segment and hop | **Yes, the main cache** | App run, memory | See "Cache key" | The expensive step: tens of ms (Bergamot, *est.*), 0.5–1.5 s (Hy-MT2, *est.*), 200–800 ms plus money (cloud, *est.*). |
| Pivot intermediate (English) | Yes, as its own hop entry | App run, memory | Same as translation, with `tgt = en` | Reused across target changes and across source languages. Same sensitivity as any other entry. |
| Final assembled block | No | n/a | n/a | Assembling cached segments is cheap. A second layer would need its own invalidation. |

**Changed-block highlighting (7.7) is driven by source-text change, not by cache misses.** A block whose text changed back to something seen earlier is a cache hit but still a visible change, and must still be highlighted.

### Cache key

```
key = H( "v1" | normaliserVersion | segmenterVersion
       | normalisedSegment | srcFlores | tgtFlores
       | providerId | modelRev | optionsHash | contextHash? )
```

- **Normalisation is the same function that produces the translator's input.** The text that is hashed is exactly the text that would be sent. Then normalisation can never make two inputs share an entry while translating differently. Steps: Unicode NFKC; strip zero-width and BiDi control characters; turn OCR line breaks inside a block into spaces (except CJK, where they are removed, since CJK has no spaces between words); collapse runs of whitespace; trim. **Not** applied: case folding, punctuation removal, digit masking, or the homoglyph mapping GLIM-21 uses for script counting. Each of these changes what a translator produces (`Not now` vs `not now?`, `1 HP` vs `7 HP`, Latin `a` vs Cyrillic `а`).
- **`src` and `tgt` are the codes the provider actually received** (after the GLIM-21 decision and any FLORES→Bergamot mapping), not the user's settings. If detection on a later frame decides `pt` instead of `it`, that is a different key, which is correct.
- **`providerId`**: `bergamot`, `small100`, `hymt2`, `cloud:deepl`, … **`modelRev`**: the SHA-256 of the model files, which GLIM-85 already verifies at download (the registry's `uncompressedHash`), plus the runtime version for runtimes whose output can drift (bergamot-translator WASM build, ORT version for SMaLL-100, llama.cpp build for Hy-MT2). For cloud providers it is the model name the API reports when it reports one (`gpt-…`, DeepL's `model_type`), otherwise the provider id and a date bucket (see Risks).
- **`optionsHash`**: everything else that changes output: formality, glossary contents, beam size or temperature, LLM prompt template version, the Enhanced output validator version.
- **`contextHash`**: only for providers that declare `contextSensitive: true` (Hy-MT2 or a cloud LLM given neighbouring lines). It hashes the context actually passed. Bergamot and SMaLL-100 are sentence-level models with no context, so they omit it and get far better hit rates. If Enhanced is used with context, expect its hit rate to fall to roughly the "same frame repeated" case. That is the honest cost of context.
- **Pivot.** `ja→de` through Bergamot is two lookups: `(seg, ja, en, bergamot, rev(ja-en pack))`, then `(enText, en, de, bergamot, rev(en-de pack))`. Updating only the `en-de` pack invalidates only the second hop. A direct model (Hy-MT2 `ja→de`) has its own key and never mixes with pivot entries.
- **Hash.** In memory: `Bun.hash` (64-bit wyhash) as the `Map` key, with the stored normalised segment compared on hit to rule out collisions. For any on-disk index, use HMAC-SHA-256 with a keychain-held key so the index doesn't reveal content.

### Scope, size and expiry

- **Per-entry size** is about 0.5–1 KB (source and output as JS strings, metadata, map overhead; *estimate*). 16 MB holds roughly 16,000–30,000 segments, which is hours of dialogue or subtitles. The entry cap (20,000) keeps per-entry overhead bounded for very short UI strings.
- **No per-entry TTL in memory.** LRU handles size. Time limits are about privacy, not freshness, so they apply to the whole cache (idle wipe, lock, sleep). Correctness is handled by the key, not by expiry.
- **Live session caches** (detection, frame ring, bbox reuse) are bounded by the session and by the region's contents. They are dropped on stop, re-pin, or when the user changes the source-language subset (the decision class depends on it).

### Correctness

- **OCR jitter.** Over moving video, burned-in subtitles change pixels constantly, so OCR re-runs and may return `Wait for me!` on one frame and `Wait for rne!` on the next. Exact keys miss on the jittered frame. The answer in v1 is upstream: bbox-level pixel reuse where possible, and the GLIM-21 hysteresis for detection. Fuzzy *translation reuse* is rejected for now (below). After measuring with real captures, a narrowly gated rule can be considered: same bbox (IoU ≥ 0.9), edit distance 1, the new OCR confidence lower than the cached one, no digits involved. In that case keep showing the cached translation and don't re-translate.
- **Context-dependent translation.** Handled by `contextHash` for providers that use context. For sentence-level models it is a property of the model, not of the cache: the cache doesn't make things worse.
- **Invalidation.** Purely by key. Model and pack updates change `modelRev`, settings changes change `optionsHash`, normaliser or splitter changes bump their version. Old entries age out through LRU. On a model update event the cache also proactively drops entries for that `providerId`, to free memory and so stale entries can't be seen in a debug view.
- **Bad output stuck in the cache.** A hallucination (GLIM-85 saw NLLB turn `Einstellungen` into "The following is the list of the") would otherwise repeat for the whole session. "Retranslate" on a block bypasses and overwrites. LLM providers only write after the output validator passes.

## Privacy

Cached text is captured screen content, and possibly private chats, medical letters or work documents. The rules, stated plainly:

1. **Default: memory only.** Nothing from the cache touches disk in v1: no file, no SQLite, no webview `localStorage` or IndexedDB. The cache lives in the orchestrating Bun worker, not in the webview, so the renderer only ever holds what is on screen.
2. **Lifetime.** Wiped on: quit; **Clear translation cache** (tray and Settings, takes effect at once, also clears all session caches); screen lock and system sleep; 15 minutes with no Snip or Live activity (configurable 5 min to "until quit"). Changing or removing a cloud API key also drops that provider's entries.
3. **Private mode.** A **Private** toggle in the tray and on the Live popup (name open, see questions). When on:
   - The app-wide cache is neither read nor written.
   - A Live session gets its own isolated in-memory cache (it needs one to work, per 7.7). It is dropped when the session stops or Private is turned off.
   - Snip in Private mode caches nothing.
   - Disk persistence, if it ever exists, never applies.
   - The tray shows Private as an active state, like the cloud indicator.
4. **Cloud providers.** Cloud results are cached on the same terms as local results. That saves API cost and latency, and means fewer copies of the screen text are sent. A cached cloud result **keeps its cloud badge**, because that text did leave the machine when it was first translated. The cache **never sends anything to the network** by itself: no pre-fetching or warming. Because the provider id is in the key, switching to a local provider never shows a cloud-produced result as local.
5. **What we can't promise.** JavaScript strings can't be zeroed; a cleared entry stays in the heap until garbage collection. The OS can page process memory to swap or the hibernation file, and crash dumps can contain it. This is true of any app that shows the text at all, and caching only extends how long it lives. The Settings copy should say "cleared from Glimpse's memory", not "securely erased". Crash reporting (if it is ever added) must not attach heap contents.
6. **Future disk cache (not v1), if signed off later:**
   - Opt-in "Remember translations between restarts", **off by default**, with a one-line explanation that translated screen text will be stored on this device, encrypted.
   - **AES-256-GCM per record**, data key held in the OS keychain (the same keychain integration the shell spike already covers). Index by HMAC-SHA-256 of the cache key, so entries can't be found by hashing a guessed sentence without the keychain key.
   - Store in the app data directory (`bun:sqlite`), capped at **50 MB**, **TTL 30 days** since last use, LRU beyond the cap.
   - **Clear = crypto-shred**: delete the file *and* rotate the keychain key, so blocks the SSD keeps after deletion can't be decrypted.
   - Never written in Private mode. A setting to exclude cloud results (on by default, so the disk cache can't quietly accumulate what was sent to third parties) is an open question.

## Implementation sketch (TypeScript)

Where it sits:

```
capture → pixel diff/debounce
  → [frame-hash ring: hit → reuse OCR result]          (Live session)
  → PaddleOCR on changed bboxes only → blocks {text, bbox, ocrConf}
  → normalise → LID  [detection cache]                (Live session)
  → split into segments (Intl.Segmenter, sentence granularity)
  → router picks provider + route (direct or via en)
  → for each segment and hop: [translation cache] → misses batched to provider (single-flight)
  → write validated results → assemble blocks → popup (changed-source blocks highlighted)
```

Interfaces (illustrative, not final):

```ts
interface ProviderFingerprint {
  providerId: string;          // "bergamot" | "small100" | "hymt2" | "cloud:deepl" | …
  modelRev: string;            // sha256 of model files + runtime version, or the API's model id
  optionsHash: string;         // formality, glossary, decoding params, prompt version…
  contextSensitive: boolean;
  isCloud: boolean;
}

interface TranslationKey {
  text: string;                // normalised segment; exactly what the provider receives
  src: string; tgt: string;    // codes as sent to the provider
  fp: ProviderFingerprint;
  contextHash?: string;        // only when fp.contextSensitive
}

interface CachedTranslation {
  text: string;
  providerId: string;          // provenance, drives the cloud badge
  isCloud: boolean;
  createdAt: number;
}

interface TranslationCache {
  get(k: TranslationKey): CachedTranslation | undefined;
  set(k: TranslationKey, v: CachedTranslation): void;     // callers only pass validated, complete output
  getOrTranslate(k: TranslationKey, run: () => Promise<CachedTranslation>): Promise<CachedTranslation>; // single-flight
  dropProvider(providerId: string): void;
  clear(reason: "user" | "lock" | "sleep" | "idle" | "key-change"): void;
  stats(): { entries: number; bytes: number; hits: number; misses: number };
}

// One app-wide instance, plus one isolated instance per Private Live session.
function cacheFor(session: LiveSession | SnipRequest): TranslationCache;
```

Notes:

- **LRU**: a `Map` (insertion-ordered; delete and re-insert on hit) with a running byte count (`2 × string.length` plus a fixed overhead per entry). Under 100 lines; no dependency needed. Hash with `Bun.hash`.
- **Single-flight**: a `Map<keyHash, Promise>` of pending requests. Cancelled Live frames detach from the promise but don't cancel the shared request unless no one is still waiting for it.
- **Batching**: misses from one frame go to the provider as one batch (GLIM-85's `translate(blocks[], src, tgt)`). Hits are returned at once, so the popup fills progressively (Principle 2).
- **Stats**: hit and miss counters exposed in a debug panel, with no text, for measuring the estimates below.
- **Tests**: normaliser golden tests across scripts (CJK line joins, RTL control characters, NFKC compatibility forms); a key-sensitivity test that changing each fingerprint field misses; Private isolation test; "errors and cancellations are never written" test.

**Rust fallback.** Keep the cache in whichever process orchestrates the pipeline. With a **Rust sidecar** that only runs inference, the Bun cache above stays as it is and the sidecar is stateless (simplest, and one place to clear). With **Tauri** (Rust orchestrates), use [`moka`](https://github.com/moka-rs/moka) (size-weighted LRU/TinyLFU, async `get_with` gives single-flight) or `lru`, hash with `xxhash-rust` or `blake3`, and `unicode-normalization` for NFKC. The same normaliser must exist in only one place: if the stack splits, the side that sends text to the translator owns normalisation. For the future disk cache: `aes-gcm`, `hmac` + `sha2`, `keyring` for the keychain key, `zeroize` for key material (which, unlike JS strings, can be wiped).

## Expected hit rates and benefit (estimates, not measured)

**These are reasoned estimates with no measurement behind them.** They assume sentence-level keys, a context-free provider, and bbox-level OCR reuse. Validate with the stats counters during Live dogfooding.

| Live scenario | What repeats | Est. segment hit rate | Main effect |
|---|---|---|---|
| Chat pane / message thread | Every older message after a new one arrives or the view scrolls | 80–95% | Only the new message is translated |
| Game menus, HUD, settings screens | Labels when moving between screens | 85–95% | Near-instant revisits |
| Game dialogue box | Speaker names, repeated lines, re-OCR of the same line while the box animates | 30–60% | Saves on names and repeats; new lines always miss |
| Burned-in subtitles over video | Same line re-OCR'd while the video moves behind it | 50–80%, *very* sensitive to OCR jitter | Stops flicker and repeat translation; worst case for jitter |
| Snip (one-shot) | Re-snipping a similar area | 0–30% | Minor; mostly helps "snip again" |

Benefit per hit (*estimates*): Bergamot tens of ms per segment, doubled for pivot pairs. Hy-MT2 0.5–1.5 s per block, where the cache is the difference between usable and unusable in Live. Cloud: a network round trip (~200–800 ms) and a billed request each. Across all providers: identical output for identical input, and fewer wake-ups of the inference worker (battery, Hard Constraint "Local model cost").

## Rejected alternatives

- **No cache, rely on pixel diff alone.** The diff stops OCR on still frames, but any change in the region (one new chat line, video behind subtitles) re-translates everything in it. That fails 7.7 and makes LLM output flicker.
- **Block-level keys only.** Block grouping from OCR is unstable (lines merge and split as content scrolls) and one new sentence in a block misses the whole block. Segment-level keys are more robust and no more complex.
- **Fuzzy matching of translation keys** (edit distance, n-gram similarity, embeddings). A one-character OCR difference is often a real change (`1`/`7`, `not`/`now`, a negation, a name), and returning the wrong translation silently is worse than spending a few ms. Revisit only as the narrowly gated rule above, after measurement.
- **Perceptual image hashes for OCR reuse.** Similar images with different text (one character changed in a subtitle) can share a perceptual hash. Exact hashes plus bbox-level diffs are safe.
- **Disk cache by default, or unencrypted disk cache.** It puts captured screen content at rest without the user choosing it, and contradicts Principles 1 and 4. The speed gain across restarts is small for local models.
- **Caching in the webview** (IndexedDB, `localStorage`). It persists by default, is harder to clear reliably, and puts more text in the renderer than it needs.
- **Each provider keeps its own cache.** One shared cache with a provider fingerprint gives one Clear action, one Private rule, one size limit and one set of tests.
- **Only caching the final pivoted result** (`ja→de` as one entry). Loses hop reuse across targets and sources, and a pack update would invalidate more than needed.
- **TTL-based freshness** (for example, entries expire after an hour). Correctness comes from the key. Time limits are applied to the whole cache for privacy reasons instead.

## Risks

- **OCR jitter could make Live hit rates much lower than estimated** for subtitles over video, the case where users most want it. Mitigated by bbox reuse; the fallback is the gated fuzzy rule, which carries its own wrong-reuse risk.
- **Incomplete fingerprints give stale results.** If an option that affects output (a glossary entry, a prompt tweak, a runtime upgrade) is missing from `optionsHash` or `modelRev`, users see old translations until the cache is cleared. Mitigation: providers build their own fingerprint from their full config, plus a test that every setting changes the key.
- **Cloud models change silently.** Many APIs don't report a model version, so a cached result may come from an older model. Acceptable in memory over one run; this is one reason the disk cache is deferred.
- **Memory residue** (swap, hibernation, crash dumps) means "cleared" isn't "erased". Mitigated by honest wording, wipe on lock and sleep, and no heap contents in crash reports.
- **A bad translation sticks for the session.** Mitigated by validation before write (LLMs) and a visible Retranslate.
- **Context-aware providers get few hits.** If Enhanced (Hy-MT2) uses neighbouring lines as context, the cache helps it far less. That has to be weighed in Enhanced's own Live latency check (GLIM-85 open question 3).
- **The estimates are unmeasured** and come from reasoning about content, not data.

## Open questions

1. **Disk cache at all?** Ship v1 memory-only and add the encrypted opt-in only if users ask, or plan it for v1.x? If it ships, should cloud results be excluded from it by default?
2. **Private mode:** naming ("Private", "Don't remember"), whether it is global or per Live session, and whether it should also imply "local providers only" (cloud blocked while on).
3. **Wipe triggers:** confirm 15-minute idle, screen lock and sleep as defaults. Should a running Live session survive lock (keep its session cache) or restart cold?
4. **Sentence splitting:** is `Intl.Segmenter` (sentence granularity) in Bun good enough for game and chat text with little punctuation, or does it need rules for CJK and line-based subtitles? The splitter version is part of the key either way.
5. **Gated fuzzy reuse:** collect hit and miss counts plus jittered pairs from dogfooding (counters only, no text unless the developer opts in on their own machine) before deciding.
6. **User language overrides:** if the user corrects a block's detected language, should that override be remembered for the run (app-wide detection entry), or only for the Live session?
7. **Limits:** are 16 MB / 20,000 entries right next to OCR and model memory on an 8 GB machine, or should the cap scale with free memory?

## Sources

1. GLIM-21 language-detection decision (rule 5a, hysteresis, detection copy): `docs/decisions/GLIM-21-language-detection.md`
2. GLIM-85 translation-model proposal (Bergamot English pivot, SHA-256 pack verification, sentence splitting, `translate(blocks[], src, tgt)`), branch `glim-85-translation-model`: `docs/decisions/GLIM-85-translation-model.md`
3. Bun hashing (`Bun.hash`, wyhash): https://bun.sh/docs/api/hashing · `bun:sqlite`: https://bun.sh/docs/api/sqlite
4. `Intl.Segmenter`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
5. Unicode normalisation forms (NFKC), UAX #15: https://unicode.org/reports/tr15/
6. Rust crates: https://github.com/moka-rs/moka · https://crates.io/crates/lru · https://crates.io/crates/aes-gcm · https://crates.io/crates/keyring · https://crates.io/crates/zeroize · https://crates.io/crates/unicode-normalization
7. Mozilla translations model registry (per-file hashes used for `modelRev`): https://github.com/mozilla/translations
