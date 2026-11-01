// `bun test` preload (bunfig.toml): provider tests load onnxruntime-node straight from
// node_modules, not through the app's OCR spawner, so switch ORT's telemetry off for the whole
// test process here (GLIM-112). CI runners are covered anyway: ORT skips telemetry when CI is set.
import { disableOrtTelemetry } from "../src/bun/services/ocr/ort-telemetry.ts";

disableOrtTelemetry();
