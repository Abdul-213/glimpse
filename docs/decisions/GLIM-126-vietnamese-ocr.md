# GLIM-126: Vietnamese on-device OCR

Status: decided (2026-11-02). Vietnamese stays readable on the device, marked **partial**, and
the UI points to cloud OCR for it. Revisit when PaddleOCR/RapidOCR ship a recogniser whose
dictionary has the Vietnamese letters.

## Problem

The GLIM-64 benchmark reads `latin-vi-notice` ("Bạn có muốn cài đặt bản cập nhật mới nhất cho
ứng dụng này ngay bây giờ không?") as "Ban có muôn cài dt bn cp nhât mói nhât cho úng / dung này
ngay bây giò không?": CER 19.7 %, WER 61 %. Acute, grave and circumflex survive. Dot-below, hook
and horn letters (ạ ả ặ ậ ơ ư ...) are dropped or replaced. That is too lossy to translate well.

## Why: the recognisers can't emit the letters

A CTC recogniser can only output characters in its dictionary. These are counts of the 52
lowercase Vietnamese letters that carry a tone or vowel mark beyond plain Latin-1 (ạ…ỹ, đ, ơ, ư,
ă, â, ê, ô), in each dictionary:

| Recogniser (RapidOCR v3.10.0 ONNX) | Dictionary size | Vietnamese letters present |
|---|---|---|
| PP-OCRv5 `latin` (what we use for vi) | 503 | 1 / 52 |
| PP-OCRv5 `ch`, `en`, `eslav`, `cyrillic`, `korean`, `arabic`, ... | 355–18384 | 0–2 / 52 |
| PP-OCRv6 `rec_tiny` (multilingual, lists `vi`) | 6905 | 6 / 52 |
| PP-OCRv6 `rec_small` / `rec_medium` (multilingual, lists `vi`) | 18709 | 8 / 52 |

PaddleOCR documents Vietnamese as covered by the `latin` model (and RapidOCR lists `vi` in the
PP-OCRv6 routes), but neither dictionary can spell it. The benchmark agrees: on
`latin-vi-notice`, PP-OCRv6 tiny reads "Ban có muön cài dăt bán câp nhât…" (CER 19.7 %), and
PP-OCRv6 small drops the marked letters altogether: "Bn có mun cài đt bn cp nht…" (CER 18.0 %).
Swapping models gains nothing.

Outside PaddleOCR, [VietOCR](https://github.com/pbcquoc/vietocr) reads Vietnamese well, but it
is a different architecture:
- It has a CNN plus transformer or seq2seq decoder with autoregressive decoding, so it would need a new decoder loop in the engine, not a manifest entry.
- There is no official ONNX export, only community three-graph exports.
- Its weights are hosted on vocr.vn with no stated licence.

That is a new OCR engine, out of scope for a model swap.

## Decision

- `localOcrIsPartial(code)` in `@glimpse/core` (`language/ocr.ts`) lists the languages local OCR reads only partly. Today that is just `vi`.
- PaddleOCR's `languageSupport("vi")` is `{ status: "ready", partial: true }`. Vietnamese is still read, still recognised by the script, and still translatable.
- Settings › Languages notes Vietnamese as "Tone marks often lost on this computer" (`SourceLanguageChoice.localOcrPartial`).
- When a Snip read on the device has Vietnamese blocks to translate, the popup shows "Vietnamese tone marks are often lost when text is read on this device." with "Use cloud OCR…", which opens Settings › Providers. Google Cloud Vision reads Vietnamese fully. The note isn't shown when cloud OCR did the reading or the Vietnamese blocks were skipped.

## Revisit if

- A PaddleOCR / RapidOCR release ships a recogniser whose dictionary has the Vietnamese letters. Count the letters as in the table above, add it to `app/models/manifest.json` as an on-demand entry, route `vi` to it in `recognizersFor`, and the benchmark case must reach CER under 5 %.
- A permissively licensed Vietnamese recogniser with an ONNX export appears that fits the CTC engine.
