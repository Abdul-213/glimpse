// fasttext.wasm.js 1.0 types its main entry only. fasttext.ts imports the WASM loader directly
// (not the main entry, which also wires up the package's own bundled copy of the model).
declare module "fasttext.wasm.js/dist/helpers/modules/node.mjs" {
	export function getFastTextModule(options?: { wasmPath?: string }): Promise<unknown>;
}
