const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const vscode = require("vscode");
const { listSessions, refreshSessionMeta, createTranscriptReader, readTranscript, snapshotTranscript, buildFileDiff, ompRoots, hasConversationEntries, hasClaudeProcess } = require("./sources");
const { openReviewedFile, reviveReviewedFilePanel, liveTty, pasteIntoTerminal, resumeSessionInTerminal, noteInputFocus, selectAllInInput, focusFindInFileView } = require("./review");
const { panelIsOpen, releaseClosedPanel, formatStatusText } = require("./panel-life");

const SCAN_MS = 60_000;
const PROBE_MS = 2_000;
const QUIET_MS = 15_000;
const WAITING_MS = 2 * 60_000;

let panel;
let sessions = [];
let openKey = "";
let scanTimer;
let follow;
let extensionContext;
let statusItem;
let seenSizes = {};
let hasBaseline = false;
let catalogTimer;
let postTimer;
const activity = new Map();
const activityTimers = new Map();
const libraryWatchers = new Map();
const sessionPatches = new Map();

function activate(context) {
  extensionContext = context;
  seenSizes = { ...(context.globalState.get("seenSizes") || {}) };
  hasBaseline = context.globalState.get("activityBaseline") === true;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem = status;
  status.text = formatStatusText(0, 0);
  status.tooltip = "Open Session Library (Cmd+Alt+S / Ctrl+Alt+S) — Browse OMP and Claude Code sessions";
  status.command = "agentSessions.open";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("agentSessions.open", () => openPanel(context, true)),
    vscode.commands.registerCommand("agentSessions.selectAll", () => selectAllInInput()),
    vscode.commands.registerCommand("agentSessions.find", () => {
      if (focusFindInFileView()) return;
      if (panel && panelIsOpen(panel)) void panel.webview.postMessage({ type: "focusFind" });
    }),
    ...(typeof vscode.window.registerWebviewPanelSerializer === "function"
      ? [
          vscode.window.registerWebviewPanelSerializer("agentSessions", {
            async deserializeWebviewPanel(restoredPanel) {
              adoptLibraryPanel(context, restoredPanel);
            },
          }),
          vscode.window.registerWebviewPanelSerializer("agentSessionsFile", {
            async deserializeWebviewPanel(restoredPanel, state) {
              await reviveReviewedFilePanel(context, restoredPanel, state);
            },
          }),
        ]
      : []),
    {
      dispose: () => {
        clearInterval(scanTimer);
        clearTimeout(catalogTimer);
        clearTimeout(postTimer);
        for (const timer of activityTimers.values()) clearTimeout(timer);
        for (const watcher of libraryWatchers.values()) watcher.close();
        stopFollow();
      },
    }
  );

  scanTimer = setInterval(() => {
    refresh();
    postSessions();
  }, SCAN_MS);

  refresh();
  if (!context.globalState.get("autoOpened")) {
    context.globalState.update("autoOpened", true);
    openPanel(context, true);
  }
}

function releaseLibrary() {
  panel = undefined;
  openKey = "";
  postedReply = "";
  stopFollow();
}

function openPanel(context, reveal) {
  if (panel && !panelIsOpen(panel)) releaseLibrary();
  if (panel) {
    if (reveal) panel.reveal(vscode.ViewColumn.Active);
    postSessions();
    return;
  }
  const created = vscode.window.createWebviewPanel(
    "agentSessions",
    "Sessions",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  adoptLibraryPanel(context, created);
}

function adoptLibraryPanel(context, targetPanel) {
  panel = targetPanel;
  const webview = panel.webview;
  webview.options = { enableScripts: true };
  webview.html = htmlFor(context, webview);
  webview.onDidReceiveMessage((message) => {
    if (message.type === "inputFocus") noteInputFocus(webview, message.focused === true);
    if (message.type === "ready") {
      postMascotState();
      postSessions();
    }
    if (message.type === "open") openSession(message.key);
    if (message.type === "refresh") {
      refresh();
      postSessions();
    }
    if (message.type === "openLink") openLink(message.href);
    if (message.type === "reply") void replyToSession(message.text);
    if (message.type === "copyReply") void copyReplyToClipboard(message.text);
    if (message.type === "resumeSession") void resumeSession(message.key || openKey);
    if (message.type === "fileDiff") postFileDiff(message.path);
    if (message.type === "hide") hideSession(message.key);
    if (message.type === "unhide") unhideSession(message.key);
    if (message.type === "deleteSession") deleteSession(message.key);
    if (message.type === "pickMascotImage") void pickMascotImage(message.target);
    if (message.type === "resetMascotImages") void resetMascotImages();
    if (message.type === "saveMascotPrefs") void saveMascotPrefs(message.prefs);
  });
  panel.onDidDispose(() => {
    releaseClosedPanel(releaseLibrary, () => noteInputFocus(webview, false));
    if (!context.globalState.get("reopenHintShown")) {
      void context.globalState.update("reopenHintShown", true);
      void vscode.window
        .showInformationMessage(
          "Sessions closed. Reopen anytime from the bottom-left 'Sessions' status bar button, the top-right editor bar icon, or Cmd+Alt+S (Ctrl+Alt+S).",
          "Reopen Sessions"
        )
        .then((choice) => {
          if (choice === "Reopen Sessions") openPanel(context, true);
        });
    }
  });
}

function refresh() {
  const previous = sessions.find((session) => session.key === openKey);
  const folders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  try {
    sessions = listSessions(folders);
  } catch (error) {
    console.error("Failed to index sessions", error);
    sessions = [];
  }
  reconcileActivity();
  watchLibraries();
  const next = sessions.find((session) => session.key === openKey);
  const changed = Boolean(previous && next && (next.mtime !== previous.mtime || next.size !== previous.size));
  if (follow && next && follow.filePath === next.filePath && !(changed && follow.reader)) follow.size = next.size;
  if (changed) {
    if (follow?.filePath === next.filePath && follow.reader) scheduleLive();
    else {
      openSession(openKey, { live: true, following: Boolean(follow?.watcher) });
      if (follow && !follow.watcher) attachWatch();
    }
  }
  postReplyState();
}

function postSessions() {
  const hidden = hiddenSet();
  for (const session of sessions) {
    session.activity = activity.get(session.key)?.state || "";
    session.hidden = hidden.has(session.key);
  }
  updateStatus();
  if (!panel) return;
  if (!panelIsOpen(panel)) {
    releaseLibrary();
    return;
  }
  panel.webview.postMessage({ type: "sessions", sessions });
}

function hiddenSet() {
  return new Set(extensionContext?.globalState.get("hiddenSessions") || []);
}

async function rememberHidden(keys) {
  await extensionContext.globalState.update("hiddenSessions", [...keys]);
}

async function hideSession(key) {
  const hidden = hiddenSet();
  hidden.add(String(key || ""));
  await rememberHidden(hidden);
  if (openKey === key) closeOpenSession();
  postSessions();
}

async function unhideSession(key) {
  const hidden = hiddenSet();
  hidden.delete(String(key || ""));
  await rememberHidden(hidden);
  postSessions();
}

function closeOpenSession() {
  openKey = "";
  postedReply = "";
  stopFollow();
  panel?.webview.postMessage({ type: "closed" });
}

function sessionIsLive(session) {
  if (liveTty(session)) return true;
  if (session.source === "omp") return false;
  if (session.source !== "claude") return true;
  const id = path.basename(session.filePath, ".jsonl");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  try {
    const commands = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8", maxBuffer: 4_000_000 });
    return commands.split("\n").some((line) => line.includes(id) && hasClaudeProcess(line));
  } catch {
    return true;
  }
}

function trashTargets(session) {
  const home = os.homedir();
  const roots = [
    path.join(home, ".omp", "agent", "sessions"),
    path.join(home, ".omp", "agent", "terminal-sessions"),
    path.join(home, ".claude", "projects"),
  ];
  const allowed = (target) => {
    const resolved = path.resolve(target);
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };
  const targets = [];
  const add = (target) => {
    if (!target || !allowed(target) || !fs.existsSync(target) || targets.includes(target)) return;
    targets.push(target);
  };
  add(session.filePath);
  add(session.filePath.replace(/\.jsonl$/, ""));
  if (session.source === "omp") {
    const dir = path.join(home, ".omp", "agent", "terminal-sessions");
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, name);
      try {
        if (fs.readFileSync(file, "utf8").includes(session.filePath)) add(file);
      } catch {
        // Skip a mapping file that cannot be read.
      }
    }
  }
  return targets;
}

async function deleteSession(key) {
  const session = sessions.find((item) => item.key === key);
  if (!session) return;
  if (sessionIsLive(session)) {
    void vscode.window.showWarningMessage("This window is still open. Close it before deleting the session.");
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Move "${session.title}" from ${session.sourceLabel} to the Trash? It will also leave the list.`,
    { modal: true },
    "Move to Trash"
  );
  if (choice !== "Move to Trash") return;
  if (sessionIsLive(session)) {
    void vscode.window.showWarningMessage("This window is still open. Close it before deleting the session.");
    return;
  }
  const targets = trashTargets(session);
  if (!targets.length) {
    void vscode.window.showWarningMessage("No session record found to delete.");
    return;
  }
  for (const target of targets) {
    await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
  }
  const hidden = hiddenSet();
  hidden.delete(session.key);
  await rememberHidden(hidden);
  sessionPatches.delete(session.key);
  if (openKey === session.key) closeOpenSession();
  refresh();
  postSessions();
}

function postSessionsSoon() {
  clearTimeout(postTimer);
  postTimer = setTimeout(postSessions, 300);
}

function openSession(key, options = {}) {
  const session = sessions.find((item) => item.key === key);
  if (!session || !panel) return;
  openKey = key;
  if (!options.live) {
    ensureFollow(session);
    follow.reader = createTranscriptReader(session.filePath, session.source);
    follow.view = null;
    markSeen(session);
    postSessions();
  }
  try {
    postTranscript(session, options);
  } catch (error) {
    panel.webview.postMessage({
      type: "transcript",
      key,
      transcript: { title: session.title, omitted: 0, turns: [{ role: "assistant", text: error.message, thinking: "", tools: [] }] },
    });
  }
}

function postTranscript(session, options) {
  if (!follow || follow.filePath !== session.filePath || !follow.reader) {
    if (!follow || follow.filePath !== session.filePath) ensureFollow(session);
    follow.reader = createTranscriptReader(session.filePath, session.source);
    follow.view = null;
  }
  readTranscript(follow.reader);
  const next = snapshotTranscript(follow.reader);
  if (next.stats) Object.assign(session, next.stats);
  const patch = options.live ? diffTranscript(follow.view, next) : { full: true };
  follow.view = {
    title: next.title,
    omitted: next.omitted,
    files: next.files,
    turns: next.turns,
    sigs: next.turns.map(turnSignature),
  };
  sessionPatches.set(session.key, next.patches || []);
  const reply = replyState(session);
  const following = options.following === true || Boolean(follow.watcher);
  if (!patch.full) {
    panel.webview.postMessage({
      type: "transcriptPatch",
      key: session.key,
      dropped: patch.dropped,
      updates: patch.updates,
      appended: patch.appended,
      omitted: next.omitted,
      title: next.title,
      files: patch.files,
      stats: next.stats,
      live: true,
      following,
    });
    return;
  }
  postedReply = `${session.key}\n${reply.canReply}\n${reply.hint}`;
  panel.webview.postMessage({
    type: "transcript",
    key: session.key,
    transcript: {
      title: next.title,
      omitted: next.omitted,
      files: next.files,
      stats: next.stats,
      turns: next.turns,
    },
    live: options.live === true,
    following,
    canReply: reply.canReply,
    replyHint: reply.hint,
  });
}

function diffTranscript(prev, next) {
  if (!prev) return { full: true };
  const prevTurns = prev.turns;
  const nextTurns = next.turns;
  let dropped = 0;
  while (dropped < prevTurns.length && !nextTurns.includes(prevTurns[dropped])) dropped += 1;
  const kept = prevTurns.length - dropped;
  for (let index = 0; index < kept; index += 1) {
    if (nextTurns[index] !== prevTurns[dropped + index]) return { full: true };
  }
  if (nextTurns.length < kept) return { full: true };
  const updates = [];
  for (let index = 0; index < kept; index += 1) {
    if (turnSignature(nextTurns[index]) !== prev.sigs[dropped + index]) updates.push({ index, turn: nextTurns[index] });
  }
  const appended = nextTurns.slice(kept);
  const files = filesSignature(prev.files) === filesSignature(next.files) ? undefined : next.files;
  return { full: false, dropped, updates, appended, files };
}

function turnSignature(turn) {
  const tools = (turn.tools || []).map((tool) => `${tool.id}\u0001${tool.name}\u0001${tool.isError ? 1 : 0}\u0001${tool.output || ""}`).join("\u0002");
  return `${turn.role}\u0001${turn.text || ""}\u0001${turn.thinking || ""}\u0001${tools}`;
}

function filesSignature(files) {
  return (files || []).map((file) => `${file.path}\u0001${file.additions}\u0001${file.deletions}`).join("\n");
}

function postFileDiff(target) {
  if (!panel || !openKey) return;
  const diff = buildFileDiff(sessionPatches.get(openKey) || [], String(target || ""));
  panel.webview.postMessage({ type: "fileDiff", path: String(target || ""), ...diff });
}

let postedReply = "";

function postReplyState() {
  if (!panel || !openKey) return;
  const session = sessions.find((item) => item.key === openKey);
  const reply = replyState(session);
  const token = `${openKey}\n${reply.canReply}\n${reply.hint}`;
  if (token === postedReply) return;
  postedReply = token;
  panel.webview.postMessage({ type: "replyState", canReply: reply.canReply, replyHint: reply.hint });
}

function replyState(session) {
  if (!session || (session.source !== "omp" && session.source !== "claude")) {
    return { canReply: false, hint: "Select a session. Replies are sent to its open window." };
  }
  const label = session.sourceLabel || (session.source === "claude" ? "Claude Code" : "OMP");
  if (!liveTty(session)) {
    return { canReply: false, hint: `That ${label} window is not open. Click "Resume in Terminal" to reopen it.` };
  }
  return { canReply: true, hint: `Reply here to send it to the open ${label} window. Press Enter to send.` };
}

async function replyToSession(text) {
  const body = String(text || "").trim();
  if (!body || !panel) return;
  const session = sessions.find((item) => item.key === openKey);
  const reply = replyState(session);
  if (!reply.canReply) {
    panel.webview.postMessage({ type: "replyResult", ok: false, sent: false, notice: reply.hint });
    return;
  }
  const label = session.sourceLabel || (session.source === "claude" ? "Claude Code" : "OMP");
  try {
    await pasteIntoTerminal(liveTty(session), body);
    panel.webview.postMessage({
      type: "replyResult",
      ok: true,
      sent: true,
      notice: `Sent to the open ${label} window.`,
    });
  } catch (error) {
    panel.webview.postMessage({
      type: "replyResult",
      ok: false,
      sent: false,
      notice: error instanceof Error ? error.message : String(error),
    });
  }
}

async function copyReplyToClipboard(text) {
  if (!panel) return;
  const raw = String(text ?? "");
  if (!raw.trim()) {
    panel.webview.postMessage({
      type: "replyCopyResult",
      ok: false,
      notice: "Write a reply before copying.",
    });
    return;
  }
  try {
    await vscode.env.clipboard.writeText(raw);
    panel.webview.postMessage({
      type: "replyCopyResult",
      ok: true,
      notice: "Copied reply to clipboard. Paste it into your terminal window.",
    });
  } catch (error) {
    panel.webview.postMessage({
      type: "replyCopyResult",
      ok: false,
      notice: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resumeSession(key) {
  const targetKey = String(key || openKey || "");
  const session = sessions.find((item) => item.key === targetKey);
  if (!session) return;
  const label = session.sourceLabel || (session.source === "claude" ? "Claude Code" : "OMP");
  try {
    await resumeSessionInTerminal(session);
    if (openKey !== session.key) openSession(session.key);
    postedReply = "";
    postReplyState();
    setTimeout(() => postReplyState(), 1200);
    setTimeout(() => postReplyState(), 3000);
    if (panel && openKey === session.key) {
      panel.webview.postMessage({
        type: "replyResult",
        ok: true,
        sent: false,
        notice: `Opened ${label} session in the integrated terminal.`,
      });
    }
  } catch (error) {
    if (panel) {
      panel.webview.postMessage({
        type: "replyResult",
        ok: false,
        sent: false,
        notice: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function ensureFollow(session) {
  if (follow?.filePath === session.filePath) return;
  stopFollow();
  let size = session.size || 0;
  try {
    size = fs.statSync(session.filePath).size;
  } catch {
    // The catalog size is enough until the file reappears.
  }
  follow = { key: session.key, filePath: session.filePath, size };
  follow.probe = setInterval(() => probeFollow(), PROBE_MS);
}

function probeFollow() {
  if (!follow) return;
  postReplyState();
  let stat;
  try {
    stat = fs.statSync(follow.filePath);
  } catch {
    return;
  }
  if (stat.size <= follow.size) return;
  if (!follow.watcher) attachWatch();
  scheduleLive();
}

function attachWatch() {
  if (!follow || follow.watcher) return;
  try {
    follow.watcher = fs.watch(follow.filePath, () => scheduleLive());
  } catch {
    return;
  }
  panel?.webview.postMessage({ type: "follow", following: true });
}

function scheduleLive() {
  if (!follow) return;
  clearTimeout(follow.debounce);
  follow.debounce = setTimeout(flushLive, 250);
}

function flushLive() {
  if (!follow) return;
  const session = sessions.find((item) => item.key === follow.key);
  if (!session) return;
  let stat;
  try {
    stat = fs.statSync(follow.filePath);
  } catch {
    return;
  }
  if (stat.size < follow.size) follow.size = 0;
  if (stat.size === follow.size) {
    armQuiet();
    return;
  }
  follow.size = stat.size;
  session.mtime = stat.mtimeMs;
  session.size = stat.size;
  markRunning(session);
  openSession(follow.key, { live: true, following: true });
  postSessions();
  armQuiet();
}

function armQuiet() {
  if (!follow) return;
  clearTimeout(follow.quiet);
  follow.quiet = setTimeout(() => {
    if (!follow?.watcher) return;
    follow.watcher.close();
    follow.watcher = undefined;
    panel?.webview.postMessage({ type: "follow", following: false });
  }, QUIET_MS);
}

function stopFollow() {
  if (!follow) return;
  clearInterval(follow.probe);
  clearTimeout(follow.debounce);
  clearTimeout(follow.quiet);
  follow.watcher?.close();
  follow = undefined;
}

function libraryRoots() {
  return [...ompRoots(), path.join(os.homedir(), ".claude", "projects")];
}

function watchLibraries() {
  const wanted = new Set();
  for (const root of libraryRoots()) {
    if (!fs.existsSync(root)) continue;
    wanted.add(root);
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      try {
        if (fs.statSync(dir).isDirectory()) wanted.add(dir);
      } catch {
        // A project directory that disappeared between read and stat is skipped.
      }
    }
  }
  for (const session of sessions) {
    if (!session.filePath || !session.filePath.endsWith(".jsonl")) continue;
    const companion = session.filePath.slice(0, -6);
    try {
      if (fs.statSync(companion).isDirectory()) {
        wanted.add(companion);
        const subagentsDir = path.join(companion, "subagents");
        if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
          wanted.add(subagentsDir);
        }
      }
    } catch {
      // Companion directory is optional.
    }
  }
  for (const [dir, watcher] of libraryWatchers) {
    if (wanted.has(dir)) continue;
    watcher.close();
    libraryWatchers.delete(dir);
  }
  for (const dir of wanted) watchOne(dir);
}

function watchOne(dir) {
  if (libraryWatchers.has(dir) || !fs.existsSync(dir)) return;
  try {
    const watcher = fs.watch(dir, (_event, filename) => onLibraryEvent(dir, filename));
    libraryWatchers.set(dir, watcher);
  } catch {
    // A directory that cannot be watched still shows up on the minute scan.
  }
}

function onLibraryEvent(dir, filename) {
  const name = filename ? path.basename(String(filename)) : "";
  if (!name) {
    scheduleCatalog();
    return;
  }
  if (!name.endsWith(".jsonl")) {
    if (name.startsWith(".")) return;
    const full = path.join(dir, name);
    const isRootChild = libraryRoots().includes(dir);
    const isCompanion = sessions.some((item) => item.filePath === `${full}.jsonl` || full === path.join(item.filePath.slice(0, -6), "subagents"));
    if (!isRootChild && !isCompanion) return;
    try {
      if (fs.statSync(full).isDirectory()) {
        watchOne(full);
        scheduleCatalog();
      }
    } catch {
      // The new name can already be gone.
    }
    return;
  }
  const full = path.join(dir, name);
  const session = sessions.find(
    (item) => item.filePath === full || (item.filePath.endsWith(".jsonl") && full.startsWith(`${item.filePath.slice(0, -6)}${path.sep}`)),
  );
  if (session) {
    if (session.filePath === full) noteGrowth(session);
    else noteSubagentGrowth(session);
  } else {
    scheduleCatalog();
  }
}

function scheduleCatalog() {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => {
    refresh();
    postSessions();
  }, 2000);
}

function noteGrowth(session) {
  let stat;
  try {
    stat = fs.statSync(session.filePath);
  } catch {
    return;
  }
  if (stat.size === session.size) return;
  const grew = stat.size > session.size;
  refreshSessionMeta(session);
  if (!grew) {
    postSessionsSoon();
    return;
  }
  markRunning(session);
  if (follow?.filePath === session.filePath) {
    if (!follow.watcher) attachWatch();
    scheduleLive();
  }
  postSessionsSoon();
}

function noteSubagentGrowth(session) {
  const prevMtime = session.mtime;
  const prevTokens = session.totalTokens;
  const prevCost = session.cost;
  refreshSessionMeta(session);
  if (session.mtime === prevMtime && session.totalTokens === prevTokens && session.cost === prevCost) return;
  markRunning(session);
  if (openKey === session.key && panel && panelIsOpen(panel)) {
    postTranscript(session, { live: true, following: Boolean(follow?.watcher) });
  }
  postSessionsSoon();
}

function markRunning(session) {
  const current = activity.get(session.key);
  if (!current || current.state !== "running") activity.set(session.key, { state: "running", since: Date.now() });
  session.activity = "running";
  armActivityQuiet(session.key);
}

function markSeen(session) {
  seenSizes[session.key] = session.size;
  if (activity.get(session.key)?.state === "fresh") {
    activity.delete(session.key);
    session.activity = "";
  }
  persistSeen();
}

function armActivityQuiet(key) {
  clearTimeout(activityTimers.get(key));
  activityTimers.set(key, setTimeout(() => settleActivity(key), QUIET_MS));
}

function settleActivity(key) {
  activityTimers.delete(key);
  const info = activity.get(key);
  const session = sessions.find((item) => item.key === key);
  if (!info || info.state !== "running" || !session) return;
  let stat;
  try {
    stat = fs.statSync(session.filePath);
  } catch {
    return;
  }
  if (stat.size !== session.size) {
    refreshSessionMeta(session);
    if (follow?.filePath === session.filePath) scheduleLive();
    armActivityQuiet(key);
    postSessionsSoon();
    return;
  }
  const phase = tailPhase(session);
  if (phase === "busy" || phase === "unknown" || (phase === "waiting" && Date.now() - info.since < WAITING_MS)) {
    armActivityQuiet(key);
    return;
  }
  const seen = seenSizes[key] ?? 0;
  const reply = phase === "reply" && appendedConversation(session, seen);
  if (key === openKey || !reply || session.size <= seen) {
    seenSizes[key] = session.size;
    activity.delete(key);
    session.activity = "";
    persistSeen();
  } else {
    activity.set(key, { state: "fresh", since: Date.now() });
    session.activity = "fresh";
  }
  postSessions();
}

function appendedConversation(session, fromSize) {
  const entries = readAppendedEntries(session.filePath, fromSize);
  if (!entries) return true;
  return hasConversationEntries(session.source, entries);
}

function readAppendedEntries(filePath, fromSize) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (fromSize < 0 || fromSize > stat.size) return null;
  const delta = stat.size - fromSize;
  if (delta === 0) return [];
  if (delta > 1024 * 1024) return null;
  const fd = fs.openSync(filePath, "r");
  try {
    let start = fromSize;
    if (fromSize > 0) {
      const prev = Buffer.alloc(1);
      fs.readSync(fd, prev, 0, 1, fromSize - 1);
      if (prev[0] !== 10 && prev[0] !== 13) {
        const skip = Buffer.alloc(Math.min(delta, 64 * 1024));
        const n = fs.readSync(fd, skip, 0, skip.length, fromSize);
        const newline = skip.subarray(0, n).indexOf(10);
        if (newline < 0) return [];
        start = fromSize + newline + 1;
      }
    }
    const len = stat.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const entries = [];
    for (const line of buf.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // A torn last line is not a record.
      }
    }
    return entries;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function reconcileActivity() {
  let seenDirty = false;
  if (!hasBaseline) {
    for (const session of sessions) seenSizes[session.key] = session.size;
    hasBaseline = true;
    persistSeen();
  } else {
    for (const session of sessions) {
      const seen = seenSizes[session.key];
      if (seen == null) {
        noteUnseen(session);
        continue;
      }
      if (session.size <= seen || activity.get(session.key)?.state === "running") continue;
      if (!appendedConversation(session, seen)) {
        seenSizes[session.key] = session.size;
        activity.delete(session.key);
        seenDirty = true;
      } else if (Date.now() - session.mtime < QUIET_MS) {
        activity.set(session.key, { state: "running", since: session.mtime });
        armActivityQuiet(session.key);
      } else if (session.key === openKey) {
        seenSizes[session.key] = session.size;
      } else if (tailPhase(session) === "reply") {
        activity.set(session.key, { state: "fresh", since: session.mtime });
      } else {
        activity.set(session.key, { state: "running", since: session.mtime });
        armActivityQuiet(session.key);
      }
    }
  }
  for (const key of [...activity.keys()]) {
    if (!sessions.some((session) => session.key === key)) activity.delete(key);
  }
  for (const session of sessions) session.activity = activity.get(session.key)?.state || "";
  if (seenDirty) persistSeen();
}

function noteUnseen(session) {
  if (!(session.size > 0) || session.key === openKey) {
    seenSizes[session.key] = session.size;
    return;
  }
  const settled = Date.now() - session.mtime >= QUIET_MS && tailPhase(session) === "reply";
  if (settled) {
    activity.set(session.key, { state: "fresh", since: session.mtime });
    return;
  }
  activity.set(session.key, { state: "running", since: session.mtime || Date.now() });
  armActivityQuiet(session.key);
}

function persistSeen() {
  extensionContext?.globalState.update("seenSizes", seenSizes);
  extensionContext?.globalState.update("activityBaseline", true);
}

function updateStatus() {
  if (!statusItem) return;
  const folders = vscode.workspace.workspaceFolders || [];
  const pool = (folders.length ? sessions.filter((session) => session.inWorkspace) : sessions)
    .filter((session) => !session.hidden || session.activity === "fresh" || session.activity === "running");
  const running = pool.filter((session) => session.activity === "running").length;
  const fresh = pool.filter((session) => session.activity === "fresh").length;
  statusItem.text = formatStatusText(running, fresh);
}

function tailPhase(session) {
  let entries = [];
  try {
    entries = readTailEntries(session.filePath);
  } catch {
    return "unknown";
  }
  let phase = "unknown";
  if (session.source === "omp") phase = ompTailPhase(entries);
  else if (session.source === "claude") phase = claudeTailPhase(entries);
  if (phase === "unknown") {
    try {
      phase = peekLastRecordPhase(session.source, session.filePath);
    } catch {
      return "unknown";
    }
  }
  if (phase === "reply" && session.source === "omp" && ompChildrenRecent(session)) return "busy";
  return phase;
}

function readTailEntries(filePath) {
  const stat = fs.statSync(filePath);
  let len = Math.min(stat.size, 64 * 1024);
  const max = Math.min(stat.size, 512 * 1024);
  let entries = [];
  while (true) {
    entries = readTailSlice(filePath, stat.size, len);
    if (entries.length || len >= max) return entries;
    const next = Math.min(max, len * 4);
    if (next === len) return entries;
    len = next;
  }
}

function readTailSlice(filePath, size, len) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift();
    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // The last line can still be incomplete.
      }
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function peekLastRecordPhase(source, filePath) {
  const head = readLastRecordHead(filePath);
  if (!head) return "unknown";
  const tail = readFileEnding(filePath, 1200);
  if (source === "omp") return peekOmpPhase(head, tail);
  if (source === "claude") return peekClaudePhase(head, tail);
  return "unknown";
}

function peekOmpPhase(head, tail) {
  if (/"role"\s*:\s*"toolResult"/.test(head)) return "busy";
  if (/"customType"\s*:\s*"tool_execution_start"/.test(head)) return "busy";
  if (/"role"\s*:\s*"user"/.test(head)) return "waiting";
  if (/"role"\s*:\s*"assistant"/.test(head)) {
    if (/"stopReason"\s*:\s*"toolUse"/.test(tail) || /"type"\s*:\s*"toolCall"/.test(head)) return "busy";
    if (/"stopReason"\s*:\s*"(?:stop|end_turn)"/.test(tail)) return "reply";
    return "busy";
  }
  return "unknown";
}

function peekClaudePhase(head, tail) {
  if (/"type"\s*:\s*"tool_result"/.test(head)) return "busy";
  if (/"type"\s*:\s*"assistant"/.test(head) || /"role"\s*:\s*"assistant"/.test(head)) {
    if (/"stop_reason"\s*:\s*"tool_use"/.test(tail)) return "busy";
    if (/"stop_reason"\s*:\s*"(?:end_turn|stop_sequence)"/.test(tail)) return "reply";
    return "busy";
  }
  if (/"type"\s*:\s*"user"/.test(head)) return "waiting";
  return "unknown";
}

function readLastRecordHead(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    let pos = stat.size;
    const limit = Math.max(0, stat.size - 8 * 1024 * 1024);
    let start = 0;
    let found = false;
    while (pos > limit) {
      const len = Math.min(64 * 1024, pos - limit);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      let index = len - 1;
      if (pos + len === stat.size) {
        while (index >= 0 && (buf[index] === 10 || buf[index] === 13)) index -= 1;
      }
      for (; index >= 0; index -= 1) {
        if (buf[index] === 10) {
          start = pos + index + 1;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    const from = found ? start : limit;
    const len = Math.min(2000, stat.size - from);
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileEnding(filePath, len) {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, len);
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function ompChildrenRecent(session) {
  const dir = session.filePath.replace(/\.jsonl$/, "");
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const cutoff = Date.now() - WAITING_MS;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      if (fs.statSync(path.join(dir, name)).mtimeMs >= cutoff) return true;
    } catch {
      // A child record that cannot be stat'd does not keep the parent running.
    }
  }
  return false;
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content;
  if (content && typeof content === "object") return [content];
  return [];
}

function ompTailPhase(entries) {
  const pending = new Set();
  const started = new Set();
  let lastRole = "";
  let sawMessage = false;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "tool_execution_start" && entry.data?.toolCallId) {
      started.add(entry.data.toolCallId);
    }
    if (entry.type !== "message" || !entry.message) continue;
    sawMessage = true;
    const message = entry.message;
    lastRole = message.role || lastRole;
    if (message.role === "user") pending.clear();
    if (message.role === "assistant") {
      for (const block of contentBlocks(message.content)) {
        if (block.type === "toolCall" && block.id) pending.add(block.id);
      }
    }
    if (message.role === "toolResult" && message.toolCallId) {
      pending.delete(message.toolCallId);
      started.delete(message.toolCallId);
    }
  }
  if (pending.size || started.size || lastRole === "toolResult") return "busy";
  if (!sawMessage) return "unknown";
  if (lastRole === "user") return "waiting";
  return "reply";
}

function claudeTailPhase(entries) {
  let last = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "assistant" || entry.type === "user") {
      last = entry;
      break;
    }
  }
  if (!last) return "unknown";
  if (last.type === "assistant") {
    const reason = last.message?.stop_reason;
    if (!reason || reason === "tool_use") return "busy";
    return "reply";
  }
  const blocks = contentBlocks(last.message?.content);
  if (blocks.some((block) => block.type === "tool_result")) return "busy";
  return "waiting";
}

async function openLink(raw) {
  const href = String(raw || "").trim();
  if (/^https?:\/\/\S+$/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const location = fileLocation(href);
  if (!location) return;
  let stat;
  try {
    stat = fs.statSync(location.file);
  } catch {
    vscode.window.showWarningMessage(`File not found: ${location.file}`);
    return;
  }
  const uri = vscode.Uri.file(location.file);
  if (stat.isDirectory()) {
    await vscode.env.openExternal(uri);
    return;
  }
  const session = sessions.find((item) => item.key === openKey);
  try {
    await openReviewedFile(extensionContext, location, session);
  } catch {
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Active, preview: false });
  }
}

function fileLocation(href) {
  let file = "";
  let line = 0;
  let column = 0;
  if (/^file:\/\/\S+$/i.test(href)) {
    const stripped = stripLineSuffix(href);
    file = vscode.Uri.parse(stripped.file).fsPath;
    line = stripped.line;
    column = stripped.column;
  } else if (href.startsWith("~/")) {
    const stripped = stripLineSuffix(path.join(os.homedir(), href.slice(2)));
    file = stripped.file;
    line = stripped.line;
    column = stripped.column;
  } else if (isLocalPath(href)) {
    const stripped = stripLineSuffix(href);
    file = stripped.file;
    line = stripped.line;
    column = stripped.column;
  }
  if (!file || !file.startsWith("/") || file.includes("..")) return null;
  return { file, line, column };
}

function stripLineSuffix(value) {
  const match = /:(\d+)(?::(\d+))?$/.exec(value);
  if (!match || match.index === 0) return { file: value, line: 0, column: 0 };
  return { file: value.slice(0, match.index), line: Number(match[1]), column: Number(match[2] || 1) };
}

function isLocalPath(value) {
  const pathOnly = value.replace(/:\d+(?::\d+)?$/, "");
  if (!pathOnly.startsWith("/") || pathOnly.includes("..")) return false;
  if (/^\/(Users|Volumes|private|tmp|home|opt)\//.test(pathOnly)) return true;
  return /\/[^/]+\.[A-Za-z0-9]{1,12}$/.test(pathOnly);
}

function mascotDataUrl(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".svg" ? "image/svg+xml"
        : ext === ".webp" ? "image/webp"
          : ext === ".gif" ? "image/gif"
            : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : "image/png";
    const bytes = fs.readFileSync(filePath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

function currentMascotState() {
  const extPath = extensionContext ? extensionContext.extensionPath : __dirname;
  const defaultOmp = mascotDataUrl(path.join(extPath, "media", "mascot-omp.png"));
  const defaultOmpIdle = mascotDataUrl(path.join(extPath, "media", "mascot-omp-idle.png"));
  const defaultClaude = mascotDataUrl(path.join(extPath, "media", "mascot-claude.png"));
  const defaultClaudeIdle = mascotDataUrl(path.join(extPath, "media", "mascot-claude-idle.png"));
  const customOmp = extensionContext?.globalState.get("customMascotOmp") || "";
  const customClaude = extensionContext?.globalState.get("customMascotClaude") || "";
  const prefs = extensionContext?.globalState.get("mascotPrefs") || {};
  return {
    ompSrc: customOmp || defaultOmp,
    ompIdleSrc: customOmp || defaultOmpIdle || defaultOmp,
    claudeSrc: customClaude || defaultClaude,
    claudeIdleSrc: customClaude || defaultClaudeIdle || defaultClaude,
    hasCustom: Boolean(customOmp || customClaude),
    prefs,
  };
}

function postMascotState() {
  if (!panel || !panelIsOpen(panel)) return;
  panel.webview.postMessage({ type: "mascotState", ...currentMascotState() });
}

async function pickMascotImage(target) {
  if (target !== "omp" && target !== "claude") return;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: `Use as ${target === "omp" ? "OMP" : "Claude"} Mascot`,
    filters: { Images: ["png", "webp", "gif", "jpg", "jpeg", "svg"] },
  });
  if (!picked || !picked.length) return;
  const filePath = picked[0].fsPath;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stat.size > 4 * 1024 * 1024) {
    void vscode.window.showWarningMessage("Mascot image must be 4 MB or smaller.");
    return;
  }
  const dataUrl = mascotDataUrl(filePath);
  if (!dataUrl) return;
  const key = target === "omp" ? "customMascotOmp" : "customMascotClaude";
  await extensionContext?.globalState.update(key, dataUrl);
  postMascotState();
}

async function resetMascotImages() {
  await extensionContext?.globalState.update("customMascotOmp", "");
  await extensionContext?.globalState.update("customMascotClaude", "");
  postMascotState();
}

async function saveMascotPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  const prev = extensionContext?.globalState.get("mascotPrefs") || {};
  await extensionContext?.globalState.update("mascotPrefs", { ...prev, ...prefs });
}

function webviewAssetUri(context, webview, ...segments) {
  const file = path.join(context.extensionPath, ...segments);
  if (!fs.existsSync(file)) return "";
  return String(webview.asWebviewUri(vscode.Uri.file(file))).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function htmlFor(context, webview) {
  const css = fs.readFileSync(path.join(context.extensionPath, "media", "panel.css"), "utf8");
  const script = fs.readFileSync(path.join(context.extensionPath, "media", "panel.js"), "utf8");
  const nonce = String(Date.now());
  const katexCssSrc = webviewAssetUri(context, webview, "node_modules", "katex", "dist", "katex.min.css");
  const katexCss = katexCssSrc ? `<link rel="stylesheet" href="${katexCssSrc}" />` : "";
  const markdownItSrc = webviewAssetUri(context, webview, "node_modules", "markdown-it", "dist", "markdown-it.min.js");
  const markdownIt = markdownItSrc ? `<script nonce="${nonce}" src="${markdownItSrc}"></script>` : "";
  const katexJsSrc = webviewAssetUri(context, webview, "node_modules", "katex", "dist", "katex.min.js");
  const katexJs = katexJsSrc ? `<script nonce="${nonce}" src="${katexJsSrc}"></script>` : "";
  const mermaidSrc = webviewAssetUri(context, webview, "media", "mermaid.min.js");
  const mermaid = mermaidSrc ? `<script nonce="${nonce}" src="${mermaidSrc}"></script>` : "";
  const ompChartsSrc = webviewAssetUri(context, webview, "media", "omp-charts.min.js");
  const ompCharts = ompChartsSrc ? `<script nonce="${nonce}" src="${ompChartsSrc}"></script>` : "";
  return `<!DOCTYPE html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  ${katexCss}
  <style>${css}</style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <h1>Sessions</h1>
      <button id="speeds-btn" type="button" title="Compare model token throughput (tok/s) and TTFT across sessions">Speeds</button>
    </div>
    <div class="controls">
      <div class="search-row">
        <input id="search" type="search" placeholder="Search titles" />
        <button id="refresh" type="button" title="Scan now. The library also scans about once a minute">Refresh</button>
      </div>
      <div class="chips">
        <button class="chip active" data-source="all">All</button>
        <button class="chip" data-source="omp">OMP</button>
        <button class="chip" data-source="claude">Claude Code</button>
      </div>
      <div class="chips">
        <button class="scope active" data-scope="workspace">This workspace</button>
        <button class="scope" data-scope="all">All workspaces</button>
      </div>
      <div class="chips">
        <button class="chip active" data-activity="all">Any</button>
        <button class="chip" data-activity="fresh">New reply</button>
        <button class="chip" data-activity="running">Running</button>
      </div>
    </div>
    <div id="attention" class="attention" hidden></div>
    <div id="list" class="list"></div>
  </aside>
  <main class="main">
    <header class="thread-head">
      <div class="thread-title-row">
        <h2 id="title">Select a session</h2>
        <button id="thread-resume" class="resume-btn" type="button" hidden title="Resume or focus this session in the integrated terminal">Resume in Terminal</button>
      </div>
      <div id="meta" class="meta"></div>
      <div class="find-row">
        <input id="find" type="search" placeholder="Search this session" />
        <span id="find-count"></span>
        <button id="find-prev" type="button" title="Previous match">Previous</button>
        <button id="find-next" type="button" title="Next match">Next</button>
      </div>
    </header>
    <div class="thread-wrap">
      <div id="thread" class="thread">
        <div class="empty">Select a session from the list.</div>
      </div>
      <button id="jump" type="button" hidden>Jump to bottom</button>
    </div>
    <section id="files" class="files" hidden></section>
    <section id="diffview" class="diffview" hidden></section>
    <form id="reply" class="reply">
      <textarea id="reply-text" rows="2" placeholder="Reply here to send it to the open terminal window"></textarea>
      <div class="reply-row">
        <span id="reply-notice">Select a session from the list.</span>
        <button id="reply-resume" class="resume-btn" type="button" hidden title="Reopen this session in a Cursor integrated terminal">Resume in Terminal</button>
        <button id="reply-copy" class="resume-btn" type="button" disabled title="Copy this reply to the clipboard">Copy reply</button>
        <button id="reply-send" type="submit">Send</button>
      </div>
    </form>
  </main>
  <div id="mascot-dock" class="mascot-dock"></div>
  <div id="mascot-menu" class="mascot-menu" hidden></div>
  <div id="speeds-modal" class="speeds-modal" hidden></div>
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
  ${markdownIt}
  ${katexJs}
  ${mermaid}
  ${ompCharts}
  <script nonce="${nonce}">${script}</script>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
