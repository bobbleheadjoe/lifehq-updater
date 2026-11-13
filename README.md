# LifeHQ Updater

Keeps your [LifeHQ](https://lifehq.practicalpkm.com) vault up to date without overwriting your changes.

When a new version of LifeHQ comes out, the updater shows you a checklist of everything that changed: every template, dashboard, plugin and setting, with the reason for each change. You pick what you want, and it backs up every file before touching it.

- Files you've customized are never overwritten unless you choose to replace them. LifeHQ's new version is saved next to yours so you can compare.
- Your notes, journal entries, projects and anything else you wrote are never touched.
- Moved or renamed LifeHQ files are found where you put them.
- Settings are updated one at a time, so you keep your own tweaks.

Updates are included with LifeHQ, Library Pro, Library VIP and Library Lifetime.

## Install (one time)

LifeHQ already includes the BRAT plugin, which installs plugins like this one.

1. Open the command palette (Cmd/Ctrl + P) and run **BRAT: Add a beta plugin for testing**.
2. Paste `bobbleheadjoe/lifehq-updater` and click **Add Plugin**.
3. Make sure **LifeHQ Updater** is turned on in Settings → Community plugins.

## Update LifeHQ

1. Run **Check for LifeHQ updates** from the command palette.
2. The first time, enter the email you bought LifeHQ with. Type in the code we email you.
3. Review the checklist, then click **Back up & update**.

After Obsidian reloads, your update report opens. It shows exactly what changed and why. A backup of every changed file is saved in `LifeHQ Updates/`.

Questions? Email support@mikeschmitz.com.
