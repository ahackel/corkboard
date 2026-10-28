# The phone inbox — setup with iCloud Drive

Jot a thought on your iPhone; it's waiting on the board, in the **Inbox** section, when you're back at the
Mac. The phone writes a small Markdown file into the map's `Inbox/` folder, iCloud carries it to the Mac,
and the board picks it up the next time its window comes to the front.

This needs the board to be a **folder** (Home → *Local folder* → *Open folder…*, Chrome or Edge), and
that folder to live in **iCloud Drive**. A map in the browser's own storage can't be reached from a phone.

## 1. On the Mac: put the map in iCloud Drive

1. In Finder, move the map's folder into iCloud Drive — e.g. `iCloud Drive/Corkboard/My map/`.
2. Right-click the folder → **Keep Downloaded**. Otherwise macOS may keep a new note in the cloud until
   something opens it, and it can show up on the board one switch-back late.
3. In Corkboard: Home → *Local folder* → *Open folder…* → pick the folder in iCloud Drive.
4. Press **⌘P** and run **Inbox**. It makes the Inbox section (and its `Inbox/` folder) beside your board.
   Run it again any time to jump there.

## 2. On the iPhone: a Shortcut that saves to the Inbox

In the **Shortcuts** app, tap **+** and name the shortcut *Add to Corkboard*. Add these actions:

| # | Action | Set it to |
|---|---|---|
| 1 | **Ask for Input** | Input type *Text*, prompt "What's on your mind?", default answer *Shortcut Input* |
| 2 | **Format Date** | *Current Date*, Date Format *Custom*: `yyyy-MM-dd HHmmss` |
| 3 | **Text** | the *Provided Input* from step 1 |
| 4 | **Set Name** | name the *Text* `Formatted Date.md` (tap the field and pick *Formatted Date*, then type `.md`) |
| 5 | **Save File** | turn **Ask Where to Save** off, pick the folder `iCloud Drive › Corkboard › My map › Inbox`, leave **Overwrite If File Exists** off |

Then open the shortcut's details (ⓘ) and switch on **Show in Share Sheet** so you can send text or a link
from Safari, Mail or Notes straight to it — the shared text pre-fills the box.

**Ways to start it** — pick what suits you: *Add to Home Screen* (from the details), the **Action button**
(Settings → Action Button → Shortcut), **Back Tap** (Settings → Accessibility → Touch → Back Tap), a
Control Center or Lock Screen control, or Siri: "Add to Corkboard".

## 3. What to write

Whatever you type becomes one card. It is plain Markdown, so the usual things work:

- a first line starting with `# ` is the card's title;
- `- [ ] call Anna` is a task with a checkbox;
- `#idea` tags the card.

The file's name (the date) doesn't show anywhere; once you edit the card on the board its file is renamed
after its text, like every other card.

## 4. At the desk

Switch to the Corkboard window. New notes appear in the Inbox section, in a column beside whatever is
already there, and **pulse** blue for a moment. If the Inbox is folded, its pill pulses and its count goes
up. Drag each card to where it belongs — that moves its file out of the `Inbox/` folder too, so the inbox
empties as you sort.

## When a note doesn't show up

- **Click into the board's window.** It re-reads the folder when the window comes to the front, not
  while it is already in front.
- **Is the file on the Mac yet?** Look in Finder under `Inbox/`. iCloud usually takes seconds, sometimes a
  minute. If it shows a cloud icon, step 1.2 (Keep Downloaded) is missing.
- **Chrome asks for the folder again after a restart.** That's Chrome's permission rule for local
  folders: Home → click the folder in *Local folder* → *Allow*.
- **The Shortcut can't find the folder.** Open the Files app once, browse to `iCloud Drive › Corkboard ›
  My map › Inbox` so the phone has it, then pick it again in step 5.
