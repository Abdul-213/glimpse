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
| 5a | With Live running and another app (the browser) focused, **drag the Live popup's top bar** (the dotted grip at its left end) somewhere else, then type in the browser's address bar. | The popup follows the pointer and stays where you drop it, fully on screen; the browser keeps keyboard focus the whole time (typing still goes to it). As the text changes the popup grows downward from where you put it. |
| 5b | Click the **magnet** button in the popup's top bar (or double-click the bar). | The popup snaps back next to the Live region. The magnet disappears until you move it again. |
| 5c | Move the popup again, stop Live and start it again on the same box. | The new popup opens where you last put it (relative to the box). Clicking the magnet then forgets that spot. |
| 5d | Click the **pin** button (it loses its highlighted background and gets a slash), then click the browser window. | The browser now covers the popup. Click the pin again: the popup comes back on top. Neither click takes focus away from the browser. |
| 5e | Tray › *Focus Live popup* (Settings › Shortcuts can bind it), then press **Alt+arrow keys** (Mac: **Option+arrow keys**), with and without Shift. Press Esc. | The popup moves 10 px per press (50 px with Shift) and stops at the screen edge. A screen reader says "Popup moved". Esc hands focus back. |
| 6 | Tray › **Settings…** | The Settings window opens (General, Languages, Shortcuts, Providers, Models, Privacy, About). Close it; Glimpse keeps running. |
| 7 | Tray › **Private** (a check mark appears), then Snip any box again. | The popup shows a **Private** badge (nothing from that Snip is remembered). Turn Private off again from the tray. |

All of them pass? The MVP works on your machine. Quit from tray › **Quit Glimpse**.

### Comics: which translation belongs to which bubble (GLIM-152)

Open **[samples/comic-ja.png](samples/comic-ja.png)** (a manga page, vertical Japanese) and
**[samples/comic-en-fr.png](samples/comic-en-fr.png)** (English and French bubbles) at full size.

| # | Do this | You should see |
|---|---|---|
| 8 | Snip the whole manga page. | One outline per bubble (plus the narration box), each with a number badge on its top-left corner: **1** top-right bubble, **2** top-left, **3** bottom-right panel, **4** the narration box, **5** the bottom-left bubble. The popup lists the translations with the same numbers. |
| 9 | Hover a translation in the popup, then hover a bubble on screen. | Hovering in the popup fills that bubble's outline and turns its badge blue; hovering a bubble turns its popup number blue. |
| 10 | Click bubble **3** (or its badge) on screen. | The popup stays open, scrolls to translation 3 and highlights it. Keys still work in the popup (press **↓**). Clicking empty space outside every bubble closes the popup as before. |
| 11 | Look at the popup footer without hovering anything, then press its **On screen** button (or **Ctrl+Shift+T** / **⌘⇧T**). | An outlined **On screen** button (speech-bubble icon + words) sits before the other footer buttons; hovering it says *Show translations on screen (Ctrl+Shift+T)*. If this is the first Snip with something to translate since installing this build, a line *Tip: On screen (Ctrl+Shift+T) puts translations over the text.* shows above the footer, once (it never comes back on later Snips). Pressing it: the button fills and its icon turns blue, each translation is painted over its bubble on an opaque card, text sized to fit; badges stay on. The footer says *Hold Shift to peek*. Press it again: the cards go away. |
| 12 | Hold **Shift**, then hover one card. | While Shift is held all cards disappear and the Japanese shows; hovering a card shows the Japanese under that one only. |
| 13 | Press **Esc** once, then again. | The first Esc removes the cards (back to the list); the second closes the popup. |
| 14 | Settings › General › **Show translations on screen** on, then Snip the English/French page. | The Snip opens with cards already on. Each bubble is one card (lines of a bubble are not split). Turn the setting off again. |
| 15 | If you use them: dark mode, Reduce motion, and High contrast (Windows) or Increase contrast (macOS). | Cards follow light/dark; peeking has no fade with reduced motion; in high contrast cards and badges use system colours with a visible border. |
| 16 | With the cards on screen, press the Snip shortcut and snip the manga page again. | The new popup translates the Japanese again; it never reads the English cards (Glimpse leaves its own overlays out of its captures). |
| 16a | Open the tray / menu-bar menu. Tick **Show translations on screen**, Snip the manga page, then untick it. | The item is a checkbox, ticked when Settings › General › *Show translations on screen* is on (and the other way round). Ticked, Snips open with the cards on. |

### Comics in Live: numbers and cards over a pinned page (GLIM-154)

Keep the manga page open at full size, with another app (a text editor) focused next to it.

| # | Do this | You should see |
|---|---|---|
| 17 | Press the Live shortcut and drag over the whole manga page. | The corner ticks appear around the page and a number badge sits on each bubble's top-left corner (1 top-right bubble, 2 top-left, 3 narration box, 4 bottom-right, 5 bottom-left); the Live popup lists the translations with the same numbers. The editor keeps keyboard focus. |
| 18 | Hover a translation in the Live popup. | That bubble fills light blue on the page and its badge turns blue. |
| 19 | Move the mouse onto badge **3** on the page (don't click), then click it. Then click on the page **between** bubbles, and type in the editor. | Hovering the badge turns translation 3 blue in the popup; clicking scrolls the popup to it and highlights it. The click between bubbles goes to the app under the page (the frame is click-through except on badges and cards); the editor still has keyboard focus and typing goes to it. |
| 20 | Click the **On screen** button (first of the buttons in the Live popup's top bar; the popup's buttons may take two lines on a narrow popup). Then use the tray's **Show translations on screen** to turn the cards off and on again. | Each translation is painted on a card over its bubble, sized to fit. Hover one card: it goes almost transparent and the Japanese shows under it. The button fills while the cards are on; the tray item turns them off and on in the running session too. |
| 21 | Scroll or edit so one bubble's text changes (or open **[samples/comic-en-fr.png](samples/comic-en-fr.png)** in the same spot). | Within a second or two only the changed cards update in place; a changed card gets a small blue dot and a faint blue tint; unchanged bubbles keep their numbers. A page whose bubbles all change starts again at 1. The cards never show the translation of a card (Live never reads its own cards). |
| 22 | Pause Live from the popup, then resume. | While paused the badges and cards fade to 60 % with the ticks; on resume they come back. |
| 23 | Tray › *Hide Live popup*, then show it again; drag the popup's top bar, press the magnet, toggle the pin. | The region tag ("Live") appears above the page while the popup is hidden; the badges and cards stay. Moving, docking and pinning work as in steps 5a–5d. |
| 24 | Settings › Privacy › turn **Hide Glimpse from screenshots** off, start Live on the page with the cards on, and take a screenshot (Win+Shift+S / ⌘⇧4) of the page. | The cards still never feed back into Live (step 21). In your screenshot the badges and cards are **not** visible (they are always left out of captures; only the popup follows that setting). Turn the setting back on. |
| 25 | Settings › General › **Show translations on screen** on, then start Live on the page. | Live opens with the cards already on. Windows 10 before version 2004: no badges, no cards and no On screen button (Glimpse can't keep them out of its own captures there); the popup works as before. |

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
