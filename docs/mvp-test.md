# Testing the Glimpse MVP (5 minutes)

The app on `develop` is the MVP: one tray / menu-bar app that does Snip, Live, Settings and
Private mode with local OCR and local translation. This page is the quickest way to check a
build works on your computer. Every build CI makes has already passed an automatic run of the
whole pipeline (screen text → OCR → language detection → translation → English) on Windows and
macOS (GLIM-146), so what's left to check by hand is the part only a real desktop shows.

## 1. Download

**Test builds (now):** GitHub Actions builds every change to `develop`.

1. Open [Actions › Desktop builds](https://github.com/Abdul-213/glimpse/actions/workflows/desktop.yml)
   (you need to be signed in to GitHub to download).
2. Click the newest run with a green tick on branch `develop`.
3. Under **Artifacts** at the bottom, download the file for your computer:

   | Computer | File |
   |---|---|
   | Windows 10 (2004+) / 11, x64 | `glimpse-<version>-<sha>-windows-x64-setup.zip` (installer) or `-windows-x64.zip` (portable) |
   | Mac with Apple Silicon, macOS 14+ | `glimpse-<version>-<sha>-macos-arm64.dmg` (or `.zip`) |

   Artifacts are kept for 14 days. `<sha>` is the commit the build came from: mention it when
   you report a problem.

**Releases (later):** once a version is tagged, the same files (plus `SHA256SUMS`) are on the
[Releases page](https://github.com/Abdul-213/glimpse/releases).

There is no Intel Mac or Linux build to test.

## 2. Install

The builds aren't code-signed, so Windows and macOS each warn once before they open them.
Follow **[docs/install.md](install.md)**: it has every warning, how to get past it, and the
macOS Screen Recording permission.

Short version: on Windows, unzip and run `Glimpse-Setup.exe` (SmartScreen: *More info* → *Run
anyway*). On a Mac, drag Glimpse to Applications first, then open it and use System Settings ›
Privacy & Security › *Open Anyway*.

## 3. First run

1. The first start takes a few seconds longer: Glimpse unpacks itself.
2. A setup window opens: **Welcome** → (macOS) **Screen access** → **Translate into** →
   **Languages to read** → **Shortcuts** → **You're set**.
3. On *Translate into*, keep **English**. On *Languages to read*, pick **German**,
   **Japanese** and **French** and click **Download** (about 35–70 MB per language, from
   Mozilla, once; after that Glimpse works offline).
4. On macOS, allow Screen Recording when asked, then let Glimpse restart.

Skipped something? The tray menu shows **Finish setting up…** until setup is done.

## 4. The 5-minute checklist

Open the sample page: **[mvp-sample.png](mvp-sample.png)** (view it on GitHub, full size) or
[mvp-sample.html](mvp-sample.html) (download it and open it in a browser). It has German,
Japanese and French paragraphs, a mixed box, and roughly what the English should say.

Shortcuts: Windows **Alt+Shift+S** (Snip) and **Alt+Shift+L** (Live); macOS **⌃⇧S** and **⌃⇧L**.

| # | Do this | You should see |
|---|---|---|
| 1 | Look at the taskbar notification area (Windows; it may be under the **^** overflow arrow) or the menu bar (Mac). | The Glimpse icon. Clicking it opens a menu with Snip, Live, Private, Settings…, Troubleshooting and Quit. There is no Dock icon or main window. |
| 2 | Press the Snip shortcut and drag a box around the **German** paragraph. | A popup next to the box: the text outlines first, then *"The file could not be saved. Please try again later."* (wording may differ a little). |
| 3 | Paste into any text field (Ctrl+V / ⌘V). | The English translation was copied. |
| 4 | Snip the **Japanese** box, then the **mixed** box. | Japanese → *"Tomorrow's meeting starts at 3 pm…"*. In the mixed box each line is translated on its own. If a language pack is missing, the popup offers a **Download** button instead; click it and the text translates when it lands. |
| 5 | Press the Live shortcut (or tray › *Live: pin a region*) and drag over the **French** box. | A Live popup docks to the region and shows the English. Scroll the page so other text moves into the region: within a second or two the popup updates. Press the shortcut again (or tray › *Stop Live*) to stop. |
| 6 | Tray › **Settings…** | The Settings window opens (General, Languages, Shortcuts, Providers, Models, Privacy, About). Close it; Glimpse keeps running. |
| 7 | Tray › **Private** (a check mark appears), then Snip any box again. | The popup shows a **Private** badge (nothing from that Snip is remembered). Turn Private off again from the tray. |

All seven pass? The MVP works on your machine. Quit from tray › **Quit Glimpse**.

## 5. If something fails

Please send (an issue on GitHub, or a message):

1. **Which build:** the file name you downloaded (it contains the version and `<sha>`), and
   your OS and version (e.g. Windows 11 23H2, macOS 15.2).
2. **Which step** above, what you did, and what you saw (a screenshot helps).
3. **Diagnostics:** tray › **Troubleshooting › Copy diagnostics**, then paste. (Also in
   Settings › About.) It lists the app version, OS, displays, providers and the last log lines.
4. **The log file**, if Glimpse misbehaved or quit: tray › **Troubleshooting › Open logs
   folder** (or Settings › About › *Open logs folder*) and attach `glimpse.log` (plus
   `glimpse.1.log` … if they exist). If the tray icon never appears, find the folder by hand:

   - Windows: `%LOCALAPPDATA%\dev.glimpse.app\` (paste that into Explorer's address bar), in
     the build's subfolder
   - macOS: `~/Library/Logs/dev.glimpse.app/` (Finder › Go › Go to Folder…), in the build's
     subfolder

Logs and diagnostics stay on your computer until you send them. They never contain the text
Glimpse read from your screen, or API keys.
