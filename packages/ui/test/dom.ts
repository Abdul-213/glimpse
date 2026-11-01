// Import first in any test that renders components: gives the test file a happy-dom
// window, document and the DOM globals Solid and Kobalte expect.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
	GlobalRegistrator.register({ url: "http://localhost/", width: 800, height: 600 });
}
