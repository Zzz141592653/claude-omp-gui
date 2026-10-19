const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const vscode = require("vscode");
const MarkdownIt = require("markdown-it");
const katex = require("katex");

const { normalizeRecord, openRound, noteLiveFile, closeRound, hashText } = require("./comments");
const { panelIsOpen, releaseClosedPanel } = require("./panel-life");
const { hasOmpProcess, hasClaudeProcess } = require("./sources");

const md = createMarkdownEngine();
const MAX_BYTES = 2_000_000;

let view;
let inputWebview = null;

function noteInputFocus(webview, focused) {
  if (focused) inputWebview = webview;
  else if (inputWebview === webview) inputWebview = null;
  void vscode.commands.executeCommand("setContext", "agentSessionsInputFocused", Boolean(inputWebview));
}

function selectAllInInput() {
  void inputWebview?.postMessage({ type: "selectAll" });
}

function focusFindInFileView() {
  if (view && panelIsOpen(view.panel) && view.panel.active) {
    void view.panel.webview.postMessage({ type: "focusFind" });
    return true;
  }
  return false;
}

function openReviewedFile(context, location, session) {
  const file = location.file;
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES || !isTextFile(file)) {
    return vscode.window.showTextDocument(vscode.Uri.file(file), {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
    });
  }
  if (view && !panelIsOpen(view.panel)) {
    view.watcher?.dispose();
    view = undefined;
  }
  if (!view) view = new FileView(context);
  void context.globalState?.update("lastReviewedFile", {
    file: location.file,
    line: location.line || 0,
    session: session || null,
  });
  return view.show(location, session);
}

async function reviveReviewedFilePanel(context, restoredPanel, state) {
  const saved = state?.file ? state : context.globalState?.get("lastReviewedFile");
  if (!saved?.file || !fs.existsSync(saved.file)) {
    restoredPanel.dispose();
    return;
  }
  if (view && view.panel !== restoredPanel) {
    view.watcher?.dispose();
  }
  view = new FileView(context, restoredPanel);
  await view.show({ file: saved.file, line: saved.line || 0 }, saved.session || null);
}

class FileView {
  constructor(context, existingPanel) {
    this.context = context;
    this.panel = existingPanel || vscode.window.createWebviewPanel("agentSessionsFile", "File", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const webview = this.panel.webview;
    webview.options = { enableScripts: true };
    webview.onDidReceiveMessage((message) => this.onMessage(message));
    webview.html = htmlFor(context, webview);
    this.panel.onDidDispose(() => {
      const watcher = this.watcher;
      releaseClosedPanel(
        () => {
          watcher?.dispose();
          if (view === this) view = undefined;
        },
        () => noteInputFocus(webview, false)
      );
    });
    this.record = normalizeRecord(null);
    this.viewing = "";
    this.ready = false;
    this.queue = null;
  }

  async show(location, session) {
    this.file = location.file;
    this.focusLine = location.line || 0;
    this.session = session || null;
    this.viewing = "";
    this.record = readRecord(this.context, this.file);
    const source = fs.readFileSync(this.file, "utf8");
    openRound(this.record, source);
    ensureSnapshot(this.context, this.file, this.record, source);
    if (session) {
      this.record.session = {
        key: session.key,
        source: session.source,
        sourceLabel: session.sourceLabel,
        title: session.title,
        cwd: session.cwd,
        filePath: session.filePath,
      };
    }
    await writeRecord(this.context, this.file, this.record);
    this.panel.title = path.basename(this.file);
    this.panel.reveal(vscode.ViewColumn.Active);
    this.watch();
    this.queue = { jump: true };
    if (this.ready) await this.post(true);
  }

  watch() {
    this.watcher?.dispose();
    const folder = vscode.Uri.file(path.dirname(this.file));
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path.basename(this.file)));
    this.watcher.onDidChange(() => this.onFileChanged());
  }

  async onMessage(message) {
    if (message.type === "inputFocus") {
      if (panelIsOpen(this.panel)) noteInputFocus(this.panel.webview, message.focused === true);
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      await this.post(true);
      return;
    }
    if (!this.file) return;
    if (message.type === "add") {
      if (this.viewing) return;
      const source = fs.readFileSync(this.file, "utf8");
      const located = locateQuote(source, message.quote, { startLine: message.startLine, endLine: message.endLine });
      const body = String(message.body || "").trim();
      if (!body) return;
      if (!this.record.current.comments.length) {
        this.record.current.baseHash = hashText(source);
        this.record.current.snapshot = "";
      }
      this.record.current.comments.push({
        id: crypto.randomUUID(),
        quote: message.quote,
        excerpt: located?.excerpt || message.quote,
        prefix: located?.prefix || "",
        suffix: located?.suffix || "",
        startLine: Number.isInteger(message.startLine) ? message.startLine : null,
        endLine: Number.isInteger(message.endLine) ? message.endLine : null,
        from: Number.isInteger(message.from) ? message.from : null,
        to: Number.isInteger(message.to) ? message.to : null,
        anchor: typeof message.anchor === "string" ? message.anchor : "",
        body,
        stale: false,
      });
      ensureSnapshot(this.context, this.file, this.record, source);
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "delete") {
      if (this.viewing) return;
      this.record.current.comments = this.record.current.comments.filter((item) => item.id !== message.id);
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "showVersion") {
      const id = String(message.id || "");
      this.viewing = this.record.versions.some((item) => item.id === id) ? id : "";
      await this.post(false);
      return;
    }
    if (message.type === "diff") {
      const snapshotPath = this.diffSnapshot();
      if (snapshotPath && fs.existsSync(snapshotPath)) {
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(snapshotPath),
          vscode.Uri.file(this.file),
          `${path.basename(this.file)}: earlier review ↔ current`
        );
      }
      return;
    }
    if (message.type === "send") await this.send();
  }

  onFileChanged() {
    if (!this.file) return;
    let source = "";
    try {
      source = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    if (noteLiveFile(this.record, source)) writeRecord(this.context, this.file, this.record);
    void this.post(false);
  }

  diffSnapshot() {
    if (this.viewing) {
      const version = this.record.versions.find((item) => item.id === this.viewing);
      return version?.snapshot || "";
    }
    const versions = this.record.versions;
    return versions.length ? versions[versions.length - 1].snapshot : "";
  }

  async send() {
    const session = this.record.session;
    const comments = this.record.current.comments;
    if (this.viewing || !session || !comments.length) return;
    const source = fs.readFileSync(this.file, "utf8");
    const tty = liveTty(session);
    if (!tty) {
      void vscode.window.showWarningMessage("That window is not open. Open it in the terminal before sending comments.");
      return;
    }
    ensureSnapshot(this.context, this.file, this.record, source);
    const prompt = comments
      .map((item) => {
        const excerpt = item.excerpt || item.quote || "";
        return `Selection:\n> ${excerpt.replace(/\n/g, "\n> ")}\n\nComment: ${item.body}`;
      })
      .join("\n\n");
    try {
      await pasteIntoTerminal(tty, prompt);
      closeRound(this.record, source);
      this.viewing = "";
      this.notice = "Pasted into the open window. Switch back to see the comments and what follows.";
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    await writeRecord(this.context, this.file, this.record);
    await this.post(false);
  }

  async post(jump) {
    if (!this.file || !this.ready) return;
    const live = fs.readFileSync(this.file, "utf8");
    let source = live;
    let comments = this.record.current.comments;
    let versionId = "";
    let missingText = false;
    if (this.viewing) {
      const version = this.record.versions.find((item) => item.id === this.viewing);
      if (!version) this.viewing = "";
      else {
        versionId = version.id;
        comments = version.comments;
        if (version.snapshot && fs.existsSync(version.snapshot)) source = fs.readFileSync(version.snapshot, "utf8");
        else missingText = true;
      }
    }
    const session = this.record.session;
    const label = session ? `${session.sourceLabel} · ${session.title}` : "No session attached";
    const tty = session ? liveTty(session) : "";
    let notice = this.notice;
    this.notice = "";
    if (versionId) notice = "Earlier review. These comments stay with that version.";
    else if (!notice) {
      if (!session) notice = "Open this file from a session before sending comments back to that turn.";
      else if (!tty) notice = `The ${label} window is not open. Open it before sending comments there.`;
      else notice = `Comments go to the open ${label} window`;
    }
    const html = missingText
      ? `<p class="empty">The file text for this review was not kept.</p>`
      : (isMarkdown(this.file) ? renderMarkdown(source) : renderText(source));
    const snapshotPath = this.diffSnapshot();
    if (!panelIsOpen(this.panel)) return;
    await this.panel.webview.postMessage({
      type: "state",
      fileName: path.basename(this.file),
      html,
      comments,
      versions: this.record.versions.map((version) => ({
        id: version.id,
        closedAt: version.closedAt,
        count: version.comments.length,
      })),
      versionId,
      sessionLabel: label,
      canSend: Boolean(!versionId && tty && this.record.current.comments.length),
      canDiff: Boolean(snapshotPath && fs.existsSync(snapshotPath)),
      notice,
      focusLine: jump ? this.focusLine : 0,
    });
  }
}

function liveTty(session) {
  if (!session) return "";
  if (session.source === "omp") return liveOmpTty(session);
  if (session.source === "claude") return liveClaudeTty(session);
  return "";
}

function liveOmpTty(session) {
  const dir = path.join(os.homedir(), ".omp", "agent", "terminal-sessions");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!name.startsWith("ttys")) continue;
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(session.filePath)) continue;
    try {
      const commands = execFileSync("ps", ["-t", name, "-o", "command="], { encoding: "utf8" });
      if (hasOmpProcess(commands)) return `/dev/${name}`;
    } catch {
      // This tty has no live process.
    }
  }
  return "";
}

function liveClaudeTty(session) {
  const id = path.basename(String(session.filePath || ""), ".jsonl");
  let psOut = "";
  try {
    psOut = execFileSync("ps", ["-ax", "-o", "pid=,tty=,command="], { encoding: "utf8", maxBuffer: 4_000_000 });
  } catch {
    return "";
  }
  const candidates = [];
  for (const raw of psOut.split("\n")) {
    const match = /^\s*(\d+)\s+(ttys\S+)\s+(.+)$/.exec(raw);
    if (!match) continue;
    const [, pid, tty, command] = match;
    if (!hasClaudeProcess(command)) continue;
    if (id && command.includes(id)) return `/dev/${tty}`;
    candidates.push({ pid, tty });
  }
  if (!candidates.length || !session.cwd || !isNewestSessionInDir(session.filePath)) return "";
  const targetCwd = path.resolve(session.cwd);
  try {
    const pids = candidates.map((item) => item.pid).join(",");
    const lsofOut = execFileSync("lsof", ["-a", "-d", "cwd", "-p", pids, "-Fn"], { encoding: "utf8" });
    let currentPid = "";
    for (const line of lsofOut.split("\n")) {
      if (line.startsWith("p")) currentPid = line.slice(1).trim();
      else if (line.startsWith("n") && currentPid) {
        if (path.resolve(line.slice(1).trim()) === targetCwd) {
          const hit = candidates.find((item) => item.pid === currentPid);
          if (hit) return `/dev/${hit.tty}`;
        }
      }
    }
  } catch {
    // Ignore if lsof fails.
  }
  return "";
}

function isNewestSessionInDir(filePath) {
  if (!filePath) return false;
  const dir = path.dirname(filePath);
  let targetMtime = 0;
  try {
    targetMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return false;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    if (full === filePath) continue;
    try {
      if (fs.statSync(full).mtimeMs > targetMtime) return false;
    } catch {
      // Ignore a disappearing file.
    }
  }
  return true;
}

function pasteIntoTerminal(tty, prompt) {
  const host = terminalHost(tty);
  const promptPath = path.join(os.tmpdir(), `agent-sessions-prompt-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptPath, prompt);
  const script = host === "iTerm2" ? itermPasteScript : terminalPasteScript;
  const appName = host === "iTerm2" ? "iTerm" : "Terminal";
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script, tty, promptPath]);
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Could not paste into the terminal. Allow Cursor to control ${appName}.`));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(promptPath, { force: true });
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Failed to paste into the terminal"));
    });
  });
}

function terminalHost(tty) {
  const name = path.basename(String(tty || ""));
  let pid = "";
  try {
    pid = execFileSync("ps", ["-t", name, "-o", "pid="], { encoding: "utf8" }).trim().split("\n")[0].trim();
  } catch {
    return "Terminal";
  }
  const seen = new Set();
  while (pid && pid !== "0" && pid !== "1" && !seen.has(pid)) {
    seen.add(pid);
    let row = "";
    try {
      row = execFileSync("ps", ["-p", pid, "-o", "ppid=,command="], { encoding: "utf8" });
    } catch {
      break;
    }
    if (/iTerm/i.test(row)) return "iTerm2";
    if (/Terminal\.app/i.test(row)) return "Terminal";
    const parent = row.trim().split(/\s+/)[0];
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return "Terminal";
}

const itermPasteScript = `
on run argv
  set ttyName to item 1 of argv
  set promptText to read POSIX file (item 2 of argv) as «class utf8»
  tell application "iTerm2"
    set found to false
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set tabTty to tty of s as text
          if tabTty is ttyName or tabTty is ("/dev/" & ttyName) or ("/dev/" & tabTty) is ttyName then
            select w
            select t
            select s
            set found to true
            exit repeat
          end if
        end repeat
        if found then exit repeat
      end repeat
      if found then exit repeat
    end repeat
    if found is false then error "Could not find the iTerm tab for this session"
    activate
  end tell
  set oldClip to the clipboard
  set the clipboard to promptText
  delay 0.35
  tell application "System Events"
    tell process "iTerm2"
      set frontmost to true
      keystroke "v" using command down
      delay 0.25
      key code 36
    end tell
  end tell
  try
    set the clipboard to oldClip
  end try
end run
`;

const terminalPasteScript = `
on run argv
  set ttyName to item 1 of argv
  set promptText to read POSIX file (item 2 of argv) as «class utf8»
  tell application "Terminal"
    set found to false
    repeat with w in windows
      set n to count of tabs of w
      repeat with i from 1 to n
        set tabTty to tty of tab i of w as text
        if tabTty is ttyName or tabTty is ("/dev/" & ttyName) or ("/dev/" & tabTty) is ttyName then
          set index of w to 1
          set selected tab of w to tab i of w
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found is false then error "Could not find the Terminal tab for this session"
    activate
  end tell
  set oldClip to the clipboard
  set the clipboard to promptText
  delay 0.35
  tell application "System Events"
    tell process "Terminal"
      set frontmost to true
      keystroke "v" using command down
      delay 0.25
      key code 36
    end tell
  end tell
  try
    set the clipboard to oldClip
  end try
end run
`;

function ensureSnapshot(context, file, record, source) {
  const current = record.current;
  if (!current.comments.length) return false;
  if (current.baseHash && current.baseHash !== hashText(source)) return false;
  if (current.snapshot && fs.existsSync(current.snapshot)) return false;
  const dir = path.join(context.globalStorageUri.fsPath, "snapshots", encodeKey(file));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(dest, source);
  current.snapshot = dest;
  if (!current.baseHash) current.baseHash = hashText(source);
  return true;
}

function recordPath(context, file) {
  return path.join(context.globalStorageUri.fsPath, "comments", `${encodeKey(file)}.json`);
}

function readRecord(context, file) {
  try {
    return normalizeRecord(JSON.parse(fs.readFileSync(recordPath(context, file), "utf8")));
  } catch {
    return normalizeRecord(null);
  }
}

function writeRecord(context, file, record) {
  const target = recordPath(context, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(record, null, 2));
  return Promise.resolve();
}

function encodeKey(file) {
  return Buffer.from(file).toString("base64url");
}

function isTextFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function isMarkdown(file) {
  return /\.(md|markdown|mdx)$/i.test(file);
}

function isMathWhitespace(char) {
  return char !== undefined && /^\s$/u.test(char);
}

function isMathWordOrNumber(char) {
  return char !== undefined && /^[\w\d]$/u.test(char);
}

function isValidInlineMathDelim(state, pos) {
  const prevChar = state.src[pos - 1];
  const char = state.src[pos];
  const nextChar = state.src[pos + 1];
  if (char !== "$") return { can_open: false, can_close: false };
  const canOpen = prevChar !== "$" && prevChar !== "\\" && nextChar !== undefined && !isMathWhitespace(nextChar) && (prevChar === undefined || isMathWhitespace(prevChar) || !isMathWordOrNumber(prevChar));
  const canClose = nextChar !== "$" && prevChar !== undefined && !isMathWhitespace(prevChar) && (nextChar === undefined || isMathWhitespace(nextChar) || !isMathWordOrNumber(nextChar));
  return { can_open: canOpen, can_close: canClose };
}

function isValidBlockMathDelim(state, pos) {
  const prevChar = state.src[pos - 1];
  const char = state.src[pos];
  const nextChar = state.src[pos + 1];
  const nextCharPlus1 = state.src[pos + 2];
  if (char === "$" && prevChar !== "$" && prevChar !== "\\" && nextChar === "$" && nextCharPlus1 !== "$") {
    return { can_open: true, can_close: true };
  }
  return { can_open: false, can_close: false };
}

function parseInlineMath(state, silent) {
  if (state.src.startsWith("\\(", state.pos)) {
    const start = state.pos + 2;
    const match = state.src.indexOf("\\)", start);
    if (match === -1) return false;
    if (!silent && match > start) {
      const token = state.push("math_inline", "math", 0);
      token.markup = "\\(";
      token.content = state.src.slice(start, match);
    }
    state.pos = match + 2;
    return true;
  }
  if (state.src.startsWith("\\[", state.pos)) {
    const start = state.pos + 2;
    const match = state.src.indexOf("\\]", start);
    if (match === -1) return false;
    if (!silent && match > start) {
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.markup = "\\[";
      token.content = state.src.slice(start, match);
    }
    state.pos = match + 2;
    return true;
  }
  if (state.src[state.pos] !== "$") return false;
  let res = isValidInlineMathDelim(state, state.pos);
  if (!res.can_open) {
    if (!silent) state.pending += "$";
    state.pos += 1;
    return true;
  }
  const start = state.pos + 1;
  let match = start;
  while ((match = state.src.indexOf("$", match)) !== -1) {
    if (state.src.indexOf("\n", start) !== -1 && state.src.indexOf("\n", start) < match) {
      match = -1;
      break;
    }
    let pos = match - 1;
    while (state.src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) break;
    match += 1;
  }
  if (match === -1) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (match - start === 0) {
    if (!silent) state.pending += "$$";
    state.pos = start + 1;
    return true;
  }
  res = isValidInlineMathDelim(state, match);
  if (!res.can_close) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

function parseInlineMathBlock(state, silent) {
  if (state.src.slice(state.pos, state.pos + 2) !== "$$") return false;
  let res = isValidBlockMathDelim(state, state.pos);
  if (!res.can_open) {
    if (!silent) state.pending += "$$";
    state.pos += 2;
    return true;
  }
  const start = state.pos + 2;
  let match = start;
  while ((match = state.src.indexOf("$$", match)) !== -1) {
    let pos = match - 1;
    while (state.src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) break;
    match += 2;
  }
  if (match === -1) {
    if (!silent) state.pending += "$$";
    state.pos = start;
    return true;
  }
  if (match - start === 0) {
    if (!silent) state.pending += "$$$$";
    state.pos = start + 2;
    return true;
  }
  res = isValidBlockMathDelim(state, match);
  if (!res.can_close) {
    if (!silent) state.pending += "$$";
    state.pos = start;
    return true;
  }
  if (!silent) {
    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.markup = "$$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 2;
  return true;
}

function parseBlockMath(state, start, end, silent) {
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (pos + 2 > max) return false;
  const openDelim = state.src.slice(pos, pos + 2);
  if (openDelim !== "$$" && openDelim !== "\\[") return false;
  const closeDelim = openDelim === "$$" ? "$$" : "\\]";
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let found = false;
  if (firstLine.trim().endsWith(closeDelim)) {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }
  if (silent) return true;
  let lastLine = "";
  let next = start;
  for (; !found;) {
    next += 1;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    const lineText = state.src.slice(pos, max);
    if (lineText.trim().endsWith(closeDelim)) {
      const lastPos = state.src.slice(0, max).lastIndexOf(closeDelim);
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }
  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = (firstLine && firstLine.trim() ? `${firstLine}\n` : "")
    + state.getLines(start + 1, next, state.tShift[start], true)
    + (lastLine && lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = openDelim;
  return true;
}

function renderKatexHtml(latex, displayMode) {
  try {
    return katex.renderToString(latex, {
      displayMode: Boolean(displayMode),
      throwOnError: false,
      strict: false,
      trust: true,
      output: "html",
    });
  } catch {
    return escapeHtml(latex);
  }
}

function createMarkdownEngine() {
  const engine = new MarkdownIt({ html: false, linkify: true, breaks: false });
  const origScanDelims = engine.inline.State.prototype.scanDelims;
  engine.inline.State.prototype.scanDelims = function (start, canSplitWord) {
    const res = origScanDelims.call(this, start, canSplitWord);
    if (canSplitWord && (!res.can_open || !res.can_close)) {
      const max = this.posMax;
      const marker = this.src.charCodeAt(start);
      let pos = start;
      while (pos < max && this.src.charCodeAt(pos) === marker) pos += 1;
      const lastChar = start > 0 ? this.src.charCodeAt(start - 1) : 32;
      const nextChar = pos < max ? this.src.charCodeAt(pos) : 32;
      const isCjkOrFullwidth = (c) => c >= 0x2000;
      if (!this.md.utils.isWhiteSpace(nextChar) && (isCjkOrFullwidth(lastChar) || isCjkOrFullwidth(nextChar))) res.can_open = true;
      if (!this.md.utils.isWhiteSpace(lastChar) && (isCjkOrFullwidth(lastChar) || isCjkOrFullwidth(nextChar))) res.can_close = true;
    }
    return res;
  };
  engine.inline.ruler.after("escape", "math_inline_block", parseInlineMathBlock);
  engine.inline.ruler.after("escape", "math_inline", parseInlineMath);
  engine.block.ruler.after("blockquote", "math_block", parseBlockMath, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  engine.renderer.rules.math_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    const displayMode = /\\begin\{(align|equation|gather|cd|alignat)\}/i.test(content);
    return renderKatexHtml(content, displayMode);
  };
  engine.renderer.rules.math_block = (tokens, idx) => `<div class="katex-block">${renderKatexHtml(tokens[idx].content, true)}</div>\n`;
  return engine;
}

function renderText(source) {
  return source.split("\n").map((line, index) => {
    const body = line.length ? escapeHtml(line) : " ";
    return `<section class="block line" data-start="${index}" data-end="${index + 1}"><span class="ln">${index + 1}</span><span class="src">${body}</span></section>`;
  }).join("");
}

function renderMarkdown(source) {
  const tokens = md.parse(String(source || ""), {});
  const parts = [];
  let buf = [];
  let map = null;
  const flush = () => {
    if (!buf.length) return;
    const html = md.renderer.render(buf, md.options, {}).replace(/(<code\b[^>]*>[\s\S]*?<\/code>)|&lt;br\s*\/?&gt;/gi, (m, code) => code || "<br>");
    if (map) parts.push(`<section class="block md-block" data-start="${map[0]}" data-end="${map[1]}">${html}</section>`);
    else if (html.trim()) parts.push(`<section class="block md-block">${html}</section>`);
    buf = [];
    map = null;
  };
  for (const token of tokens) {
    const opens = token.level === 0 && token.map && buf.length > 0 && (token.type.endsWith("_open") || token.type === "fence" || token.type === "hr");
    if (opens) flush();
    if (!map && token.map) map = [token.map[0], token.map[1]];
    buf.push(token);
  }
  flush();
  return parts.join("\n");
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function locateQuote(source, quote, hint) {
  const exact = [];
  let from = 0;
  while (quote && from <= source.length) {
    const at = source.indexOf(quote, from);
    if (at < 0) break;
    exact.push(at);
    from = at + quote.length;
  }
  let start = exact[0];
  if (hint && exact.length) {
    const range = lineRange(source, hint.startLine, hint.endLine);
    start = exact.find((index) => index >= range.start && index < range.end) ?? exact[0];
  }
  if (start === undefined) return null;
  const end = start + quote.length;
  return {
    excerpt: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - 40), start),
    suffix: source.slice(end, end + 40),
  };
}

function lineRange(source, startLine, endLine) {
  const lines = source.split("\n");
  let start = 0;
  for (let i = 0; i < startLine && i < lines.length; i += 1) start += lines[i].length + 1;
  let end = start;
  for (let i = startLine; i < endLine && i < lines.length; i += 1) end += lines[i].length + 1;
  return { start, end: end > start ? end : source.length };
}

function htmlFor(context, webview) {
  const css = fs.readFileSync(path.join(context.extensionPath, "media", "fileview.css"), "utf8");
  const script = fs.readFileSync(path.join(context.extensionPath, "media", "fileview.js"), "utf8");
  const nonce = crypto.randomUUID();
  const katexCssFile = path.join(context.extensionPath, "node_modules", "katex", "dist", "katex.min.css");
  const katexCssSrc = fs.existsSync(katexCssFile)
    ? String(webview.asWebviewUri(vscode.Uri.file(katexCssFile))).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    : "";
  const katexCss = katexCssSrc ? `<link rel="stylesheet" href="${katexCssSrc}" />` : "";
  const mermaidFile = path.join(context.extensionPath, "media", "mermaid.min.js");
  const mermaidSrc = fs.existsSync(mermaidFile)
    ? String(webview.asWebviewUri(vscode.Uri.file(mermaidFile))).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    : "";
  const mermaid = mermaidSrc ? `<script nonce="${nonce}" src="${mermaidSrc}"></script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};" />
${katexCss}
<style>${css}</style>
</head>
<body>
<header>
  <div id="file"></div>
  <div id="session"></div>
  <div class="find-row">
    <input id="find" type="search" placeholder="Search file (⌘F)" />
    <span id="find-count"></span>
    <button id="find-prev" type="button" title="Previous match (Shift+Enter)">Prev</button>
    <button id="find-next" type="button" title="Next match (Enter)">Next</button>
  </div>
  <button id="send" type="button">Send to this turn</button>
  <button id="diff" type="button">View changes</button>
</header>
<p id="notice"></p>
<main>
  <article id="doc"></article>
  <aside>
    <h2>Comments</h2>
    <label id="version-row" hidden>
      <span class="version-label">Review</span>
      <select id="version"></select>
    </label>
    <div id="comments"></div>
  </aside>
</main>
${mermaid}
<div id="menu" hidden>
  <button id="menu-comment" type="button">Comment</button>
</div>
<div id="popover" hidden>
  <blockquote id="pending-quote"></blockquote>
  <textarea id="body" rows="3" placeholder="Write a comment on this selection"></textarea>
  <div class="popover-actions">
    <button id="cancel" type="button">Cancel</button>
    <button id="save" type="button">Add</button>
  </div>
</div>
<div id="diagram" hidden>
  <div class="diagram-bar">
    <span class="diagram-hint">Scroll to zoom · Drag to pan · Double-click to reset</span>
    <div class="diagram-actions">
      <button id="diagram-zoom-out" type="button" title="Zoom out (-)">−</button>
      <button id="diagram-zoom-reset" type="button" title="Reset zoom (0)">100%</button>
      <button id="diagram-zoom-in" type="button" title="Zoom in (+)">+</button>
      <button id="diagram-close" type="button" title="Close (Esc)">Close</button>
    </div>
  </div>
  <div id="diagram-stage"></div>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { openReviewedFile, reviveReviewedFilePanel, liveTty, hasOmpProcess, pasteIntoTerminal, noteInputFocus, selectAllInInput, focusFindInFileView };
