# Installing Glimpse

Glimpse runs on **Windows 10 (version 2004) or later** and **macOS 14 Sonoma or later on Apple
Silicon**. There is no Intel Mac build yet.

Builds of Glimpse are **not signed** by Apple or Microsoft yet. Both systems warn you before
they open an unsigned app, and on a Mac the Screen Recording permission works a little
differently. This page explains each warning, how to get past it, and what you're agreeing to
when you do.

- [Why the builds are unsigned](#why-the-builds-are-unsigned)
- [macOS](#macos): [Gatekeeper](#opening-glimpse-the-first-time) · [Screen Recording](#screen-recording) · [After an update](#after-an-update)
- [Windows](#windows): [SmartScreen](#smartscreen) · [Smart App Control](#smart-app-control) · [WebView2](#webview2)

> **Draft (GLIM-63).** These steps were written from Apple's and Microsoft's documentation and
> the behaviour of current OS releases, and haven't yet been walked through on every OS version
> listed. Screenshots still need to be added (marked *Screenshot:* below). If a step doesn't
> match what you see, please open an issue.

## Why the builds are unsigned

Signing proves who published an app. It needs a paid Apple Developer ID ($99 a year, plus
notarisation) and, on Windows, a code-signing certificate tied to a verified identity. Glimpse
is a small open-source project and hasn't taken that on yet.

Unsigned doesn't mean unchecked: every line of Glimpse is public on GitHub, and the builds are
made by GitHub Actions from that code (`.github/workflows/desktop.yml`). It does mean your
computer can't confirm on its own that the copy you downloaded is the one the project
published. So:

- **Only download Glimpse from the project's GitHub page** (Releases, or the Actions build
  artifacts for test builds). Don't run copies from anywhere else.
- The steps below tell your system to trust **this one app**. They don't lower your security
  settings for anything else.

## macOS

Download the `.dmg` (or the `.zip`) for Apple Silicon.

1. Open the DMG and drag **Glimpse** into **Applications**. If you downloaded the zip,
   double-click it, then drag `Glimpse.app` into Applications.
2. Do this **before** opening Glimpse. An app opened straight from Downloads or a disk image runs
   from a temporary location, and permissions and "Open at login" won't stick to it.

Glimpse is a menu-bar app: it has no Dock icon and no main window. Look for its icon at the top
right of the screen.

### Opening Glimpse the first time

The first time you open Glimpse, macOS stops it because it can't check it for malware. What you
do next depends on your macOS version.

#### macOS 15 Sequoia and macOS 26 Tahoe

1. Double-click Glimpse in Applications. macOS says **"Glimpse" Not Opened**: "Apple could not
   verify 'Glimpse' is free of malware…". Click **Done** (not *Move to Trash*).
   *Screenshot: the "Not Opened" dialog.*
2. Open **System Settings › Privacy & Security** and scroll down to **Security**. You'll see
   **"Glimpse" was blocked to protect your Mac.** Click **Open Anyway**. The button only shows
   for a while after you tried to open Glimpse; if it isn't there, do step 1 again.
   *Screenshot: Privacy & Security with Open Anyway.*
3. Enter your password (or use Touch ID).
4. macOS asks once more. Click **Open Anyway**.

From macOS 15 on, Control-clicking the app and choosing *Open* no longer gets you past the
warning; you have to use System Settings.

#### macOS 14 Sonoma

1. In Applications, **Control-click** (or right-click) Glimpse and choose **Open**.
2. macOS warns that it can't check the app for malicious software. Click **Open**.
   *Screenshot: the Sonoma "Open" dialog.*

If you double-clicked it instead and only got an *OK* button, use the Sequoia steps above:
System Settings › Privacy & Security › **Open Anyway**.

#### The first start is slow

Glimpse unpacks itself the first time it runs (and after each update), so the first start
takes a few seconds longer. Then it opens its setup window.

#### If macOS says Glimpse "is damaged and can't be opened"

macOS shows this when a downloaded app's signature doesn't check out, and current Glimpse test
builds have a known signature problem (GLIM-113). The app isn't damaged; macOS just won't run
it while it carries the "downloaded from the internet" mark. The advanced fix below removes
that mark. Clicking *Move to Trash* doesn't help.

#### Advanced: remove the quarantine mark in Terminal

When a browser saves a file, macOS tags it with an extended attribute,
`com.apple.quarantine`. Gatekeeper only checks apps that carry the tag. Removing it from Glimpse
tells macOS to skip that check for this app:

```sh
xattr -dr com.apple.quarantine /Applications/Glimpse.app
```

`-d` deletes the attribute and `-r` does it for every file inside the app. Then open Glimpse as
usual.

To be clear about what this does: it turns off Apple's malware check for this copy of Glimpse,
and only for this copy. Do it only for a Glimpse you downloaded from the project's GitHub page.
You'll need to do it again after downloading an update.

### Screen Recording

Glimpse reads the text in the region you select, so macOS asks for **Screen Recording**
permission (called **Screen & System Audio Recording** on macOS 15 and later). Glimpse only
captures the region you select, at the moment you select it.

1. Glimpse's setup window shows a **Screen access** step. Click **Allow screen access**. macOS
   shows its own prompt; choose **Open System Settings**.
2. In **Privacy & Security › Screen & System Audio Recording** (macOS 14: *Screen Recording*),
   turn on **Glimpse**.
   *Screenshot: the Screen Recording list with Glimpse.*
3. macOS offers to **Quit & Reopen** Glimpse. Do that, or use **Restart Glimpse** in Glimpse's
   window. The permission only takes effect once Glimpse starts again, and setup picks up where
   you left off.

If you skipped this, Snip and Live open the same window, and the menu-bar menu shows
**Allow Screen Access…** at the top.

On macOS 15 and later, macOS may also ask from time to time whether Glimpse may keep recording
the screen ("…is requesting to bypass the system private window picker…"). That's macOS
checking in on apps that capture the screen directly. Choose **Allow** to keep Snip and Live
working.

### After an update

Because the build is unsigned, macOS identifies Glimpse by a fingerprint of its code, and every
new version has a different one. **After each update, macOS forgets that Glimpse was allowed
to record the screen.** Glimpse notices this and opens a window that says *Glimpse lost its
screen access*.

System Settings may still show Glimpse switched **on**; that entry belongs to the old version.
To fix it:

1. Open **System Settings › Privacy & Security › Screen & System Audio Recording**.
2. Switch Glimpse **off and on again**. If that doesn't help, select Glimpse, click the
   **minus (−)** button to remove it, then click **plus (+)** and add `/Applications/Glimpse.app`
   again (or let Glimpse ask again).
3. Restart Glimpse.

After an update you'll also go through the Gatekeeper steps once more, since it's a new
download. A signed build would fix both; that's tracked in the project's backlog.

## Windows

There are two downloads:

- **Portable** (`…-windows-x64.zip`): unzip it anywhere and run `Glimpse\bin\launcher.exe`.
- **Installer** (`…-windows-x64-setup.zip`): unzip it and run `Glimpse-Setup.exe`.

Before unzipping, you can right-click the zip, choose **Properties**, tick **Unblock** and click
**OK**. Windows then doesn't treat every file in it as downloaded, and you get fewer warnings.
Only do this for a zip from the project's GitHub page.

Glimpse lives in the notification area at the right of the taskbar. Windows may hide new icons
behind the **^** arrow; drag Glimpse out to keep it in view.

### SmartScreen

The first time you run Glimpse (or the installer), Microsoft Defender SmartScreen may say
**"Windows protected your PC"**, and only offer *Don't run*.

1. Click **More info**.
2. Check that the app is Glimpse (`launcher.exe` or `Glimpse-Setup.exe`), then click
   **Run anyway**.
   *Screenshot: SmartScreen with More info expanded.*

SmartScreen warns about apps it hasn't seen many people run, which is every new unsigned build.
It asks again for each new version.

### Smart App Control

On Windows 11 with **Smart App Control** turned on, unsigned apps are blocked outright, with no
*Run anyway* button ("Smart App Control blocked an app that may be unsafe"). Glimpse can't run
there until it is signed. Your options:

- Wait for a signed release.
- Turn Smart App Control off in **Windows Security › App & browser control › Smart App Control
  settings**. Think about this first: it protects against all unknown apps, not just Glimpse, and
  on some Windows versions it can't be turned back on without resetting Windows.

Most PCs that were upgraded from Windows 10, or set up a while ago, have Smart App Control off
already.

### WebView2

Glimpse draws its windows with **Microsoft Edge WebView2**, which comes with Windows 11 and with
up-to-date Windows 10. If Glimpse's windows open blank, or it doesn't start at all, install the
**Evergreen WebView2 Runtime** from Microsoft
(<https://developer.microsoft.com/microsoft-edge/webview2/>) and start Glimpse again.

Screen capture needs Windows 10 version 2004 (build 19041) or later; Glimpse's own windows are
kept out of screenshots and screen sharing from that version on. Windows has no screen-recording
permission, so there's no screen-access step on Windows.
