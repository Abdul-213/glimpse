// Import first in any test that renders components: gives the test file a happy-dom
// window, document and the DOM globals Solid and Kobalte expect.
//
// Bun runs every test file in one global scope and evaluates this module once, so the DOM
// stays registered for every later file. happy-dom also replaces Bun's networking classes,
// and Bun.serve rejects a happy-dom Response (GLIM-147, model-download tests on Windows and
// macOS), so Bun's own are put back: components don't need happy-dom's.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const BUN_NETWORKING = [
	"fetch",
	"Request",
	"Response",
	"Headers",
	"FormData",
	"Blob",
	"File",
	"AbortController",
	"AbortSignal",
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"URL",
	"URLSearchParams",
	"WebSocket",
] as const;

if (typeof globalThis.document === "undefined") {
	const g = globalThis as Record<string, unknown>;
	const native = new Map(BUN_NETWORKING.map((name) => [name, g[name]]));
	GlobalRegistrator.register({ url: "http://localhost/", width: 800, height: 600 });
	for (const [name, value] of native) g[name] = value;
}
