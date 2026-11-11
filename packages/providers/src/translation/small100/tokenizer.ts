// SMaLL-100's tokenizer in TypeScript (GLIM-100). SMaLL-100 ships M2M-100's SentencePiece BPE
// model and vocab byte for byte (same sentencepiece.bpe.model and vocab.json SHA-256s), so the
// `tokenizer.json` Hugging Face generated for M2M-100 (Xenova/m2m100_418M) encodes it exactly.
// @huggingface/tokenizers runs it in plain JS: SentencePiece normalisation (NFKC + the ▁ space
// marker), BPE merges, and the 100 `__xx__` language tokens as added tokens.
//
// What differs from M2M-100 is only where the language token goes (decode.ts `encoderIds`).
import { Tokenizer } from "@huggingface/tokenizers";

/** The added language tokens: `__ja__` -> id (M2M-100 codes, core `toM2m`). */
export function languageTokenIds(tokenizerJson: unknown): Map<string, number> {
	const added = (tokenizerJson as { added_tokens?: { id: number; content: string }[] }).added_tokens ?? [];
	const ids = new Map<string, number>();
	for (const t of added) {
		const m = /^__([a-z]{2,3})__$/.exec(t.content);
		if (m?.[1]) ids.set(m[1], t.id);
	}
	return ids;
}

export class Small100Tokenizer {
	readonly #tok: Tokenizer;
	readonly #langs: Map<string, number>;

	constructor(tokenizerJson: object, tokenizerConfig: object = {}) {
		this.#tok = new Tokenizer(tokenizerJson, tokenizerConfig);
		this.#langs = languageTokenIds(tokenizerJson);
	}

	/** Language token id for an M2M-100 code (`ja`), or undefined. */
	language(code: string): number | undefined {
		return this.#langs.get(code);
	}

	get languages(): string[] {
		return [...this.#langs.keys()];
	}

	/** Source pieces' ids, without the language token or </s>. */
	encode(text: string): number[] {
		return this.#tok.encode(text, { add_special_tokens: false }).ids;
	}

	decode(ids: readonly number[]): string {
		return this.#tok.decode([...ids], { skip_special_tokens: true }).trim();
	}
}
