# GLIM-77: Launch at login

Status: decided (2026-11-01). Implementation: `app/src/bun/services/login-item.ts`.
Unverified on real hardware until the GLIM-87 check.

## Decision

Off by default (`system.launchAtLogin: false`). The setting is the user's choice; at startup
`LoginItem.reconcile()` makes the OS match it, and the Settings switch changes both.

- **macOS: a per-user LaunchAgent**, `~/Library/LaunchAgents/dev.glimpse.app.login.plist`,
  with `ProgramArguments = ["/usr/bin/open", "<path to Glimpse.app>"]`, `RunAtLoad`,
  `LimitLoadToSessionType = Aqua`. No `launchctl load`: launchd reads the folder at the next
  login. Turning it off deletes the file.
- **Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`**, value `Glimpse`
  (REG_SZ), data = the quoted path of Electrobun's `launcher.exe` (next to `bun.exe` in the
  installed app's `bin/`). Written with `reg.exe add/delete/query`, no native code.
- Linux and unpackaged dev runs: unsupported; the switch is disabled with the reason.

## Why not SMAppService on macOS

`SMAppService.mainApp.register()` (macOS 13+) would be the modern API, called through the
native helper. It doesn't fit an unsigned app:

1. Login items registered through ServiceManagement are tied to the app's code signature.
   An unsigned bundle (our GitHub builds) fails to register; an ad-hoc signature changes with
   every build, so the approval is lost after each update and the user has to re-allow it.
2. It needs a new native helper export and a main-thread hop, for no gain over a plist.
3. `SMAppService.agent(plistName:)` has the same signing requirement.

The LaunchAgent works for any bundle, signed or not, and survives updates as long as the app
stays at the same path. If the user moves the app, `reconcile()` rewrites the plist on the
next launch from the new location. `open` launches through LaunchServices, so Glimpse starts
as a normal app (not a child of launchd) and quitting it doesn't make launchd restart it.

Trade-offs, accepted:
- macOS 13+ lists the agent under System Settings > General > Login Items > "Allow in the
  Background" (shown by its plist name, not the app icon) and posts a one-time "Background
  item added" notification. The user can switch it off there; our status then still reads
  "on" (the file exists), which is harmless: the next login simply doesn't start it.
- Revisit when releases are Developer ID signed: switch to `SMAppService.mainApp`, which shows
  Glimpse by name under "Open at Login", and delete the plist on first run.

## Windows notes

- Task Manager's Startup tab can disable the entry (it writes `StartupApproved\Run`), which we
  don't read; Settings would still show "on". Acceptable for v1.
- The Run value points at the launcher, not `bun.exe`, so updates that replace `app/` keep
  working. If the launcher isn't next to `bun.exe` (dev run), the switch is disabled.

## Manual test notes (GLIM-87)

macOS: turn on, check the plist exists and `plutil -lint` passes, log out and in, Glimpse is in
the menu bar with no window; turn off, the plist is gone. Move Glimpse.app, launch it, the
plist now points at the new path. Windows: turn on, `reg query HKCU\...\Run /v Glimpse` shows
the quoted launcher path; sign out and in; turn off, the value is gone.
