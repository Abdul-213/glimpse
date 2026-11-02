# GLIM-89: OCR inference on Intel Macs

Status: decided (2026-11-02). Unverified on a real Intel Mac (see "Verification").

## Problem

PaddleOCR runs on onnxruntime-node (GLIM-17, GLIM-46, GLIM-103). From 1.24 on, onnxruntime-node
and ONNX Runtime's GitHub releases ship no darwin-x64 (Intel Mac) build. We use 1.31.1, so an
Intel Mac build had no OCR backend: the build went through with a warning, and PaddleOCR's
`init()` ended in `error` at runtime.

## Options

| | Speed | Work | Risk |
|---|---|---|---|
| **A. Pin onnxruntime-node 1.23.2 for darwin-x64** (the last Intel build) | Native, same as other targets | Build-time switch: a second copy, darwin-x64 only | An older ORT on one target |
| B. onnxruntime-web (WASM) in the OCR Worker on darwin-x64 | ~2x slower (GLIM-17: 1.57 s → 0.68 s with 4 threads, still about 2x node) | A second Worker backend (model bytes instead of paths, wasm assets, thread setup), a new dependency for every target | WASM threads under Bun on macOS are unverified |
| C. Build ORT from source in CI | Native | A macOS CMake build of ORT + the N-API binding per release | Hours of CI on 10x-billed macOS minutes; we would maintain the build |

**Compatibility of A.** 1.23.2's native binding can't be used under the 1.31.1 JavaScript. The
binding contract changed in 1.24: `initOrtOnce(logLevel, Tensor)` became
`initOrtOnce(logLevel, Tensor, isMainThread)`, and `InferenceSession.loadModel` became async
(`OnnxruntimeSessionHandler.create`). Option A therefore bundles 1.23.2 **as a whole**: its
`dist/` JS, its own `onnxruntime-common` 1.23.2, and its `bin/napi-v6/darwin/x64` binding +
`libonnxruntime.1.23.2.dylib`. The public API the OCR Worker uses is the same in 1.23.2:
`InferenceSession.create(path, { intraOpNumThreads, interOpNumThreads, enableCpuMemArena,
enableMemPattern, graphOptimizationLevel })`, `new Tensor("float32", data, dims)` and
`session.run`. The `require(\`../bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node\`)`
text that `build-workers.ts` rewrites is identical in both versions.

## Decision

**A.** Intel Macs get native speed with the same Worker code. The extra copy affects only
darwin-x64 builds. B stays the fallback if 1.23.2 ever stops loading on a supported macOS.

How it works (`app/scripts/onnxruntime-legacy.ts`):

- `ortPackageFor(target)` is the build-time switch. darwin-x64 gets `legacy` (1.23.2); every
  other target gets the npm dependency. The target is the host, or `GLIMPSE_ORT_TARGET`.
- It is **not** an npm dependency. That would add ~250 MB to every install for one target. The
  preBuild hook fetches the two tarballs from registry.npmjs.org and checks them against the
  pinned npm `sha512` integrity (a mismatch fails the build). It extracts only `package.json`,
  `dist/` and `bin/napi-v6/darwin/x64` (~40 MB) into `~/.cache/glimpse/onnxruntime-node-1.23.2/`
  (`GLIMPSE_ORT_LEGACY_DIR` overrides this, e.g. for offline builds with a prepared cache).
- `build-workers.ts` bundles the OCR Worker with `onnxruntime-node` resolved from that folder
  (`ortPackagePlugin`); its `onnxruntime-common` 1.23.2 resolves next to it.
- `onnxruntime.ts` stages `onnxruntime_binding.node` + `libonnxruntime.1.23.2.dylib` (the binding
  links `@rpath/libonnxruntime.1.23.2.dylib`) into `native/onnxruntime/`, as on other targets.
- Release builds (`stable`) fail if the download fails. Dev builds warn and build without local
  OCR, as before.
- Running from source on an Intel Mac (`bun app/src/bun/index.ts` without a build) still uses
  1.31.1 from node_modules and has no OCR. Build once, or point `GLIMPSE_OCR_WORKER` at a built
  `ocr-worker.js`.

## Verification

- Linux (`app/test/ort-legacy.test.ts`): the target switch, integrity checks, cache preparation
  over fake tarballs, and the OCR Worker's plugin set. With `GLIMPSE_ORT_LEGACY_TEST=1` it also
  fetches and verifies the real tarballs, bundles the Worker against 1.23.2 (the bundle has
  1.23.2 and not 1.31.1, and the binding require is rewritten), and stages the darwin-x64 files.
- Linux, manual: the Worker bundled against 1.23.2, with 1.23.2's **linux-x64** binding from the
  same tarball, read all four strings of the OCR smoke fixture (1.2 s). This checks the 1.23.2 JS
  together with our Worker and engine; only the darwin binary itself is left.
- **Intel runner, passed** (2026-11-02, run 41385714016, a temporary workflow on `macos-15-intel`:
  x86_64, macOS 15.7.9). Steps: the legacy tests with the real tarballs; the OCR Worker bundled
  against 1.23.2; the darwin-x64 files and the models staged; `bundle-smoke.ts`. The bundled
  Worker read all four fixture strings, with `onnxruntime_binding.node` and
  `libonnxruntime.1.23.2.dylib` both loaded from the app folder (first call 7.0 s, cold, on the
  shared runner).
- Not done: a full `electrobun build` for darwin-x64 (Electrobun's Intel Mac support is
  untested here), and a manual check on a real Intel Mac (steps in the ticket).

## CI

desktop.yml gets a `macos-intel` job (`macos-15-intel` runner, x86_64 libglimpse, stable build,
bundle smoke test, unsigned zip). It runs only on `workflow_dispatch` and when release.yml calls
the workflow, never on pushes, because macOS minutes are billed 10x.

## Revisit if

- A macOS release no longer runs 1.23.2's x86_64 binary, or Bun
  changes N-API in a way that breaks it: switch darwin-x64 to option B.
- onnxruntime publishes darwin-x64 again: drop the pin.
