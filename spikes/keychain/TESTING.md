# GLIM-18 spike: Keychain / Credential Manager, test plan

Throwaway spike. It answers one question: can an Electrobun app store, read, update and delete a cloud API key in the OS secret store on Windows and macOS, with acceptable prompts on **unsigned** builds? Background, sources and predictions are in [FINDINGS.md](FINDINGS.md).

What is under test:

- **Backend:** `Bun.secrets`, built into Bun. It uses Keychain Services on macOS and Credential Manager on Windows. The spike adds no native code.
- **Wrapper:** `src/shared/secret-store.ts`. It uses service `dev.glimpse.app` with one account per provider, never logs values, rejects empty values (Bun would treat `""` as a delete), caps values at 2560 bytes, and maps errors to `locked / canceled / denied / unavailable / too-large / invalid / unknown`.
- **Electrobun app** (`src/bun/index.ts`). On launch it shows its identity (`execPath`, the binary the OS sees), reads the persisted marker, and runs the round trip. Every other probe is in the tray / menu-bar menu, titled **Keychain**. Results go to the window, the terminal and a log file (`~/glimpse-keychain-spike.log`, `%USERPROFILE%\glimpse-keychain-spike.log` on Windows).
- **CLI** (`src/cli.ts`) runs the same probes without a window: `info | roundtrip | write-marker | read-marker | delete-marker | size-probe | migrate | set <acct> (stdin) | check <acct> | delete <acct>`.
- **Compiled CLI** (`bun run compile` → `dist/glimpse-keychain-cli[.exe]`). This is a standalone binary whose hash changes on every build. It stands in for "Glimpse's own native code that changes every release", such as a Rust sidecar.

Secret values are never printed. To compare values across processes, use `fp=` (the first 12 hex characters of the SHA-256 of the random **test marker**).

---

## Build and run: Windows

Prerequisites: Windows 10/11, the WebView2 Runtime (preinstalled on 11), Git, and Bun 1.4.x (`powershell -c "irm bun.sh/install.ps1 | iex"`, then open a new terminal).

```powershell
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse
git checkout glim-18-keychain-spike
cd spikes\keychain
bun install
bun --bun run prepare:devkit     # downloads Hutch + Electrobun 2.0.5 into %USERPROFILE%\.hutch
bun --bun run typecheck
bun test                         # 23 tests; os-store tests must RUN here, not skip
bun src\cli.ts roundtrip         # CLI round trip
bun --bun run dev                # builds build\dev-win-*\ and launches with logs in this terminal
```

`bun --bun run build` only builds. The built app is under `build\dev-win-x64\` (search that folder for `*.exe`).

## Build and run: macOS

Prerequisites: macOS 14 or later, Apple Silicon or Intel, and Bun 1.4.x (`curl -fsSL https://bun.sh/install | bash`). Xcode is not needed.

```bash
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse && git checkout glim-18-keychain-spike
cd spikes/keychain
bun install
bun --bun run prepare:devkit
bun --bun run typecheck
bun test
bun src/cli.ts roundtrip
bun --bun run build
ls build/dev-macos-*/            # note the .app name
open build/dev-macos-*/*.app     # launch like a real app (not from Terminal, see below)
```

> **Launch with `open` or from Finder** for the prompt tests, so the app's own `Contents/MacOS/bun` calls the Keychain. `bun --bun run dev` also works and shows logs, and the Keychain caller is still the bundled `bun`, but run M3 to M6 with `open` at least once.

## Headless Linux (automated test only, no GUI)

```bash
bun test                                  # os-store + napi tests SKIP with a message if no Secret Service
bun run test:linux-headless               # private dbus + throwaway gnome-keyring; skips are failures here
bash scripts/linux-headless-keyring.sh --fetch bun test test/   # no root: unpacks gnome-keyring/libsecret debs into .keyring-prefix/
```

---

## Manual checklist: Windows

| # | Do | Expected |
|---|---|---|
| W1 | `bun test` | 23 pass, 0 skip, 0 fail. The size-probe lines show `2560 ok` and `2561 FAIL`. Note the error text and code for 2561. |
| W2 | `bun src\cli.ts roundtrip` | 9 PASS lines, exit code 0. No prompt of any kind. |
| W3 | `bun --bun run dev`. Look at the window. | The identity shows `execPath=…\build\dev-win-…\bin\bun.exe`. `read marker (launch)` says `NOT FOUND` on the first run. `round trip (launch)` passes. |
| W4 | Tray → **Write marker**. Note `fp=`. | PASS. |
| W5 | Control Panel → **Credential Manager** → **Windows Credentials** → Generic Credentials. Also run `cmdkey /list:dev.glimpse.app*`. | The entry `dev.glimpse.app/spike-marker` shows user name `spike-marker` and Persistence **Local computer** (the wrapper passes `persist: "local"`). The UI does not show the password. |
| W6 | Quit, run `bun --bun run build`, then `bun --bun run dev` again. Optionally delete `build\` first. | `read marker (launch)` shows the **same fp**, with no prompt. |
| W7 | `bun run compile`, then `dist\glimpse-keychain-cli.exe read-marker`. Run `bun run compile` again and repeat. | Both builds print the same fp, with no prompt. |
| W8 | Threat model: `powershell -ExecutionPolicy Bypass -File tools\read-cred.ps1`, then `bun tools\foreign-read.ts`. | **Both print the same fp silently.** Any process running as the same user can read it. Note `persist=2` (LOCAL_MACHINE) and `bytes`. |
| W9 | Tray → **Size probe** | `2560` PASS, `2561` FAIL. Note the error code and message, which the wrapper maps (`87` → invalid is expected). `4096` and `65536` FAIL. |
| W10 | Tray → **Service-rename migration probe** | 5 PASS lines. |
| W11 | Optional, "unavailable" case. Over OpenSSH with **key-based** login (`ssh you@localhost`), run `bun src\cli.ts roundtrip`. | FAIL with `unavailable … (code 1312)`, "A specified logon session does not exist". If you log in with a password, it may succeed instead. Note which. |
| W12 | Lock the workstation (Win+L), unlock, and run tray → **Read marker**. | PASS. Credential Manager has no separate lock. |
| W13 | Tray → **Delete marker**, then refresh Credential Manager. | `deleted=true`, and the entry is gone. |
| W14 | `findstr /c:"glim-marker-" /c:"glim-test-" %USERPROFILE%\glimpse-keychain-spike.log` | **No matches.** Only fingerprints are logged. |

## Manual checklist: macOS

| # | Do | Expected |
|---|---|---|
| M1 | `bun test` | 23 pass, 0 skip. No prompts, because your own `bun` creates and reads its own items. Size probe: all sizes ok. |
| M2 | `bun src/cli.ts roundtrip` | 9 PASS, no prompt. |
| M3 | `open build/dev-macos-*/*.app`. Look at the window. | `execPath=…/<App>.app/Contents/MacOS/bun`. Read marker `NOT FOUND` on the first run, round trip PASS, **no prompt**. |
| M4 | Run `codesign -dv --verbose=2 build/dev-macos-*/*.app/Contents/MacOS/bun` and `codesign -d -r- build/dev-macos-*/*.app/Contents/MacOS/bun`. | **Prediction:** `Authority=Developer ID Application: Oven…`, `TeamIdentifier=7FRXF46ZSN`, not `adhoc`. The designated requirement is `identifier "bun" and anchor apple generic and … certificate leaf[subject.OU] = "7FRXF46ZSN"`. Paste both outputs into the results. If it says `Signature=adhoc`, the predictions for M7 and M8 flip; see FINDINGS §4. |
| M5 | Tray → **Write marker** and note `fp=`. Open **Keychain Access** (on macOS 15+, `/System/Library/CoreServices/Applications/Keychain Access.app`), search `dev.glimpse.app`. Double-click the item → **Access Control** tab. | The item is in the **login** keychain, Kind "application password", Account `spike-marker`, Where `dev.glimpse.app`. Access Control lists **bun**, the bundled binary. Note exactly what it lists. It is **not** visible in the Passwords app or iCloud Keychain, because it is a file-based keychain item. |
| M6 | **Rebuild, then read.** Change any visible string in `src/bun/window-html.ts`, run `bun --bun run build`, `open` the app again. Repeat after `rm -rf build` and a full rebuild. | `read marker (launch)` shows the **same fp with no prompt** both times. The bundled `bun` binary is byte-identical across rebuilds, so its code identity doesn't change. |
| M7 | Threat model: `~/.bun/bin/bun tools/foreign-read.ts` (your own `bun`, outside the app). | **Prediction:** same fp, **no prompt**. The ACL trusts the Oven-signed `bun` designated requirement, not Glimpse. If a prompt appears, note its text and click Deny. |
| M8 | `security find-generic-password -s dev.glimpse.app -a spike-marker -w \| shasum -a 256 \| cut -c1-12` | A prompt like **"security wants to use your confidential information stored in "dev.glimpse.app" in your keychain"** with Always Allow / Deny / Allow, asking for the login password. Click **Deny**. The command fails (`SecKeychainSearchCopyNext`/`-128` or similar). Note the text. |
| M9 | **Unsigned rebuild re-prompt.** Run `bun run compile`, then `codesign -dv dist/glimpse-keychain-cli` (expect `Signature=adhoc`), then `dist/glimpse-keychain-cli read-marker`. | A prompt naming **glimpse-keychain-cli**. Click **Always Allow** and enter your password. The fp matches. Run `read-marker` again: no prompt. |
| M10 | Run `bun run compile` **again** (new cdhash), then `dist/glimpse-keychain-cli read-marker`. | **The prompt comes back.** "Always Allow" was tied to the previous build's cdhash. Note this. Also, in Keychain Access → Access Control you will see an entry per allowed build. |
| M11 | Item created by the ad-hoc binary: `printf 'test-value-12345' \| dist/glimpse-keychain-cli set spike-cli`, then `bun run compile`, then `dist/glimpse-keychain-cli check spike-cli`. | A prompt on the read after the rebuild. Then run `dist/glimpse-keychain-cli delete spike-cli` (it may prompt). |
| M12 | **Locked keychain.** `security lock-keychain ~/Library/Keychains/login.keychain-db`, then tray → **Read marker** in the app. When the unlock dialog appears, click **Cancel**. | A system dialog asks for the login keychain password. Cancel → FAIL with `canceled` (`-128`) or `denied` (`-25293`). Note the code and the "UI would say" text. |
| M13 | Repeat M12, but enter the password. | PASS with the same fp. Note whether the dialog named "bun" or the app. |
| M14 | Optional, no-UI case. With Remote Login on, `ssh localhost`, run `security lock-keychain ~/Library/Keychains/login.keychain-db`, then `cd …/spikes/keychain && bun src/cli.ts read-marker`. | FAIL with `locked [ERR_SECRETS_INTERACTION_NOT_ALLOWED] (code -25308)`. UI text: "Your keychain is locked…". Unlock afterwards with `security unlock-keychain`. |
| M15 | Tray → **Size probe**, then **Service-rename migration probe**. | Size: all PASS (no small limit on macOS). Migration: 5 PASS, no prompt. |
| M16 | Tray → **Delete marker**. Check Keychain Access. | `deleted=true`, and the item is gone. |
| M17 | `grep -E 'glim-marker-|glim-test-' ~/glimpse-keychain-spike.log` | No matches. |

---

## Results

Fill in **pass / partial / fail** and notes, especially exact prompt texts, error codes and `codesign` output.

### Windows (version: ______, arch: ______)

| # | Result | Notes |
|---|---|---|
| W1 | | |
| W2 | | |
| W3 | | |
| W4 | | |
| W5 | | |
| W6 | | |
| W7 | | |
| W8 | | |
| W9 | | |
| W10 | | |
| W11 | | |
| W12 | | |
| W13 | | |
| W14 | | |

### macOS (version: ______, arch: ______)

| # | Result | Notes |
|---|---|---|
| M1 | | |
| M2 | | |
| M3 | | |
| M4 | | |
| M5 | | |
| M6 | | |
| M7 | | |
| M8 | | |
| M9 | | |
| M10 | | |
| M11 | | |
| M12 | | |
| M13 | | |
| M14 | | |
| M15 | | |
| M16 | | |
| M17 | | |

### Overall

| OS | Overall (pass / partial / fail) | Notes |
|---|---|---|
| Windows | | |
| macOS | | |

## Cleanup

- Windows: `cmdkey /delete:dev.glimpse.app/spike-marker`, and the same for any other `dev.glimpse.app*` entries left by an aborted run.
- macOS: `security delete-generic-password -s dev.glimpse.app -a spike-marker`. Also remove `dev.glimpse.app.test` and `dev.glimpse.app.old-name` items if a test aborted.
