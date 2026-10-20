# 1.5.7

Since 1.5.6.

- Aggregate subagent `.jsonl` usage, token throughput (`tok/s`), and spend (`<session>/<Agent>.jsonl` for OMP and `<session>/subagents/agent-*.jsonl` for Claude Code) into the parent session across the session list, opened transcript header, and mascot spend toasts while preserving the parent session's title, model, and current context window fill.
- Watch session companion and `subagents/` directories with `fs.watch` so background subagent activity immediately updates parent session stats and running state.

# 1.5.6

Since 1.5.5.

- Add **Resume in Terminal** across the Session Library (thread header, reply bar, and session row actions) and the File Review panel so closed OMP (`omp -r <file>`) and Claude Code (`claude --resume <id>`) sessions can be reopened in a Cursor integrated terminal in their original working directory with one click.
- Support replying and sending file review comments directly to Cursor integrated terminals (`vscode.window.terminals`) in addition to external macOS `Terminal.app` and `iTerm2` windows.

# 1.5.5

Since 1.5.4.

- Add multiple entry points to open the Session Library: a top-right editor toolbar icon (`editor/title`), a default keyboard shortcut (`Cmd+Alt+S` on macOS, `Ctrl+Alt+S` on Windows/Linux), and a one-time reopen tip when closing the Session Library panel for the first time.
- Keep the `Sessions` label visible in the bottom-left status bar item when background sessions are active (`Sessions · 1 running · 1 new` instead of replacing the label with counts).
- Document all four ways to open the Session Library in `readme.md` for GitHub and the Cursor Extension Marketplace.

# 1.5.4

Since 1.5.3.

- Unify Markdown and LaTeX math rendering across session threads (`media/panel.js`) and file review views (`review.js`) using `markdown-it` and `KaTeX` (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`, `\frac`, `\text`, `\mathbf`, `\textcolor`, `\colorbox`, `\fcolorbox`, matrices, and CJK full-width punctuation adjacent to `**bold**`).
- Add in-file search (`Search file (⌘F)` with match count, `Prev`/`Next`, `Enter`/`Shift+Enter` navigation, and non-destructive `CSS.highlights` highlighting that preserves comment selections) to the file review panel.
- Register `WebviewPanelSerializer` for both `agentSessions` and `agentSessionsFile` so open Session Library and file review panels automatically revive across window reloads.

# 1.5.3

Since 1.5.2.

- Track and display model token throughput (`tok/s`) and average TTFT per session in the session list, thread header, and hover tooltips for both OMP and Claude Code.
- Add a **Speeds** comparison modal (accessible from the sidebar header and mascot menu) ranking all models by weighted `tok/s`, average TTFT, output tokens, session count, and cost across OMP and Claude Code.
- Ensure full dual-source independence between OMP and Claude Code: resolve Claude Code per-turn costs and context windows natively from `cost-state.modelUsage` and `~/.claude/settings.json` without requiring `~/.omp/agent/models.yml`, support terminal replies and file review comment sending for live Claude Code sessions (`liveTty`), enable Markdown table charts for Claude Code threads, and respect workspace scope in mascot `auto` mode.

# 1.5.2

Since 1.5.1.

- Rename Marketplace display title to **Claude Code & OMP GUI — Sessions, Usage & Review**, add extension icon (`media/icon.png`), and add AI/Chat/Visualization categories and search keywords (`claude-code`, `omp`, `gui`, `usage`, `sessions`, `code-review`).
- Update repository URLs to `Zzz141592653/claude-omp-gui`.

# 1.5.1

Since 1.5.0.

- Add interactive zoom and pan to the full-screen diagram viewer (scroll/trackpad cursor-centered zoom from 25% to 800%, drag to pan, double-click zoom toggle, `−` / `100%` / `+` toolbar buttons, and `+` / `-` / `0` / `Esc` shortcuts).
- Render OMP's built-in table charts in session threads using OMP's own chart engine (`omp-charts.min.js`) and render `svg` code blocks inline in both the session thread and file comment view.
- Overhaul Markdown and table typography in the file comment view and chat thread (full table borders, cell padding, zebra rows, heading hierarchy, inline code pills, blockquotes, and multi-level nested ordered/unordered lists).
- Keep the mascot avatar vertically anchored when floating spend toasts appear or running status changes, and preserve `OMP` / `Claude` source tag colors on selected rows.

# 1.5.0

Since 1.4.1.

- Add a draggable floating mascot widget (OMP-tan and Claude-tan with thinking/idle expressions, multi-session status, `↑$xxx` spend pop-ups, and custom image support) showing each source's Today and current Month spend.
- Render Mermaid diagrams in chat messages (with full-screen zoom), and fix markdown rendering for nested `**bold `code`**`, `####` headings, ordered lists with sub-bullets, and LaTeX arrows (`$\rightarrow$`).
- Sort all sessions together by time instead of splitting them into separate OMP and Claude Code sections, with a compact source tag (`OMP` / `Claude`) on each row.
- Recognize custom `omp-*` binaries (such as `omp-gemini-test`) and path-invoked `omp` commands when checking whether a session's terminal window is open.
- Show each session's current model, context window usage, total tokens, and estimated cost in the session list and thread header.
- Keep the file review scroll position and rendered diagrams steady when adding or deleting a comment.

# 1.4.1

Since 1.4.0.

- Closing the session library and opening it again from the status bar works. The same applies to a file comment view.

# 1.4.0

Since 1.3.0.

- This workspace no longer includes sessions from a parent directory.
- Comments belong to one review of a file. A new review starts empty, and sending uses only that review.
- The passage stays highlighted while its comment is being written.
- A process-exit record is no longer a new reply.
- Hidden sessions that are running or have a new reply stay in the list.
- The list can be filtered to new replies or running sessions.

# 1.3.0

Since 1.2.5.

## Sessions

- Reply from the bottom of the panel. The reply is sent to the open OMP window. Enter sends it.
- Files changed in the current turn can be compared side by side or inline.
- A session can be hidden. After its window is closed, the record can be moved to the Trash.
- Quoted blocks render as quotes, without showing the source `>` characters.
- A session that is still running stays "Running". It does not become "New reply" just because it was not opened.
- The open session updates incrementally. The session list scans on file changes instead of rereading the whole library.

## File comments

- After opening a file from a session, select text and right-click Comment. The highlight stores the position at the time of the selection.
- A comment can be sent to this turn, which pastes it into the open OMP window.
- Mermaid diagrams in Markdown are rendered. Move the pointer to the top edge of a diagram and Full screen appears at the top right.

## Inputs

- Cmd+A selects all text in the search box, the reply box, and the comment box.
