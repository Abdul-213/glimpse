# GLIM-18 spike: Keychain / Credential Manager, findings

Status: built and tested on headless Linux only (Bun 1.4.4, Electrobun 2.0.5). **Not yet run on Windows or macOS.** The user runs [TESTING.md](TESTING.md) on real machines, and its results table takes precedence over the predictions here.

**Short answer:** use **`Bun.secrets`**, which is built into Bun. It already calls `SecItem*` on macOS and `CredWriteW/CredReadW/CredDeleteW` on Windows from Bun's own native code. Glimpse needs no FFI, no N-API addon and no sidecar. It works from Electrobun's Bun main process, which runs app code in a Worker. On macOS the process that calls the Keychain is the bundled **Oven-signed `bun`** binary. As a result, unsigned Glimpse rebuilds and updates should **not** re-prompt. The flip side is that the item's ACL trusts "any `bun` signed by Oven", not "Glimpse".

## 1. Options compared

| Option | Native code to ship | macOS | Windows | Works inside Electrobun | Verdict |
|---|---|---|---|---|---|
| **`Bun.secrets`** (Bun ≥ 1.2.21, "experimental") | None. Part of the Bun runtime the app already ships. | `SecItemAdd`/`CopyMatching`/`Update`/`Delete`, generic password, **file-based login keychain** (no `kSecUseDataProtectionKeychain`). Security.framework loaded with `dlopen`. | `CredWriteW`/`CredReadW`/`CredDeleteW`, `CRED_TYPE_GENERIC`, TargetName `service/name`, blob = UTF-8 bytes. Default `CRED_PERSIST_ENTERPRISE`, `persist: "local"` available. | Yes. It's a Bun global, runs on Bun's thread pool, needs no main-thread dispatch. Verified from a `Worker` here. | **Chosen** |
| `@napi-rs/keyring` 2.1.2 (keyring-rs via N-API) | One prebuilt `.node` per OS/arch (3 MB on linux-x64), shipped in the bundle. | keyring-rs Apple store (file-based keychain via `security-framework`) | Credential Manager | Probably. It loads and round-trips under Bun here. | Good fallback. Gotcha: on Linux it **silently falls back to the in-memory kernel keyutils store** when no Secret Service is running, unless you pass `{ linux: { store: "secret-service" } }`. |
| `keytar` 7.9.0 | node-gyp/prebuild `.node` | legacy SecKeychain API | Credential Manager | Untested | **Rejected.** The repo (atom/node-keytar) has been archived and unmaintained since Dec 2022. |
| Own `bun:ffi` (Windows) / small C dylib + `bun:ffi` (macOS), the GLIM-14 pattern | About 150 lines of C for macOS (CFDictionary plumbing). Windows needs only `bun:ffi` against `advapi32.dll`. | Full control: `kSecAttrLabel`, custom `SecAccess`, could try the data-protection keychain (but see §4) | Full control: `Comment`, `Attributes`, persist | Yes. No main-thread requirement, so no dispatch is needed. | Only if `Bun.secrets` falls short (labels, partition lists). A dylib loaded into `bun` still has `bun`'s code identity, so it changes nothing about prompts. |
| Rust sidecar (`keyring` crate) | A separate executable per OS/arch | Same API family | Same | Via IPC | Worst choice on unsigned macOS builds. The sidecar is ad-hoc signed, so its cdhash changes **every release** and the Keychain re-prompts after each update (§4, M9/M10). |

`Bun.secrets` quirks the Glimpse wrapper (`src/shared/secret-store.ts`) handles:

- `set({ value: "" })` **deletes** the item, on every OS. The wrapper rejects empty values, so a cleared text field can't wipe a key by accident.
- Windows defaults to `CRED_PERSIST_ENTERPRISE`, which roams with domain roaming profiles. The wrapper passes `persist: "local"`, because an API key is per device.
- No item label or comment. Keychain Access shows the service (`dev.glimpse.app`) as the item name, and Credential Manager shows `dev.glimpse.app/<account>`. That's acceptable.
- `allowUnrestrictedAccess: true` (macOS) creates an "any app" ACL. Never use it.
- It is marked experimental in the docs. The API is three functions, so Glimpse's wrapper is the only place that would need to change.

Source read: Bun `bun-v1.4.4` [`SecretsDarwin.cpp`](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/bindings/SecretsDarwin.cpp), [`SecretsWindows.cpp`](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/bindings/SecretsWindows.cpp), [`SecretsLinux.cpp`](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/bindings/SecretsLinux.cpp), [`JSSecrets.cpp`](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/bindings/JSSecrets.cpp) (error-code mapping), and [docs/runtime/secrets.mdx](https://github.com/oven-sh/bun/blob/bun-v1.4.4/docs/runtime/secrets.mdx).

## 2. Chosen approach

- Use `Bun.secrets` behind a small `ApiKeyStore` wrapper: service **`dev.glimpse.app`**, account = provider id (`openai`, `deepl`, …, matching `^[a-z0-9][a-z0-9._-]{0,63}$`).
- **Never log the secret.** Values never go into errors, logs or `toString`. As defence in depth, the wrapper also scrubs the value from any OS message (`scrub()`; tested). The UI shows at most `…last4 (N bytes)` (`mask()`). Bun's own error messages are OS strings plus a code and never contain the value (checked in source).
- **Size:** the cap is 2560 UTF-8 bytes everywhere. That is Windows `CRED_MAX_CREDENTIAL_BLOB_SIZE` (5 × 512), so a key that fits on one OS fits on the other. Real API keys are 30–200 bytes.
- **Errors** map to `locked | canceled | denied | unavailable | too-large | invalid | unknown`, each with a user-facing message (`SecretStoreError.userMessage`). The detail keeps the Bun code (`ERR_SECRETS_*`) and the OS code (OSStatus / Win32 / GError) for logs.
- **Migration if the service name changes:** `ApiKeyStore.migrateFrom(oldService, accounts)` copies the item, reads it back and compares, then deletes the old one. It is safe to re-run. If both exist and differ, the new item wins and the old is left alone. A failure (for example a cancelled prompt) is reported per account and never thrown, so the app keeps the old item and retries on the next launch. On macOS, reading an old item that a *different* binary created can prompt once (§4).
- **No keychain = no cloud keys.** If the store is `unavailable`, Glimpse says so and the cloud providers stay disabled. It never falls back to a plaintext file (PRODUCT.md: keys only in the OS keychain).

## 3. Verified here (headless Linux x64) vs not

Verified:

- `Bun.secrets` exists in Bun 1.4.4 with `get/set/delete`. With no Secret Service it throws `ERR_SECRETS_PLATFORM_ERROR "libsecret not available"`, which the wrapper maps to `unavailable` with the UI message "No system password store is available…".
- Ran the full round trip (write → read → update with non-ASCII → read → delete → read null → delete false → empty value rejected) against **real libsecret + gnome-keyring 46**. These ran in a private dbus session with a throwaway keyring, using packages unpacked without root (`scripts/linux-headless-keyring.sh`). All passed: from the CLI, from **inside a Bun `Worker`** (as Electrobun runs app code), and with the **bundled `bun` from the Electrobun build**.
- `bun test` results: **23/23 pass** under the headless keyring. Without it, 15 pass and 8 skip with a clear `[SKIP]` message. The unit tests cover validation, error mapping for macOS/Windows/Linux codes, scrubbing, masking and migration conflicts. The integration tests cover the round trip, the Worker case, migration, the size cap, the raw size probe and account independence.
- Migration probe passes: moved, verified, re-run is a no-op.
- Linux libsecret has no small size limit: 65,536 bytes round-tripped. The 2560-byte cap is the wrapper's choice.
- `@napi-rs/keyring` 2.1.2 loads under Bun and round-trips against the same Secret Service. Its Linux items and `Bun.secrets` items do not see each other (different schema/attributes).
- `bun --bun run prepare:devkit`, `typecheck` (TS 5.9) and `build` succeed. The built bundle's `bin/bun` is **byte-identical** to the official Bun 1.4.4 release (sha256 `107022…ac235`). Hutch copies the toolchain `bun` unmodified, and it doesn't change when app JS changes.
- **Signature of the official macOS `bun` (1.4.4, arm64)**, parsed from the Mach-O on this machine. It is Developer ID-signed (CMS blob present, not ad-hoc), hardened runtime, identifier `bun`, team **`7FRXF46ZSN`**. Its designated requirement blob is `identifier "bun" and anchor apple generic and certificate 1[Developer ID CA] and certificate leaf[Developer ID Application] and certificate leaf[subject.OU] = "7FRXF46ZSN"`. Entitlements include `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` and `allow-dyld-environment-variables`.
- `bun build --compile --target=bun-darwin-arm64`, cross-compiled here: the output is **ad-hoc, linker-signed**, identifier `a.out`, no team and no requirements blob, so its designated requirement is its cdhash. Two builds differing only in a build id had different cdhashes (`a1b6a4b0…` vs `27b4c6f6…`).

Not verified (needs the real OSes):

- Anything on macOS or Windows. Keychain prompts, Keychain Access / Credential Manager views, locked keychain, logon sessions and the Windows size-limit error code.
- That Hutch's **macOS** build also copies `bun` unmodified (M4). The Linux evidence and Electrobun's code-signing guide ("Dev builds skip Hutch's signing… Editing JavaScript or TypeScript alone usually leaves the runtime executable unchanged") point that way.
- Running the GUI at all. There's no display or WebKitGTK here.

## 4. macOS: unsigned-build prompt behaviour

How it works (sources below):

- `Bun.secrets` writes to the **file-based login keychain**. This keychain uses per-item **ACLs** (SecAccess). When `SecItemAdd` runs without an explicit access object, the **creating application is the trusted app**, recorded as its *designated requirement* (DR). A trusted app reads silently. Any other app gets the **"<name> wants to use your confidential information stored in "dev.glimpse.app" in your keychain"** dialog with **Always Allow / Deny / Allow** and the login password. "Always Allow" adds that caller's DR to the ACL.
- For **ad-hoc-signed or unsigned** code, the DR is the **cdhash** (TN3127; Electrobun's code-signing guide says the same). Any rebuild that changes the binary is a "different app", so the prompt comes back after every rebuild or update, and each "Always Allow" piles up another ACL entry.
- **The data-protection keychain is not an option for unsigned Glimpse.** Access to it is granted via keychain-access-group entitlements that "must be authorized by a provisioning profile" (TN3137). That requires an Apple Developer team. Without it, the call fails with `errSecMissingEntitlement` (-34018), which the wrapper maps to `denied`. TN3137 also notes that the file-based keychain is "on the road to deprecation" but not deprecated. `Bun.secrets` doesn't set `kSecUseDataProtectionKeychain` anyway.

What that means for an Electrobun Glimpse:

- The Keychain caller is **`<App>.app/Contents/MacOS/bun`**, which the launcher spawns (`package/src/launcher/main.zig`). It is not the launcher and not Glimpse's JS. That binary is Oven's **Developer ID-signed** `bun`, and it is identical across Glimpse rebuilds. Its DR is team-based, not cdhash-based, so it also holds across Bun upgrades.
- **Prediction: no prompt** for Glimpse's own reads and writes. That covers first use, rebuilds, Glimpse updates and Bun/Electrobun upgrades (TESTING M3, M6). In practice, unsigned Glimpse gets the prompt-free experience a signed app would.
- **The cost (threat model):** the ACL says "trust Oven's `bun`", so **any** Oven-signed `bun` (your `~/.bun/bin/bun`, another Electrobun app) running *any script* can read Glimpse's keys **without a prompt** (prediction, M7). Bun's entitlements also allow `DYLD_INSERT_LIBRARIES` and unsigned libraries, so even a stricter ACL wouldn't stop a same-user attacker from getting code into a trusted `bun`. Honest summary: on macOS, as on Windows, the keychain protects keys **at rest and from other users / offline disk access, not from malware running as the same user**. Non-`bun` tools (for example `security`, a Python script) do get the prompt (M8).
- **Prompts would appear** only when the caller's identity differs from the creator's:
  1. **Glimpse's own native code calling the Keychain from its own process** (a Rust sidecar, or a native main process), unsigned. It re-prompts **on every update** (M9–M11). This is a concrete reason **not** to move keychain access into a sidecar. A dylib loaded into `bun` via `bun:ffi` does **not** have this problem: the process identity stays `bun`.
  2. **If Glimpse later gets Developer-ID signed**, Hutch re-signs `bun` with Glimpse's team, so the DR changes once. Existing items prompt **once** per item after that update. "Always Allow" fixes it permanently, or a one-time `migrateFrom` copy creates fresh items owned by the new identity, though reading the old item still prompts once.
  3. **If M4 shows Hutch ad-hoc re-signs `bun`** on macOS builds, the DR becomes the cdhash of `bun`. JS-only rebuilds still won't prompt (the binary is unchanged), but every Bun/Electrobun version bump will. That would make macOS **partial**.
- The dialog names the calling executable. For case 1 that's the sidecar's file name. For Glimpse's own path it would say "bun", which is a branding wart, but per the prediction it shouldn't appear in normal use.

**Locked or unavailable keychain (macOS):** the login keychain unlocks at login, and modern macOS doesn't auto-lock it by default. If it is locked and the app is in a GUI session, the read makes the OS show the "enter the login keychain password" dialog. The JS promise stays pending until the user answers (Bun runs this on its thread pool, so nothing blocks). Cancel gives `-128` → `canceled`, and a wrong password gives `-25293` → `denied`. Without UI (ssh, launchd) the read fails fast with `-25308 errSecInteractionNotAllowed` → `locked` ("Your keychain is locked…"). Bun maps these to `ERR_SECRETS_USER_CANCELED`, `ERR_SECRETS_AUTH_FAILED` and `ERR_SECRETS_INTERACTION_NOT_ALLOWED`.

## 5. Windows: Credential Manager

- **Item:** generic credential, TargetName `dev.glimpse.app/<account>`, UserName `<account>`, blob = UTF-8 bytes. It is visible in Control Panel → Credential Manager → Windows Credentials and in `cmdkey /list`, but the UI never shows the password.
- **Size:** `CredentialBlobSize` ≤ `CRED_MAX_CREDENTIAL_BLOB_SIZE` = 2560 bytes. The wrapper rejects anything larger first. The OS error for oversized blobs is recorded by W9 (`ERROR_INVALID_PARAMETER` 87 expected).
- **Threat model:** there is **no per-application ACL**. Any process running as the same user can `CredReadW` or `CredEnumerateW` it silently (W8 demonstrates this with PowerShell). DPAPI encrypts it at rest under the user's logon credentials, which protects against other non-admin users and offline disk access without the user's password. It does not protect against same-user malware or an administrator. This is the same model as every other Windows app that stores tokens (Git Credential Manager, VS Code, gh). No signing-related prompts exist, so unsigned builds behave exactly like signed ones.
- **Unavailable:** network logons without a credential set (OpenSSH with key auth, some services or scheduled tasks) fail with `ERROR_NO_SUCH_LOGON_SESSION` (1312) → `unavailable` (W11). Credential Manager has no "locked" state while the user is logged in (W12).
- **Roaming:** Bun defaults to `CRED_PERSIST_ENTERPRISE` (roams with roaming profiles). The wrapper uses `persist: "local"` (W5 should show "Local computer").

## 6. Expected result per OS

| OS | Expected | Why / risk |
|---|---|---|
| **Windows** | **Pass** | Plain Credential Manager with no signing dependency. Round trip, rebuild and compiled binary all read silently. The size limit is known and pre-checked. The "other processes can read it" finding is inherent to Credential Manager, documented, and doesn't fail the spike. Risk: the exact error code for oversized blobs (W9), which is cosmetic. |
| **macOS** | **Pass, possibly partial** | Prediction: no prompts at all for Glimpse's own path, because the caller is Oven-signed `bun` (M3, M6), and correct `locked`/`canceled` handling (M12–M14). *Partial* if M4 shows `bun` is re-signed ad-hoc in the bundle (re-prompt on every Bun/Electrobun bump), or if M7 shows a prompt *and* M6 also prompts. Either way the fix is signing, not native code. The weak per-app isolation (M7) is a documented property, not a failure. |
| Linux (not a target) | Pass (verified) | libsecret + gnome-keyring, headless. |

**Impact on the shell decision:** keychain access is **not** a reason to need a Rust sidecar or Tauri. On unsigned macOS builds, moving keychain access into a separate native binary would make prompts *worse* (§4, case 1).

## Sources

- Bun source and docs at `bun-v1.4.4` (links in §1). Bun CI keyring setup: [test/js/bun/secrets-ci-setup.md](https://github.com/oven-sh/bun/blob/bun-v1.4.4/test/js/bun/secrets-ci-setup.md).
- Apple, [TN3137: On Mac keychain APIs and implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains): the file-based keychain uses ACLs, data-protection access groups come from entitlements "authorized by a provisioning profile", and the file-based keychain is "on the road to deprecation".
- Apple, [TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements): a `cdhash` requirement "is satisfied only by code with a specific cdhash value", and unexpected keychain alerts happen when the signing channel changes.
- Electrobun 2.0.5 (`d06abc9`), [docs/…/guides/code-signing.mdx](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/docs/src/content/docs/electrobun/guides/code-signing.mdx), section "Dev Builds And Keychain Access": ad-hoc DR = cdhash, rebuilds may prompt again, and JS-only edits leave the runtime executable unchanged. Launcher process model: [package/src/launcher/main.zig](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/launcher/main.zig) (spawns `Contents/MacOS/bun Resources/main.js`).
- Microsoft, [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) (`CRED_MAX_CREDENTIAL_BLOB_SIZE`, persist values) and [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) (`ERROR_NO_SUCH_LOGON_SESSION`: network logon sessions have no credential set).
- `@napi-rs/keyring` 2.1.2 README (Linux keyutils fallback). keytar: [atom/node-keytar](https://github.com/atom/node-keytar), archived.
