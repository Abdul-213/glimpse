// Dev-only gallery (GLIM-42, GLIM-51): every shared component and the font/RTL matrix,
// rendered in a plain browser without the desktop shell. Not shipped in canary/stable
// builds (scripts/build-views.ts DEV_ONLY_VIEWS). No RPC: it only renders specimens.
import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import { Gallery } from "./Gallery.tsx";
import { parseGalleryParams } from "./params.ts";

const params = parseGalleryParams(location.search);
const html = document.documentElement;
applyPlatform(params.os, { material: params.material, ...(params.osVersion ? { osVersion: params.osVersion } : {}) });
html.dir = params.dir;

const root = document.getElementById("root");
if (!root) throw new Error("gallery: #root missing from index.html");
render(() => <Gallery params={params} />, root);
