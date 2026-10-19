# Claude Code & OMP GUI — Sessions, Usage & Review

You leave a few coding agents running and come back to a row of terminals. Which one finished, which one is still working, and which window you should type into are all buried in those terminals. **Claude Code & OMP GUI** (`jinxinyang.agent-sessions`) is a Cursor panel that answers that from the sessions OMP and Claude Code already saved.

## How to Open

The Session Library opens automatically the first time the extension activates. You can open or focus it at any time in four ways:

1. **Bottom-Left Status Bar**: Click **`💬 Sessions`** (shows live counts like **`💬 Sessions · 1 running · 1 new`** when agents are active).
2. **Top-Right Editor Toolbar**: Click the **`💬`** (**Sessions: Open Session Library**) icon in the top-right corner of any editor tab bar.
3. **Keyboard Shortcut**: Press **`Cmd+Alt+S`** on macOS (`Ctrl+Alt+S` on Windows/Linux).
4. **Command Palette**: Press **`Cmd+Shift+P`** (`Ctrl+Shift+P`) and run **`Sessions: Open Session Library`**.

## You come back and every terminal looks the same

Opening each one to see whether it answered is the slow part. The list marks the session that just replied and the one still running, along with each session's model, context usage, total tokens, and estimated cost. Click **1 new** or **1 running** and those are the only rows. The session you have open keeps updating while you read it.

![One session is still running, one has a new reply, and the reply shows the files it changed.](docs/images/library.png)

The follow-up goes in the box at the bottom. When the OMP window is still open, Send pastes it there, so you can answer the session you are reading. Claude Code sessions can be read the same way. Mermaid diagrams, `svg` blocks, and numeric Markdown tables render inline with interactive full-screen zoom and pan. Under the reply, the files that turn changed are listed, and Diff opens the change in the panel before you answer.

**This workspace** keeps the list to the repo you have open. Sessions from other directories show up under **All workspaces**. A draggable mascot widget in the corner shows **Today** and **Month** spend for OMP and Claude Code with per-call `↑ +$0.xxx` floating toasts (right-click it to switch characters, pick a custom image, or minimize it).

## You want to mark one sentence, and then the agent rewrites the file

Telling the agent "look at the file" leaves it to guess which sentence you mean. Select the passage and choose **Comment**. The highlight and the quoted text stay put, so you can step away and still see what the note is about.

![A saved comment on one highlighted phrase, and a second comment being written while that selection stays highlighted.](docs/images/review.png)

**Send to this turn** pastes this review into the open OMP window. Once you send it, or once you open the file again after the agent has changed it, the next review starts empty, so an old note is not sent again as if it were about the new text. The earlier review stays in the **Review** menu, and **View changes** shows what happened to the file since that pass.

## Install

In Cursor, open Extensions and search for **Claude Code & OMP GUI** (`jinxinyang.agent-sessions`), or install from [Open VSX](https://open-vsx.org/extension/jinxinyang/agent-sessions). Once installed, click **`💬 Sessions`** in the bottom-left status bar (or press **`Cmd+Alt+S`** / **`Ctrl+Alt+S`**) to open the panel.

To build from this repository, run `npm install` and then `npm run package`. Install that `.vsix` with **Extensions: Install from VSIX…**.
