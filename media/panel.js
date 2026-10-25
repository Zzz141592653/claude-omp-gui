const vscode = acquireVsCodeApi();
const PATH_SEGMENT = "(?:[A-Za-z0-9_]|\\.[A-Za-z0-9_])[A-Za-z0-9._+-]*";
const RELATIVE_PATH = `(?<![\\w./])(?:\\.\\./|\\./)?(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}\\.[A-Za-z0-9]{1,12}(?::\\d+){0,2}`;
const ABSOLUTE_PATH = `(?<![\\w.~])~?/(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}(?::\\d+){0,2}`;
const state = {
  sessions: [],
  source: "all",
  scope: "workspace",
  activity: "all",
  query: "",
  find: "",
  hit: 0,
  selected: "",
  transcript: null,
  canReply: false,
  replying: false,
  copyingReply: false,
  diffMode: "split",
  diffData: null,
  showHidden: false,
  speedsOpen: false,
  speedsSource: "all",
  speedsScope: "all",
  mascot: {
    ompSrc: "",
    ompIdleSrc: "",
    claudeSrc: "",
    claudeIdleSrc: "",
    hasCustom: false,
    mode: "auto",
    minimized: false,
    x: null,
    bottom: null,
    initialized: false,
    knownSessions: new Map(),
    displayedToday: { omp: 0, claude: 0 },
    toastStacks: { omp: null, claude: null },
    cards: {},
  },
};

const listEl = document.querySelector("#list");
const attentionEl = document.querySelector("#attention");
const threadEl = document.querySelector("#thread");
const titleEl = document.querySelector("#title");
const metaEl = document.querySelector("#meta");
const searchEl = document.querySelector("#search");
const findEl = document.querySelector("#find");
const findCountEl = document.querySelector("#find-count");
const jumpEl = document.querySelector("#jump");
const filesEl = document.querySelector("#files");
const diffView = document.querySelector("#diffview");
const replyForm = document.querySelector("#reply");
const replyText = document.querySelector("#reply-text");
const replyNotice = document.querySelector("#reply-notice");
const replySend = document.querySelector("#reply-send");
const replyCopy = document.querySelector("#reply-copy");
const threadResume = document.querySelector("#thread-resume");
const replyResume = document.querySelector("#reply-resume");
replyCopy?.addEventListener("click", () => {
  copyReply();
});
threadResume?.addEventListener("click", () => {
  if (state.selected) vscode.postMessage({ type: "resumeSession", key: state.selected });
});
replyResume?.addEventListener("click", () => {
  if (state.selected) vscode.postMessage({ type: "resumeSession", key: state.selected });
});
const mascotDock = document.querySelector("#mascot-dock");
const mascotMenu = document.querySelector("#mascot-menu");
const diagramEl = document.querySelector("#diagram");
const speedsModal = document.querySelector("#speeds-modal");
document.querySelector("#speeds-btn")?.addEventListener("click", () => openSpeedsModal());
const diagramStage = document.querySelector("#diagram-stage");
const diagramZoomReset = document.querySelector("#diagram-zoom-reset");
const diagramView = { scale: 1, x: 0, y: 0, canvas: null, drag: null };
document.querySelector("#diagram-close")?.addEventListener("click", closeDiagram);
document.querySelector("#diagram-zoom-in")?.addEventListener("click", () => zoomDiagramBy(1.25));
document.querySelector("#diagram-zoom-out")?.addEventListener("click", () => zoomDiagramBy(1 / 1.25));
diagramZoomReset?.addEventListener("click", resetDiagramZoom);
bindDiagramStage();

document.querySelector("#refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

bindInputSelectAll();
bindMascotWidget();

searchEl.addEventListener("input", () => {
  state.query = searchEl.value.trim().toLowerCase();
  renderList();
});

findEl.addEventListener("input", () => {
  state.find = findEl.value;
  state.hit = 0;
  if (state.transcript) renderThread("find");
});

findEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  moveHit(event.shiftKey ? -1 : 1);
});

document.querySelector("#find-prev").addEventListener("click", () => moveHit(-1));
document.querySelector("#find-next").addEventListener("click", () => moveHit(1));

jumpEl.addEventListener("click", () => {
  threadEl.scrollTop = threadEl.scrollHeight;
  updateJump();
});

threadEl.addEventListener("scroll", () => updateJump());

for (const button of document.querySelectorAll("[data-source]")) {
  button.addEventListener("click", () => {
    state.source = button.dataset.source;
    setActive("[data-source]", button);
    renderList();
  });
}

for (const button of document.querySelectorAll("[data-scope]")) {
  button.addEventListener("click", () => {
    state.scope = button.dataset.scope;
    setActive("[data-scope]", button);
    renderList();
  });
}

for (const button of document.querySelectorAll("[data-activity]")) {
  button.addEventListener("click", () => setActivity(button.dataset.activity));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "selectAll") {
    selectFocusedField();
    return;
  }
  if (message.type === "focusFind") {
    findEl?.focus();
    findEl?.select();
    return;
  }
  if (message.type === "mascotState") {
    applyMascotState(message);
    return;
  }
  if (message.type === "sessions") {
    state.sessions = message.sessions;
    if (typeof vscode.setState === "function") vscode.setState({ selected: state.selected });
    renderList();
    if (state.speedsOpen) renderSpeedsModal();
    return;
  }
  if (message.type === "transcript") {
    const switched = message.key !== state.selected;
    if (switched && !message.live) {
      replyText.value = "";
      state.diffData = null;
      renderDiff();
    }
    state.selected = message.key;
    if (typeof vscode.setState === "function") vscode.setState({ selected: state.selected });
    state.transcript = message.transcript;
    if (message.following != null) state.following = message.following === true;
    if (message.canReply != null) state.canReply = message.canReply === true;
    if (message.replyHint && (switched || (!state.replying && !state.copyingReply && !message.live))) {
      replyNotice.textContent = message.replyHint;
    }
    renderList();
    renderThread(message.live ? "live" : "open");
    updateReply();
    return;
  }
  if (message.type === "transcriptPatch") {
    applyTranscriptPatch(message);
    return;
  }
  if (message.type === "replyResult") {
    state.replying = false;
    replyNotice.textContent = message.notice || "";
    if (message.ok && message.sent === true) replyText.value = "";
    updateReply();
    return;
  }
  if (message.type === "replyCopyResult") {
    state.copyingReply = false;
    replyNotice.textContent = message.notice || "";
    updateReply();
    return;
  }
  if (message.type === "replyState") {
    state.canReply = message.canReply === true;
    if (!state.replying && !state.copyingReply && message.replyHint) replyNotice.textContent = message.replyHint;
    updateReply();
    return;
  }
  if (message.type === "fileDiff") {
    state.diffData = message;
    renderDiff();
    return;
  }
  if (message.type === "closed") {
    state.selected = "";
    state.transcript = null;
    state.diffData = null;
    state.canReply = false;
    titleEl.textContent = "Select a session";
    metaEl.textContent = "";
    threadEl.replaceChildren(el("div", "empty", "Select a session from the list."));
    renderDiff();
    renderList();
    updateReply();
    return;
  }
  if (message.type === "follow") {
    state.following = message.following === true;
    applyMeta();
  }
});

threadEl.addEventListener("click", (event) => {
  const link = event.target.closest("a.link");
  if (!link || !threadEl.contains(link)) return;
  event.preventDefault();
  if (link.dataset.href) vscode.postMessage({ type: "openLink", href: link.dataset.href });
});

filesEl.addEventListener("click", (event) => {
  const link = event.target.closest("a.link");
  if (!link || !filesEl.contains(link)) return;
  event.preventDefault();
  if (link.dataset.href) vscode.postMessage({ type: "openLink", href: link.dataset.href });
});

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const link = linkFromEvent(event);
  if (link) link.href = "#";
}, true);

document.addEventListener("contextmenu", (event) => {
  const link = linkFromEvent(event);
  if (!link) return;
  link.href = link.dataset.copyHref || link.dataset.href || "#";
}, true);

document.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const anchors = fragment.querySelectorAll ? [...fragment.querySelectorAll("a.link")] : [];
  const link = anchors.length ? null : linkNode(range.startContainer);
  if (!anchors.length && !link) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", selection.toString());
  if (anchors.length) {
    for (const anchor of anchors) anchor.setAttribute("href", anchor.dataset.copyHref || anchor.dataset.href || "#");
    const holder = document.createElement("div");
    holder.append(fragment);
    event.clipboardData.setData("text/html", holder.innerHTML);
    return;
  }
  const url = link.dataset.copyHref || link.dataset.href;
  event.clipboardData.setData("text/html", `<a href="${escapeAttr(url)}">${escapeHtml(selection.toString())}</a>`);
  event.clipboardData.setData("text/uri-list", url);
});

replyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendReply();
});

replyText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendReply();
  }
});

replyText.addEventListener("input", updateReply);

vscode.postMessage({ type: "ready" });

function bindInputSelectAll() {
  let blurTimer = 0;
  document.addEventListener("focusin", (event) => {
    if (!isTextField(event.target)) return;
    clearTimeout(blurTimer);
    vscode.postMessage({ type: "inputFocus", focused: true });
  });
  document.addEventListener("focusout", (event) => {
    if (!isTextField(event.target)) return;
    blurTimer = setTimeout(() => {
      if (!isTextField(document.activeElement)) vscode.postMessage({ type: "inputFocus", focused: false });
    }, 0);
  });
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    if (!isTextField(event.target)) return;
    event.preventDefault();
    event.target.select();
  }, true);
}

function isTextField(node) {
  if (!node || node.disabled || node.readOnly) return false;
  if (node.tagName === "TEXTAREA") return true;
  return node.tagName === "INPUT" && /^(text|search|email|url|password|tel|number)$/.test(node.type || "text");
}

function selectFocusedField() {
  if (isTextField(document.activeElement)) document.activeElement.select();
}

function sendReply() {
  const text = replyText.value.trim();
  if (!text || !state.canReply || state.replying || state.copyingReply) return;
  state.replying = true;
  updateReply();
  const selected = state.sessions.find((item) => item.key === state.selected);
  const label = selected?.sourceLabel || (selected?.source === "claude" ? "Claude Code" : "OMP");
  replyNotice.textContent = `Sending to the open ${label} window…`;
  vscode.postMessage({ type: "reply", text });
}

function copyReply() {
  const text = replyText.value;
  if (!text.trim() || state.replying || state.copyingReply) return;
  state.copyingReply = true;
  updateReply();
  vscode.postMessage({ type: "copyReply", text });
}

function updateReply() {
  const hasDraft = Boolean(replyText.value.trim());
  const busy = state.replying || state.copyingReply;
  replySend.disabled = !state.canReply || busy || !hasDraft;
  if (replyCopy) replyCopy.disabled = busy || !hasDraft;
  const hasSession = Boolean(state.selected);
  if (replyResume) replyResume.hidden = !hasSession || state.canReply;
  if (threadResume) {
    threadResume.hidden = !hasSession;
    threadResume.textContent = state.canReply ? "Focus Terminal" : "Resume in Terminal";
    threadResume.title = state.canReply
      ? "Focus or open the terminal window for this session"
      : "Reopen this session in a Cursor integrated terminal";
  }
}

function setActive(selector, button) {
  for (const item of document.querySelectorAll(selector)) item.classList.toggle("active", item === button);
}

function renderList() {
  const query = state.query;
  const matched = state.sessions.filter((session) => {
    if (state.source !== "all" && session.source !== state.source) return false;
    if (state.scope === "workspace" && !session.inWorkspace) return false;
    if (!query) return true;
    return `${session.title} ${session.preview} ${session.project} ${session.model || ""}`.toLowerCase().includes(query);
  });
  const shown = matched.filter((session) => !session.hidden || session.activity === "fresh" || session.activity === "running");
  const hidden = matched.filter((session) => session.hidden && session.activity !== "fresh" && session.activity !== "running");
  const visible = shown.filter((session) => state.activity === "all" || session.activity === state.activity);
  visible.sort((a, b) => b.mtime - a.mtime);
  hidden.sort((a, b) => b.mtime - a.mtime);
  renderAttention(shown);
  renderMascots();
  listEl.replaceChildren();
  if (!visible.length) listEl.append(el("div", "empty", emptyLabel()));
  else appendSessions(visible);
  if (!hidden.length) return;
  const toggle = el("button", "hidden-toggle", state.showHidden ? `Hide ${hidden.length} hidden` : `${hidden.length} hidden`);
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    renderList();
  });
  listEl.append(toggle);
  if (state.showHidden) appendSessions(hidden);
}

function appendSessions(rows) {
  for (const session of rows) listEl.append(sessionRow(session));
}

function sessionRow(session) {
  const row = el("div", `session${session.key === state.selected ? " selected" : ""}`);
  const main = el("button", "session-main");
  main.type = "button";
  const titleRow = el("span", "title-row");
  const sourceTag = el("span", `source-tag ${session.source}`, session.source === "claude" ? "Claude" : session.sourceLabel);
  sourceTag.title = session.sourceLabel;
  titleRow.append(sourceTag, el("span", "title", session.title));
  if (session.activity === "running") titleRow.append(el("span", "badge running", "Running"));
  else if (session.activity === "fresh") titleRow.append(el("span", "badge fresh", "New reply"));
  main.append(titleRow);
  main.append(el("span", "meta", `${session.project ? `${session.project} · ` : ""}${when(session.mtime)}`));
  const statsText = formatSessionRowStats(session);
  if (statsText) {
    const statsEl = el("span", "stats", statsText);
    statsEl.title = formatSessionStatsTooltip(session);
    main.append(statsEl);
  }
  main.addEventListener("click", () => openSessionRow(session));
  const actions = el("div", "session-actions");
  actions.append(sessionAction("Resume", () => vscode.postMessage({ type: "resumeSession", key: session.key })));
  if (session.hidden) actions.append(sessionAction("Restore", () => vscode.postMessage({ type: "unhide", key: session.key })));
  else actions.append(sessionAction("Hide", () => vscode.postMessage({ type: "hide", key: session.key })));
  actions.append(sessionAction("Delete", () => vscode.postMessage({ type: "deleteSession", key: session.key })));
  row.append(main, actions);
  return row;
}

function sessionAction(label, onClick) {
  const button = el("button", "session-action", label);
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function openSessionRow(session) {
  if (state.selected !== session.key) {
    state.find = "";
    state.hit = 0;
    findEl.value = "";
    findCountEl.textContent = "";
  }
  state.selected = session.key;
  titleEl.textContent = session.title;
  metaEl.textContent = "Loading…";
  threadEl.replaceChildren(el("div", "empty", "Loading…"));
  updateJump();
  updateReply();
  renderList();
  vscode.postMessage({ type: "open", key: session.key });
}

function setActivity(activity) {
  state.activity = activity;
  const button = document.querySelector(`[data-activity="${activity}"]`);
  if (button) setActive("[data-activity]", button);
  renderList();
}

function emptyLabel() {
  if (state.activity === "fresh") return "No new replies.";
  if (state.activity === "running") return "Nothing running.";
  return "No sessions in this scope.";
}

function renderAttention(shown) {
  const running = shown.filter((session) => session.activity === "running").length;
  const fresh = shown.filter((session) => session.activity === "fresh").length;
  if (!running && !fresh) {
    attentionEl.hidden = true;
    attentionEl.replaceChildren();
    return;
  }
  attentionEl.hidden = false;
  attentionEl.replaceChildren();
  if (running) attentionEl.append(activityBadge("running", `${running} running`));
  if (fresh) attentionEl.append(activityBadge("fresh", `${fresh} new`));
}

function activityBadge(activity, label) {
  const button = el("button", `badge ${activity}${state.activity === activity ? " active" : ""}`, label);
  button.type = "button";
  button.title = activity === "fresh" ? "Show sessions with a new reply" : "Show sessions that are still running";
  button.addEventListener("click", () => setActivity(state.activity === activity ? "all" : activity));
  return button;
}

function applyMeta() {
  const transcript = state.transcript;
  const session = state.sessions.find((item) => item.key === state.selected);
  titleEl.textContent = transcript?.title || session?.title || "Session";
  if (!session) {
    metaEl.textContent = "";
    metaEl.title = "";
    return;
  }
  const stats = transcript?.stats || session;
  const parts = [session.sourceLabel];
  if (session.project) parts.push(session.project);
  const model = shortModel(stats?.model || session.model);
  if (model) parts.push(model);
  const tps = formatTokPerSec(stats?.tokPerSec ?? session.tokPerSec);
  if (tps) parts.push(tps);
  const ctx = formatContextUsage(stats?.contextTokens ?? session.contextTokens, stats?.contextWindow ?? session.contextWindow, true);
  if (ctx) parts.push(ctx);
  const tok = formatCompactTokens(stats?.totalTokens ?? session.totalTokens);
  if (tok) parts.push(`${tok} tok`);
  const cost = formatUSD(stats?.cost ?? session.cost);
  if (cost) parts.push(cost);
  if (state.following) parts.push("live");
  metaEl.textContent = parts.join(" · ");
  metaEl.title = formatSessionStatsTooltip({ ...session, ...stats });
}

function syncSessionStats(key, stats) {
  if (!stats) return false;
  const session = state.sessions.find((item) => item.key === key);
  if (!session) return false;
  const changed =
    session.model !== stats.model ||
    session.contextTokens !== stats.contextTokens ||
    session.totalTokens !== stats.totalTokens ||
    session.tokPerSec !== stats.tokPerSec ||
    session.cost !== stats.cost ||
    session.todayCost !== stats.todayCost ||
    session.monthCost !== stats.monthCost ||
    session.turnCount !== stats.turnCount;
  Object.assign(session, stats);
  return changed;
}

function shortModel(model) {
  if (!model || model === "<synthetic>") return "";
  return String(model).trim().split("/").pop();
}

function formatCompactTokens(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k >= 100 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return `${(m >= 100 ? m.toFixed(0) : m.toFixed(1)).replace(/\.0$/, "")}M`;
}

function formatContextUsage(contextTokens, contextWindow, detailed) {
  const ctx = formatCompactTokens(contextTokens);
  if (!ctx) return "";
  const win = Number(contextWindow) || 0;
  if (win > 0) {
    if (detailed) {
      const pct = Math.min(999, Math.round((Number(contextTokens) / win) * 100));
      return `ctx ${ctx}/${formatCompactTokens(win)} (${pct}%)`;
    }
  }
  return `ctx ${ctx}`;
}

function formatUSD(cost) {
  const n = Number(cost) || 0;
  if (n <= 0) return "";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
function formatTokPerSec(tokPerSec) {
  const n = Number(tokPerSec) || 0;
  if (n <= 0) return "";
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} tok/s`;
}

function formatTtft(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}


function formatSessionRowStats(session) {
  const parts = [];
  const model = shortModel(session.model);
  if (model) parts.push(model);
  const tps = formatTokPerSec(session.tokPerSec);
  if (tps) parts.push(tps);
  const ctx = formatContextUsage(session.contextTokens, session.contextWindow, false);
  if (ctx) parts.push(ctx);
  const tok = formatCompactTokens(session.totalTokens);
  if (tok) parts.push(`${tok} tok`);
  const cost = formatUSD(session.cost);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

function formatSessionStatsTooltip(session) {
  const lines = [];
  if (session.model) lines.push(`Model: ${session.model}`);
  if (session.tokPerSec > 0) {
    const outInfo = session.outputTokens > 0 ? ` (${session.outputTokens.toLocaleString()} output tok)` : "";
    lines.push(`Throughput: ${session.tokPerSec.toFixed(1)} tok/s${outInfo}`);
  }
  if (session.avgTtftMs > 0) {
    lines.push(`Avg TTFT: ${formatTtft(session.avgTtftMs)}`);
  }
  if (session.contextTokens > 0) {
    const win = session.contextWindow > 0
      ? ` / ${session.contextWindow.toLocaleString()} (${Math.round((session.contextTokens / session.contextWindow) * 100)}%)`
      : "";
    lines.push(`Context: ${session.contextTokens.toLocaleString()}${win} tokens`);
  }
  if (session.totalTokens > 0) lines.push(`Total tokens: ${session.totalTokens.toLocaleString()}`);
  if (session.cost > 0) lines.push(`Estimated cost: $${session.cost.toFixed(4)}`);
  return lines.join("\n");
}

function renderThread(mode) {
  const transcript = state.transcript;
  renderFiles();
  if (!transcript) return;
  const live = mode === "live";
  const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  const previousScroll = threadEl.scrollTop;
  const openTools = live
    ? [...threadEl.querySelectorAll("details.tool")].map((node) => node.open)
    : [];
  const openThinking = live
    ? [...threadEl.querySelectorAll("details.thinking")].map((node) => node.open)
    : [];
  applyMeta();
  const column = el("div", "column");
  threadEl.replaceChildren(column);
  if (transcript.omitted > 0) column.append(el("div", "note", `${transcript.omitted} earlier messages omitted`));
  if (!transcript.turns.length) {
    column.append(el("div", "empty", "This session has no messages to show."));
    findCountEl.textContent = state.find.trim() ? "No matches" : "";
    updateJump();
    return;
  }
  for (const turn of transcript.turns) column.append(renderTurn(turn));
  [...threadEl.querySelectorAll("details.thinking")].forEach((node, index) => {
    if (openThinking[index]) node.open = true;
  });
  [...threadEl.querySelectorAll("details.tool")].forEach((node, index) => {
    if (openTools[index]) node.open = true;
  });
  renderDiagrams(column);
  const marks = highlightHits(column, state.find.trim());
  const pinToEnd = () => {
    threadEl.scrollTop = threadEl.scrollHeight;
    updateJump();
  };
  if (mode === "find" && marks.length) {
    focusHit(marks, state.hit, true);
    return;
  }
  if (mode === "open") {
    pinToEnd();
    requestAnimationFrame(pinToEnd);
    return;
  }
  if (marks.length) focusHit(marks, state.hit, false);
  if (!nearBottom) {
    threadEl.scrollTop = previousScroll;
    updateJump();
    return;
  }
  pinToEnd();
  requestAnimationFrame(pinToEnd);
}

function renderTurn(turn, previous) {
  if (turn.role === "user") {
    const bubble = el("div", "user");
    appendRichText(bubble, turn.text);
    return bubble;
  }
  const block = el("div", "md");
  if (turn.thinking) {
    const details = document.createElement("details");
    details.className = "thinking";
    details.append(el("summary", "", "Thinking"));
    const thought = el("div", "md");
    renderMarkdown(thought, turn.thinking);
    details.append(thought);
    block.append(details);
  }
  if (turn.text) renderMarkdown(block, turn.text);
  for (const tool of turn.tools || []) block.append(renderTool(tool));
  if (!previous) return block;
  const thinking = block.querySelector("details.thinking");
  if (thinking && previous.querySelector("details.thinking")?.open) thinking.open = true;
  const opened = [...previous.querySelectorAll(":scope > details.tool")];
  [...block.querySelectorAll(":scope > details.tool")].forEach((node, index) => {
    if (opened[index]?.open) node.open = true;
  });
  return block;
}

function applyTranscriptPatch(message) {
  if (message.key !== state.selected || !state.transcript) return;
  const turns = state.transcript.turns.slice(message.dropped || 0);
  for (const update of message.updates || []) {
    if (update.index >= 0 && update.index < turns.length) turns[update.index] = update.turn;
  }
  for (const turn of message.appended || []) turns.push(turn);
  state.transcript = {
    title: message.title || state.transcript.title,
    omitted: message.omitted,
    files: message.files || state.transcript.files,
    stats: message.stats || state.transcript.stats,
    turns,
  };
  if (message.following != null) state.following = message.following === true;
  if (message.stats && syncSessionStats(message.key, message.stats)) renderList();
  applyMeta();
  if (state.find.trim()) {
    renderThread("live");
    return;
  }
  patchThread(message);
}

function patchThread(message) {
  const column = threadEl.querySelector(":scope > .column");
  if (!column) {
    renderThread("live");
    return;
  }
  const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  const previousScroll = threadEl.scrollTop;
  const note = column.querySelector(":scope > .note");
  if (state.transcript.omitted > 0) {
    const text = `${state.transcript.omitted} earlier messages omitted`;
    if (note) note.textContent = text;
    else column.prepend(el("div", "note", text));
  } else if (note) {
    note.remove();
  }
  const nodes = [...column.children].filter((node) => node.classList.contains("user") || node.classList.contains("md"));
  const dropped = message.dropped || 0;
  if (dropped > nodes.length) {
    renderThread("live");
    return;
  }
  for (let index = 0; index < dropped; index += 1) nodes[index].remove();
  const kept = nodes.slice(dropped);
  for (const update of message.updates || []) {
    const previous = kept[update.index];
    if (!previous) {
      renderThread("live");
      return;
    }
    previous.replaceWith(renderTurn(update.turn, previous));
  }
  for (const turn of message.appended || []) column.append(renderTurn(turn));
  const empty = column.querySelector(":scope > .empty");
  if (state.transcript.turns.length) empty?.remove();
  else if (!empty) column.append(el("div", "empty", "This session has no messages to show."));
  renderDiagrams(column);
  if (nearBottom) {
    const pinToEnd = () => {
      threadEl.scrollTop = threadEl.scrollHeight;
      updateJump();
    };
    pinToEnd();
    requestAnimationFrame(pinToEnd);
    return;
  }
  threadEl.scrollTop = previousScroll;
  updateJump();
}

function highlightHits(root, query) {
  findCountEl.textContent = "";
  if (!query) return [];
  const marks = [];
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const p = walker.currentNode.parentElement;
    if (p && !p.closest("svg, .table-chart, button")) nodes.push(walker.currentNode);
  }
  const needle = query.toLowerCase();
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;
    const fragment = document.createDocumentFragment();
    let index = 0;
    let found = lower.indexOf(needle);
    while (found >= 0) {
      if (found > index) fragment.append(document.createTextNode(text.slice(index, found)));
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = text.slice(found, found + query.length);
      fragment.append(mark);
      marks.push(mark);
      index = found + query.length;
      found = lower.indexOf(needle, index);
    }
    if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
    node.parentNode.replaceChild(fragment, node);
  }
  marks.forEach((mark) => {
    let parent = mark.parentElement;
    while (parent && parent !== root) {
      if (parent.tagName === "DETAILS") parent.open = true;
      parent = parent.parentElement;
    }
  });
  if (!marks.length) findCountEl.textContent = "No matches";
  return marks;
}

function focusHit(marks, index, reveal) {
  if (!marks.length) return;
  state.hit = (index + marks.length) % marks.length;
  marks.forEach((mark, markIndex) => mark.classList.toggle("current", markIndex === state.hit));
  findCountEl.textContent = `${state.hit + 1}/${marks.length}`;
  if (!reveal) return;
  marks[state.hit].scrollIntoView({ block: "center" });
  updateJump();
}

function moveHit(delta) {
  const marks = [...threadEl.querySelectorAll("mark.hit")];
  if (!marks.length) return;
  focusHit(marks, state.hit + delta, true);
}

function renderFiles() {
  const files = state.transcript?.files || [];
  filesEl.replaceChildren();
  const list = document.createElement("ul");
  for (const file of files) {
    const raw = typeof file === "string" ? file : file.path;
    const href = fileHref(raw);
    if (!href) continue;
    const item = document.createElement("li");
    item.className = "file-row";
    appendAnchor(item, displayPath(raw, href), href);
    const additions = file.additions || 0;
    const deletions = file.deletions || 0;
    if (additions || deletions) {
      item.append(el("span", "add", `+${additions}`));
      item.append(el("span", "del", `-${deletions}`));
    }
    const button = el("button", "diff-btn", "Diff");
    button.type = "button";
    button.addEventListener("click", () => vscode.postMessage({ type: "fileDiff", path: raw }));
    item.append(button);
    list.append(item);
  }
  if (!list.childElementCount) {
    filesEl.hidden = true;
    return;
  }
  filesEl.hidden = false;
  filesEl.append(el("h3", "", "Files changed this turn"));
  filesEl.append(list);
}

function renderDiff() {
  const data = state.diffData;
  diffView.replaceChildren();
  if (!data) {
    diffView.hidden = true;
    return;
  }
  diffView.hidden = false;
  const head = el("div", "diff-head");
  const href = fileHref(data.path);
  head.append(el("span", "diff-title", displayPath(data.path, href || data.path)));
  head.append(el("span", "add", `+${data.additions || 0}`));
  head.append(el("span", "del", `-${data.deletions || 0}`));
  const split = el("button", state.diffMode === "split" ? "mode active" : "mode", "Split");
  const inline = el("button", state.diffMode === "inline" ? "mode active" : "mode", "Inline");
  split.type = "button";
  inline.type = "button";
  split.addEventListener("click", () => {
    state.diffMode = "split";
    renderDiff();
  });
  inline.addEventListener("click", () => {
    state.diffMode = "inline";
    renderDiff();
  });
  const close = el("button", "mode", "Close");
  close.type = "button";
  close.addEventListener("click", () => {
    state.diffData = null;
    renderDiff();
  });
  head.append(split, inline, close);
  diffView.append(head);
  if (!data.hunks || !data.hunks.length) {
    diffView.append(el("p", "diff-empty", "This change has no original text to compare."));
    return;
  }
  for (const hunk of data.hunks) diffView.append(renderHunk(hunk));
}

function renderHunk(hunk) {
  const block = el("section", "hunk");
  block.append(el("h4", "", hunk.title || "Change"));
  if (state.diffMode === "inline") block.append(renderInlineDiff(hunk.lines || []));
  else block.append(renderSplitDiff(hunk.lines || []));
  if (hunk.truncated) block.append(el("p", "diff-empty", "More lines follow. Only the first part is shown."));
  return block;
}

function renderInlineDiff(lines) {
  const body = el("div", "diff-inline");
  for (const line of lines) {
    const row = el("pre", `diff-line ${line.type}`);
    row.textContent = `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "} ${line.text}`;
    body.append(row);
  }
  return body;
}

function renderSplitDiff(lines) {
  const body = el("div", "diff-split");
  for (const row of pairDiffLines(lines)) {
    body.append(diffCell(row.left, row.leftKind));
    body.append(diffCell(row.right, row.rightKind));
  }
  return body;
}

function diffCell(text, kind) {
  const cell = el("pre", `diff-cell ${kind || "empty"}`);
  cell.textContent = text == null ? "" : text;
  return cell;
}

function pairDiffLines(lines) {
  const rows = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.type === "ctx") {
      rows.push({ left: line.text, right: line.text, leftKind: "ctx", rightKind: "ctx" });
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < lines.length && lines[index].type === "del") removed.push(lines[index++].text);
    while (index < lines.length && lines[index].type === "add") added.push(lines[index++].text);
    const count = Math.max(removed.length, added.length);
    for (let row = 0; row < count; row += 1) {
      rows.push({
        left: removed[row] ?? null,
        right: added[row] ?? null,
        leftKind: removed[row] == null ? "empty" : "del",
        rightKind: added[row] == null ? "empty" : "add",
      });
    }
  }
  return rows;
}

function fileHref(raw) {
  if (raw.startsWith("~/")) {
    const home = homeDir();
    if (!home) return "";
    return joinPath(home, raw.slice(2));
  }
  if (raw.startsWith("/")) return raw;
  const cwd = sessionCwd();
  if (!cwd) return "";
  const absolute = joinPath(cwd, raw);
  return absolute.startsWith("/") ? absolute : "";
}

function homeDir() {
  const candidates = [sessionCwd(), ...state.sessions.map((item) => item.cwd || item.filePath || "")];
  for (const candidate of candidates) {
    const match = /^\/(?:Users|home)\/[^/]+/.exec(candidate);
    if (match) return match[0];
  }
  return "";
}

function displayPath(raw, href) {
  const cwd = sessionCwd();
  if (cwd && href.startsWith(`${cwd}/`)) return href.slice(cwd.length + 1);
  const home = homeDir();
  if (home && href.startsWith(`${home}/`)) return `~/${href.slice(home.length + 1)}`;
  if (!raw.startsWith("/")) return raw;
  return href;
}

function updateJump() {
  const gap = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
  jumpEl.hidden = !(state.transcript && gap > 160);
}

function renderTool(tool) {
  const source = tool.sourceLabel === "OMP" ? "omp" : tool.sourceLabel === "Claude Code" ? "claude" : "cursor";
  const details = document.createElement("details");
  details.className = `tool${tool.isError ? " error" : ""}`;
  const summary = el("summary");
  summary.append(el("span", `who ${source}`, tool.sourceLabel));
  summary.append(el("span", "", tool.name));
  const hint = oneLine(tool.command || tool.input);
  if (hint) summary.append(el("span", "cmd", hint));
  details.append(summary);
  if (tool.output) details.append(richPre(tool.output));
  else if (!tool.command && tool.input) details.append(richPre(tool.input));
  return details;
}

let mdEngine = null;

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
  if (window.katex && typeof window.katex.renderToString === "function") {
    try {
      return window.katex.renderToString(latex, {
        displayMode: Boolean(displayMode),
        throwOnError: false,
        strict: false,
        trust: true,
        output: "html",
      });
    } catch {
      // Fall back to escaped text on unexpected KaTeX error.
    }
  }
  return escapeHtml(latex);
}

function highlightCode(str, lang) {
  const clean = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
  if (!clean || clean === "mermaid" || clean === "svg" || clean === "math" || clean === "latex") return "";
  const hl = window.hljs;
  if (hl && typeof hl.getLanguage === "function" && hl.getLanguage(clean)) {
    try {
      return hl.highlight(str, { language: clean, ignoreIllegals: true }).value;
    } catch {
      return "";
    }
  }
  return "";
}

function getMarkdownEngine() {
  if (mdEngine) return mdEngine;
  if (typeof window.markdownit !== "function") return null;
  const md = window.markdownit({ html: false, linkify: false, breaks: true, highlight: highlightCode });
  const origScanDelims = md.inline.State.prototype.scanDelims;
  md.inline.State.prototype.scanDelims = function (start, canSplitWord) {
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
  md.inline.ruler.after("escape", "math_inline_block", parseInlineMathBlock);
  md.inline.ruler.after("escape", "math_inline", parseInlineMath);
  md.block.ruler.after("blockquote", "math_block", parseBlockMath, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    const displayMode = /\\begin\{(align|equation|gather|cd|alignat)\}/i.test(content);
    return renderKatexHtml(content, displayMode);
  };
  md.renderer.rules.math_block = (tokens, idx) => `<div class="katex-block">${renderKatexHtml(tokens[idx].content, true)}</div>\n`;
  const origFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const lang = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang === "math" || lang === "latex") {
      return `<div class="katex-block">${renderKatexHtml(token.content, true)}</div>\n`;
    }
    if (lang === "mermaid" || lang === "svg") {
      return `<pre><code class="language-${lang}">${escapeHtml(token.content.replace(/\n$/, ""))}</code></pre>\n`;
    }
    return origFence ? origFence.call(this, tokens, idx, options, env, self) : `<pre><code>${escapeHtml(token.content)}</code></pre>\n`;
  };
  mdEngine = md;
  return mdEngine;
}

function unescapeInlineBr(html) {
  return html.replace(/(<code\b[^>]*>[\s\S]*?<\/code>)|&lt;br\s*\/?&gt;/gi, (m, code) => code || "<br>");
}

function enhanceMarkdownDom(root) {
  for (const anchor of root.querySelectorAll("a[href]")) {
    if (anchor.classList.contains("link")) continue;
    const rawHref = anchor.getAttribute("href") || "";
    const target = normalizeTarget(rawHref);
    if (!target) continue;
    anchor.className = "link";
    anchor.href = "#";
    anchor.dataset.href = target;
    anchor.dataset.copyHref = publicHref(target);
    anchor.title = target;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let current = walker.nextNode();
  while (current) {
    const parentEl = current.parentElement;
    if (
      parentEl &&
      !parentEl.closest("a, .katex, code.language-mermaid, code.language-svg")
    ) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const value = textNode.nodeValue || "";
    if (!value) continue;
    const frag = document.createDocumentFragment();
    linkifyPlain(frag, value);
    if (frag.childNodes.length > 1 || (frag.firstChild && frag.firstChild.nodeType !== Node.TEXT_NODE)) {
      textNode.replaceWith(frag);
    }
  }
}

function closeInterruptedDiagramFences(markdown) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)(.*)$/.exec(line);
      if (open && !(open[1][0] === "`" && (open[2] + open[3]).includes("`"))) {
        const char = open[1][0];
        const len = open[1].length;
        const lang = (open[2] || "").toLowerCase();
        const closeRe = new RegExp(`^ {0,3}${char}{${len},}[ \\t]*$`);
        let unclosed = false;
        if (lang === "mermaid" || lang === "svg") {
          unclosed = true;
          for (let j = i + 1; j < lines.length; j += 1) {
            if (closeRe.test(lines[j])) {
              unclosed = false;
              break;
            }
            if (/^ {0,3}(`{3,}|~{3,})[ \t]*[A-Za-z0-9_-]+/.test(lines[j])) {
              unclosed = true;
              break;
            }
          }
        }
        fence = {
          marker: open[1],
          closeRe,
          lang,
          unclosed,
        };
      }
      out.push(line);
      continue;
    }
    if (fence.closeRe.test(line)) {
      fence = null;
      out.push(line);
      continue;
    }
    if (fence.unclosed && (fence.lang === "mermaid" || fence.lang === "svg")) {
      const prevBlank = out.length > 0 && out[out.length - 1].trim() === "";
      const nextFenceOpen = /^ {0,3}(`{3,}|~{3,})[ \t]*[A-Za-z0-9_-]+/.test(line);
      const markdownHeading = prevBlank && /^ {0,3}#{1,6}[ \t]+\S/.test(line);
      if (nextFenceOpen || markdownHeading) {
        let trailingProse = "";
        let lastIdx = out.length - 1;
        while (lastIdx >= 0 && out[lastIdx].trim() === "") lastIdx -= 1;
        if (fence.lang === "mermaid" && lastIdx >= 0) {
          const glued = /^(\s*[A-Za-z0-9_]+(?:\s*(?:-->>|->>|-->|->|-[x)]|--[x)])\s*[A-Za-z0-9_]+)\s*:)([^\s].*[：:])$/.exec(out[lastIdx]);
          if (glued && /[^\x00-\x7F]/.test(glued[2])) {
            out[lastIdx] = glued[1];
            trailingProse = glued[2];
          }
        }
        const blankTail = out.splice(lastIdx + 1);
        out.push(fence.marker);
        if (trailingProse) out.push("", trailingProse);
        out.push(...blankTail);
        fence = null;
        i -= 1;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function renderMarkdown(parent, text) {
  const md = getMarkdownEngine();
  if (!md) {
    parent.append(richPre(String(text || "")));
    return;
  }
  const holder = document.createElement("div");
  holder.innerHTML = unescapeInlineBr(md.render(closeInterruptedDiagramFences(text)));
  enhanceMarkdownDom(holder);
  while (holder.firstChild) parent.append(holder.firstChild);
}

function appendRichText(parent, text) {
  const md = getMarkdownEngine();
  if (!md) {
    const lines = String(text || "").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) parent.append(document.createElement("br"));
      linkifyPlain(parent, line);
    });
    return;
  }
  const holder = document.createElement("div");
  holder.innerHTML = unescapeInlineBr(md.renderInline(String(text || "")));
  enhanceMarkdownDom(holder);
  while (holder.firstChild) parent.append(holder.firstChild);
}

function richPre(text) {
  const pre = el("pre");
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    if (index > 0) pre.append(document.createElement("br"));
    linkifyPlain(pre, line);
  });
  return pre;
}

function linkifyPlain(parent, text) {
  const pattern = new RegExp("(https?:\\/\\/[^\\s<>]+|file:\\/\\/[^\\s<>]+|" + ABSOLUTE_PATH + "|" + RELATIVE_PATH + ")", "g");
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    appendBare(parent, match[0]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function appendBare(parent, token) {
  const [href, trail] = splitBare(token);
  const target = normalizeTarget(href);
  if (target) appendAnchor(parent, href, target);
  else parent.append(document.createTextNode(href));
  if (trail) parent.append(document.createTextNode(trail));
}

function appendAnchor(parent, label, href) {
  const link = document.createElement("a");
  link.className = "link";
  link.href = "#";
  link.dataset.href = href;
  link.dataset.copyHref = publicHref(href);
  link.title = href;
  link.textContent = label;
  parent.append(link);
}

function linkFromEvent(event) {
  const node = event.target;
  const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
  return el ? el.closest("a.link") : null;
}

function linkNode(node) {
  const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
  return el ? el.closest("a.link") : null;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function publicHref(target) {
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) return target;
  if (target.startsWith("/")) {
    const file = splitLocation(target).file;
    return `file://${file.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
  return target;
}

function splitBare(token) {
  let href = token;
  let trail = "";
  while (href && /[),.;!?，。、）】》>]/.test(href.slice(-1))) {
    trail = href.slice(-1) + trail;
    href = href.slice(0, -1);
  }
  if (href.endsWith(":") && !/:\d+$/.test(href.slice(0, -1))) {
    trail = `:${trail}`;
    href = href.slice(0, -1);
  }
  return [href, trail];
}

function normalizeTarget(raw) {
  const href = String(raw || "").trim();
  if (/^https?:\/\/\S+$/i.test(href)) return href;
  if (/^file:\/\/\S+$/i.test(href)) return href;
  if (href.startsWith("~/")) {
    const home = homeDir();
    if (!home) return href;
    const location = splitLocation(href.slice(2));
    const absolute = joinPath(home, location.file);
    if (!absolute.startsWith("/")) return href;
    if (!location.line) return absolute;
    return location.column > 1 || /:\d+:\d+$/.test(href) ? `${absolute}:${location.line}:${location.column}` : `${absolute}:${location.line}`;
  }
  if (isLocalPath(href)) return href;
  return resolveRelative(href);
}

function sessionCwd() {
  const session = state.sessions.find((item) => item.key === state.selected);
  return session?.cwd && session.cwd.startsWith("/") ? session.cwd : "";
}

function resolveRelative(value) {
  if (!isRelativePath(value)) return "";
  const cwd = sessionCwd();
  if (!cwd) return "";
  const location = splitLocation(value);
  const absolute = joinPath(cwd, location.file);
  if (!absolute.startsWith("/")) return "";
  if (!location.line) return absolute;
  return location.column > 1 || /:\d+:\d+$/.test(value) ? `${absolute}:${location.line}:${location.column}` : `${absolute}:${location.line}`;
}

function isRelativePath(value) {
  const pathOnly = value.replace(/:\d+(?::\d+)?$/, "");
  if (!pathOnly || pathOnly.startsWith("/") || pathOnly.includes("\0")) return false;
  return new RegExp("^(?:\\.\\./|\\./)?(?:" + PATH_SEGMENT + "/)+" + PATH_SEGMENT + "\\.[A-Za-z0-9]{1,12}$").test(pathOnly);
}

function splitLocation(value) {
  const match = /:(\d+)(?::(\d+))?$/.exec(value);
  if (!match || match.index === 0) return { file: value, line: 0, column: 0 };
  return { file: value.slice(0, match.index), line: Number(match[1]), column: Number(match[2] || 1) };
}

function joinPath(cwd, rel) {
  const parts = [];
  for (const part of `${cwd.replace(/\/+$/, "")}/${rel}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isLocalPath(value) {
  const pathOnly = value.replace(/:\d+(?::\d+)?$/, "");
  if (!pathOnly.startsWith("/") || pathOnly.includes("..")) return false;
  if (/^\/(Users|Volumes|private|tmp|home|opt)\//.test(pathOnly)) return true;
  return /\/[^/]+\.[A-Za-z0-9]{1,12}$/.test(pathOnly);
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function when(mtime) {
  const delta = Date.now() - mtime;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  return new Date(mtime).toLocaleDateString();
}

function applyMascotState(message) {
  const prefs = message.prefs || {};
  state.mascot.ompSrc = message.ompSrc || state.mascot.ompSrc;
  state.mascot.ompIdleSrc = message.ompIdleSrc || state.mascot.ompIdleSrc || state.mascot.ompSrc;
  state.mascot.claudeSrc = message.claudeSrc || state.mascot.claudeSrc;
  state.mascot.claudeIdleSrc = message.claudeIdleSrc || state.mascot.claudeIdleSrc || state.mascot.claudeSrc;
  state.mascot.hasCustom = message.hasCustom === true;
  if (typeof prefs.mode === "string") state.mascot.mode = prefs.mode;
  if (typeof prefs.minimized === "boolean") state.mascot.minimized = prefs.minimized;
  if (Number.isFinite(prefs.x)) state.mascot.x = prefs.x;
  if (Number.isFinite(prefs.bottom)) {
    state.mascot.bottom = prefs.bottom;
  } else if (Number.isFinite(prefs.y)) {
    state.mascot.bottom = Math.max(8, window.innerHeight - prefs.y - 140);
  }
  renderMascots();
}

function computeSpendSummary() {
  const pool = state.scope === "workspace"
    ? state.sessions.filter((item) => item.inWorkspace)
    : state.sessions;
  const summary = {
    omp: { today: 0, month: 0, count: 0, running: 0, fresh: 0 },
    claude: { today: 0, month: 0, count: 0, running: 0, fresh: 0 },
  };
  for (const session of pool) {
    const bucket = summary[session.source];
    if (!bucket) continue;
    bucket.today += Number(session.todayCost) || 0;
    bucket.month += Number(session.monthCost) || 0;
    bucket.count += 1;
    if (session.activity === "running") bucket.running += 1;
    else if (session.activity === "fresh") bucket.fresh += 1;
  }
  noteSessionTurnToasts(state.sessions);
  return summary;
}

function ensureToastStack(source) {
  if (!state.mascot.toastStacks[source]) {
    state.mascot.toastStacks[source] = el("div", "mascot-toast-stack");
  }
  return state.mascot.toastStacks[source];
}

function formatCallDelta(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return "";
  if (n < 0.001) return `+$${n.toFixed(4)}`;
  if (n < 0.1) return `+$${n.toFixed(3)}`;
  return `+$${n.toFixed(2)}`;
}

function spawnSpendToast(source, amount, delayMs = 0) {
  const text = formatCallDelta(amount);
  if (!text) return;
  setTimeout(() => {
    const stack = ensureToastStack(source);
    while (stack.children.length >= 5) {
      stack.firstElementChild.remove();
    }
    const toast = el("div", "spend-toast", `↑ ${text}`);
    stack.append(toast);
    const amtEl = mascotDock?.querySelector(`.mascot-card.${source} .amt`);
    if (amtEl) {
      amtEl.classList.add("pulse");
      setTimeout(() => amtEl.classList.remove("pulse"), 700);
    }
    setTimeout(() => {
      toast.classList.add("fading");
    }, 5000);
    setTimeout(() => {
      toast.remove();
    }, 6500);
  }, delayMs);
}

function noteSessionTurnToasts(allSessions) {
  if (!allSessions || !allSessions.length) return;
  const known = state.mascot.knownSessions;
  if (!state.mascot.initialized) {
    for (const session of allSessions) {
      known.set(session.key, {
        turnCount: Number(session.turnCount) || 0,
        todayCost: Number(session.todayCost) || 0,
      });
    }
    state.mascot.initialized = true;
    return;
  }
  const queued = { omp: [], claude: [] };
  for (const session of allSessions) {
    const source = session.source;
    if (source !== "omp" && source !== "claude") continue;
    const turnCount = Number(session.turnCount) || 0;
    const todayCost = Number(session.todayCost) || 0;
    const prev = known.get(session.key);
    if (!prev) {
      const recent = Array.isArray(session.recentTurnCosts) ? session.recentTurnCosts : [];
      if (recent.length) queued[source].push(...recent);
      else if (todayCost >= 0.0002) queued[source].push(todayCost);
    } else {
      const addedTurns = turnCount - prev.turnCount;
      const recent = Array.isArray(session.recentTurnCosts) ? session.recentTurnCosts : [];
      if (addedTurns > 0 && recent.length > 0) {
        const slice = recent.slice(-Math.min(addedTurns, recent.length));
        queued[source].push(...slice);
      } else if (todayCost - prev.todayCost >= 0.0002) {
        queued[source].push(todayCost - prev.todayCost);
      }
    }
    known.set(session.key, { turnCount, todayCost });
  }
  for (const source of ["omp", "claude"]) {
    queued[source].forEach((amt, idx) => {
      spawnSpendToast(source, amt, idx * 220);
    });
  }
}
function visibleMascotSources() {
  const mode = state.mascot.mode || "auto";
  if (mode === "omp") return ["omp"];
  if (mode === "claude") return ["claude"];
  if (mode === "both") return ["omp", "claude"];
  const selected = state.sessions.find((item) => item.key === state.selected);
  if (selected && (selected.source === "omp" || selected.source === "claude")) return [selected.source];
  if (state.source === "omp" || state.source === "claude") return [state.source];
  const scoped = state.scope === "workspace"
    ? state.sessions.filter((item) => item.inWorkspace)
    : state.sessions;
  const pool = scoped.length ? scoped : state.sessions;
  return [pool[0]?.source === "claude" ? "claude" : "omp"];
}

function formatSpendAmount(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function ensureMascotCard(source) {
  let refs = state.mascot.cards[source];
  if (refs) return refs;
  const label = source === "omp" ? "OMP" : "Claude";
  const card = el("div", `mascot-card ${source}`);
  const toastStack = ensureToastStack(source);
  const bubble = el("div", "mascot-bubble");
  const mainLine = el("div", "mascot-bubble-main");
  const amtSpan = el("span", `amt ${source}`, "$0.00");
  mainLine.append(document.createTextNode(`${label} Today `), amtSpan);
  const subLine = el("div", "mascot-bubble-sub", "Month $0.00");
  const statusEl = el("div", "mascot-status", "Idle");
  bubble.append(toastStack, mainLine, subLine, statusEl);
  const img = document.createElement("img");
  img.className = "mascot-avatar";
  img.alt = `${label} mascot`;
  img.draggable = false;
  card.append(bubble, img);
  refs = { card, bubble, amtSpan, subLine, statusEl, img, currentSrc: "" };
  state.mascot.cards[source] = refs;
  return refs;
}

function renderMascots() {
  if (!mascotDock) return;
  const hasAnySrc = Boolean(state.mascot.ompSrc || state.mascot.claudeSrc);
  if (!hasAnySrc) {
    mascotDock.hidden = true;
    return;
  }
  mascotDock.hidden = false;
  const spend = computeSpendSummary();
  const scopeLabel = state.scope === "workspace" ? "this workspace" : "all workspaces";
  if (state.mascot.minimized) {
    const totalToday = spend.omp.today + spend.claude.today;
    const pill = el("button", "mascot-pill");
    pill.type = "button";
    pill.title = `Click to expand · Right-click to customize (${scopeLabel})`;
    pill.append(
      document.createTextNode("Today "),
      el("span", "amt omp", formatSpendAmount(totalToday)),
    );
    pill.addEventListener("click", () => {
      if (mascotDock.dataset.dragged === "1") return;
      state.mascot.minimized = false;
      saveMascotPrefs({ minimized: false });
      renderMascots();
    });
    mascotDock.replaceChildren(pill);
    applyMascotPosition();
    return;
  }
  let gear = mascotDock.querySelector(":scope > .mascot-gear");
  let row = mascotDock.querySelector(":scope > .mascot-row");
  if (!gear || !row) {
    gear = el("button", "mascot-gear", "⚙");
    gear.type = "button";
    gear.title = "Customize mascot (or right-click)";
    gear.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = gear.getBoundingClientRect();
      openMascotMenu(rect.left, rect.top);
    });
    row = el("div", "mascot-row");
    mascotDock.replaceChildren(gear, row);
  }
  const sources = visibleMascotSources();
  const selected = state.sessions.find((item) => item.key === state.selected);
  const desiredCards = [];
  for (const source of sources) {
    const info = spend[source] || { today: 0, month: 0, count: 0, running: 0, fresh: 0 };
    const isBusy = info.running > 0 || Boolean(selected && selected.source === source && selected.activity === "running");
    const thinkingSrc = source === "omp" ? state.mascot.ompSrc : state.mascot.claudeSrc;
    const idleSrc = source === "omp" ? (state.mascot.ompIdleSrc || thinkingSrc) : (state.mascot.claudeIdleSrc || thinkingSrc);
    const src = isBusy ? thinkingSrc : idleSrc;
    if (!src) continue;
    const label = source === "omp" ? "OMP" : "Claude";
    const refs = ensureMascotCard(source);
    const moodText = isBusy
      ? (info.running > 1 ? `Thinking (${info.running} running)` : "Thinking…")
      : "Idle";
    refs.card.title = `${label} · ${moodText} (${scopeLabel})\nToday: $${info.today.toFixed(4)}\nThis month: $${info.month.toFixed(4)}\nDrag to move · Right-click to customize`;
    animateSpendValue(source, refs.amtSpan, info.today);
    refs.subLine.textContent = `Month ${formatSpendAmount(info.month)}`;
    const statusParts = [];
    if (info.running > 1) statusParts.push(`Thinking · ${info.running} running`);
    else if (isBusy) statusParts.push("Thinking…");
    if (info.fresh > 0) statusParts.push(`${info.fresh} new ${info.fresh === 1 ? "reply" : "replies"}`);
    if (statusParts.length) {
      refs.statusEl.className = `mascot-status ${isBusy ? "running" : "fresh"}`;
      refs.statusEl.textContent = statusParts.join(" · ");
    } else {
      refs.statusEl.className = "mascot-status";
      refs.statusEl.textContent = "Idle";
    }
    if (refs.currentSrc !== src) {
      refs.currentSrc = src;
      refs.img.src = src;
    }
    desiredCards.push(refs.card);
  }
  const currentChildren = [...row.children];
  if (
    currentChildren.length !== desiredCards.length ||
    currentChildren.some((node, idx) => node !== desiredCards[idx])
  ) {
    row.replaceChildren(...desiredCards);
  }
  applyMascotPosition();
}

function animateSpendValue(source, element, targetValue) {
  const target = Number(targetValue) || 0;
  const prev = state.mascot.displayedToday[source];
  state.mascot.displayedToday[source] = target;
  if (!(prev > 0) || Math.abs(target - prev) < 0.0005 || target < prev) {
    element.textContent = formatSpendAmount(target);
    return;
  }
  const start = performance.now();
  const duration = 650;
  element.classList.add("pulse");
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = prev + (target - prev) * eased;
    element.textContent = formatSpendAmount(current);
    if (t < 1 && element.isConnected) {
      requestAnimationFrame(step);
    } else if (element.isConnected) {
      element.textContent = formatSpendAmount(target);
      setTimeout(() => element.classList.remove("pulse"), 250);
    }
  };
  requestAnimationFrame(step);
}

let diagramSeq = 0;

function attachZoomButton(host, getSvg) {
  const zoom = el("button", "mermaid-zoom", "Full screen");
  zoom.type = "button";
  zoom.addEventListener("click", () => openDiagram(typeof getSvg === "function" ? getSvg() : getSvg));
  const showZoom = (event) => {
    const top = event.clientY - host.getBoundingClientRect().top;
    zoom.classList.toggle("is-visible", top <= 44 || zoom.contains(event.target));
  };
  host.addEventListener("mousemove", showZoom);
  host.addEventListener("mouseleave", () => zoom.classList.remove("is-visible"));
  host.append(zoom);
}

function renderSvgBlocks(root) {
  const blocks = [...root.querySelectorAll("pre > code.language-svg")];
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.svgRendered === "1") continue;
    pre.dataset.svgRendered = "1";
    const raw = (code.textContent || "").trim();
    if (!raw.startsWith("<svg")) continue;
    const safe = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=/gi, " data-noop=");
    const host = el("div", "mermaid");
    host.innerHTML = safe;
    const svg = host.querySelector("svg");
    if (!svg) continue;
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.maxWidth = "none";
    attachZoomButton(host, svg);
    pre.replaceWith(host);
  }
}

function normalizeMermaidThemeColors(source, isDark) {
  return String(source || "").replace(
    /^(\s*rect\s+)rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/gim,
    (match, prefix, rStr, gStr, bStr, aStr) => {
      const r = Number(rStr);
      const g = Number(gStr);
      const b = Number(bStr);
      const a = aStr !== undefined ? Number(aStr) : 1;
      if (a <= 0.25) return match;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (!isDark && lum < 0.45) {
        const lift = (c) => Math.max(232, Math.min(248, 255 - Math.round(c * 0.35)));
        return `${prefix}rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
      }
      if (isDark && lum > 0.6) {
        const dim = (c) => Math.max(28, Math.min(48, 255 - Math.round(c * 0.85)));
        return `${prefix}rgb(${dim(r)}, ${dim(g)}, ${dim(b)})`;
      }
      return match;
    },
  );
}

function cleanupMermaidScratch(id) {
  for (const prefix of ["d", "i", ""]) {
    const stray = document.getElementById(`${prefix}${id}`);
    if (stray && !stray.closest(".mermaid")) stray.remove();
  }
}

function escapeMermaidSequenceSemicolons(source) {
  return String(source || "")
    .split("\n")
    .map((line) => {
      if (/^\s*%%/.test(line)) return line;
      // Block labels cannot carry the entity form, so a comma keeps them readable.
      if (/^\s*(?:alt|else|opt|loop|par|and|critical|option|break|box)\b/.test(line)) {
        return line.replace(/;(?=[ \t]*\S)/g, ",");
      }
      const escaped = line.replace(/;(?=[ \t]*\S)/g, "#59;");
      return escaped === line ? line : escaped;
    })
    .join("\n");
}

async function renderMermaidSvg(idPrefix, rawSource) {
  const isSeq = /^\s*sequenceDiagram\b/m.test(rawSource);
  const source = isSeq
    ? escapeMermaidSequenceSemicolons(
        String(rawSource || "").replace(/^(\s*[^#\s%][^\n]*)$/gm, (line) => line.replace(/#/g, "\uFE5F"))
      )
    : String(rawSource || "");
  const tryOnce = async (candidate, suffix) => {
    const id = `${idPrefix}_${suffix}`;
    try {
      const result = await window.mermaid.render(id, candidate);
      cleanupMermaidScratch(id);
      if (result && result.svg && !result.svg.includes("Syntax error in text")) {
        return { ok: true, svg: isSeq ? result.svg.replace(/\uFE5F/g, "#") : result.svg };
      }
      return { ok: false, error: "Syntax error" };
    } catch (err) {
      cleanupMermaidScratch(id);
      return { ok: false, error: String(err?.message || err || "") };
    }
  };
  const first = await tryOnce(source, 0);
  if (first.ok) return { svg: first.svg, error: "", incomplete: false };
  const failed = { svg: "", error: first.error || "Syntax error", incomplete: false };
  if (/^\s*(?:\.{3,}|…)\s*$/m.test(source)) return { ...failed, error: "incomplete diagram", incomplete: true };
  const lines = String(source || "").split("\n");
  if (lines.length < 3) return failed;
  const minCut = Math.max(2, lines.length - 4);
  const match = /Parse error on line (\d+)/i.exec(first.error);
  let cut = match ? Math.min(lines.length - 1, Number(match[1]) - 1) : lines.length - 1;
  let attempts = 0;
  while (cut >= minCut && attempts < 4) {
    while (cut >= minCut && !lines[cut - 1].trim()) cut -= 1;
    if (cut < minCut) break;
    attempts += 1;
    const retry = await tryOnce(lines.slice(0, cut).join("\n"), attempts);
    if (retry.ok) return { svg: retry.svg, error: "", incomplete: false };
    const nextMatch = /Parse error on line (\d+)/i.exec(retry.error);
    const nextCut = nextMatch ? Number(nextMatch[1]) - 1 : cut - 1;
    cut = nextCut < cut ? nextCut : cut - 1;
  }
  return failed;
}

function formatMermaidError(result) {
  if (result && result.incomplete) return "mermaid: incomplete diagram — showing source";
  const line = /parse error on line (\d+)/i.exec(String((result && result.error) || ""));
  if (line) return `mermaid: parse error at line ${line[1]} — showing source`;
  return "mermaid: could not render this diagram — showing source";
}

function renderDiagrams(root) {
  if (!root) return;
  renderSvgBlocks(root);
  renderTableCharts(root);
  if (!window.mermaid) return;
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  if (!blocks.length) return;
  const color = getComputedStyle(document.body).backgroundColor;
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  const lum = match ? (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255 : 1;
  const isDark = lum < 0.5;
  if (!renderDiagrams.ready || renderDiagrams.isDark !== isDark) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "antiscript",
      suppressErrorRendering: true,
      htmlLabels: true,
      fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
      theme: isDark ? "dark" : "default",
    });
    renderDiagrams.ready = true;
    renderDiagrams.isDark = isDark;
  }
  blocks.forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.mermaidRendered === "1") return;
    pre.dataset.mermaidRendered = "1";
    const source = normalizeMermaidThemeColors(code.textContent || "", isDark);
    const id = `chat_mmd_${++diagramSeq}`;
    renderMermaidSvg(id, source).then((result) => {
      if (!pre.isConnected) return;
      if (!result.svg) {
        const note = el("div", "mermaid-error", formatMermaidError(result));
        note.title = String(result.error || "");
        pre.before(note);
        return;
      }
      const host = el("div", "mermaid");
      host.innerHTML = result.svg;
      const svg = host.querySelector("svg");
      if (svg) {
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.maxWidth = "none";
      }
      const zoom = el("button", "mermaid-zoom", "Full screen");
      zoom.type = "button";
      zoom.addEventListener("click", () => openDiagram(svg));
      const showZoom = (event) => {
        const top = event.clientY - host.getBoundingClientRect().top;
        zoom.classList.toggle("is-visible", top <= 44 || zoom.contains(event.target));
      };
      host.addEventListener("mousemove", showZoom);
      host.addEventListener("mouseleave", () => zoom.classList.remove("is-visible"));
      host.append(zoom);
      pre.replaceWith(host);
    });
  });
}

function renderTableCharts(root) {
  if (!window.ompCharts || typeof window.ompCharts.renderTableChart !== "function") return;
  const tables = [...root.querySelectorAll("table")];
  for (const table of tables) {
    if (table.dataset.chartRendered === "1") continue;
    table.dataset.chartRendered = "1";
    const cellChartText = (cell) => {
      const text = (cell.textContent || "").replace(/\u200B/g, "").trim();
      if (!text) return "";
      return cell.querySelector("strong, b") ? `**${text}**` : text;
    };
    const raw = table._rawTable;
    const header = raw
      ? raw.header
      : [...(table.querySelector("tr")?.querySelectorAll("th, td") || [])].map(cellChartText);
    const rows = raw
      ? raw.rows
      : [...table.querySelectorAll("tr")].slice(1).map((tr) => [...tr.querySelectorAll("td")].map(cellChartText));
    const chart = window.ompCharts.renderTableChart(header, rows);
    if (!chart || !chart.svg) continue;
    const host = el("div", "mermaid table-chart");
    host.innerHTML = chart.svg;
    const svg = host.querySelector("svg");
    if (!svg) continue;
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.maxWidth = `${chart.width || 720}px`;
    attachZoomButton(host, svg);
    table.after(host);
  }
}

function applyDiagramTransform() {
  if (diagramView.canvas) {
    diagramView.canvas.style.transform = `translate(${diagramView.x}px, ${diagramView.y}px) scale(${diagramView.scale})`;
  }
  if (diagramZoomReset) {
    diagramZoomReset.textContent = `${Math.round(diagramView.scale * 100)}%`;
  }
}

function resetDiagramZoom() {
  diagramView.scale = 1;
  diagramView.x = 0;
  diagramView.y = 0;
  applyDiagramTransform();
}

function zoomDiagramAt(nextScale, clientX, clientY) {
  if (!diagramStage) return;
  const clamped = Math.min(8, Math.max(0.25, nextScale));
  const prev = diagramView.scale;
  if (Math.abs(clamped - prev) < 0.001) return;
  const rect = diagramStage.getBoundingClientRect();
  const cx = Number.isFinite(clientX) ? clientX - (rect.left + rect.width / 2) : 0;
  const cy = Number.isFinite(clientY) ? clientY - (rect.top + rect.height / 2) : 0;
  diagramView.x = cx - ((cx - diagramView.x) / prev) * clamped;
  diagramView.y = cy - ((cy - diagramView.y) / prev) * clamped;
  diagramView.scale = clamped;
  applyDiagramTransform();
}

function zoomDiagramBy(factor) {
  zoomDiagramAt(diagramView.scale * factor);
}

function bindDiagramStage() {
  if (!diagramStage || !diagramEl) return;
  diagramStage.addEventListener("wheel", (event) => {
    if (diagramEl.hidden) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
    zoomDiagramAt(diagramView.scale * factor, event.clientX, event.clientY);
  }, { passive: false });
  diagramStage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (Math.abs(diagramView.scale - 1) > 0.05 || Math.hypot(diagramView.x, diagramView.y) > 4) {
      resetDiagramZoom();
    } else {
      zoomDiagramAt(2, event.clientX, event.clientY);
    }
  });
  diagramStage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    diagramView.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: diagramView.x,
      originY: diagramView.y,
    };
    diagramStage.classList.add("dragging");
    diagramStage.setPointerCapture(event.pointerId);
  });
  diagramStage.addEventListener("pointermove", (event) => {
    const drag = diagramView.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    diagramView.x = drag.originX + (event.clientX - drag.startX);
    diagramView.y = drag.originY + (event.clientY - drag.startY);
    applyDiagramTransform();
  });
  const endDrag = (event) => {
    if (!diagramView.drag || event.pointerId !== diagramView.drag.pointerId) return;
    diagramView.drag = null;
    diagramStage.classList.remove("dragging");
  };
  diagramStage.addEventListener("pointerup", endDrag);
  diagramStage.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", (event) => {
    if (diagramEl.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDiagram();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomDiagramBy(1.25);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomDiagramBy(1 / 1.25);
    } else if (event.key === "0") {
      event.preventDefault();
      resetDiagramZoom();
    }
  });
}

function openDiagram(svg) {
  if (!svg || !diagramEl || !diagramStage) return;
  const copy = svg.cloneNode(true);
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  copy.style.width = "100%";
  copy.style.height = "100%";
  copy.style.maxWidth = "100%";
  copy.style.maxHeight = "100%";
  const canvas = el("div", "diagram-canvas");
  canvas.append(copy);
  diagramView.canvas = canvas;
  diagramStage.replaceChildren(canvas);
  resetDiagramZoom();
  diagramEl.hidden = false;
}

function closeDiagram() {
  if (!diagramEl || !diagramStage) return;
  diagramEl.hidden = true;
  diagramView.canvas = null;
  diagramView.drag = null;
  diagramStage.classList.remove("dragging");
  diagramStage.replaceChildren();
}

function applyMascotPosition() {
  if (!mascotDock || mascotDock.hidden) return;
  if (!Number.isFinite(state.mascot.x) || !Number.isFinite(state.mascot.bottom)) {
    mascotDock.style.left = "";
    mascotDock.style.top = "";
    mascotDock.style.right = "22px";
    mascotDock.style.bottom = "92px";
    return;
  }
  const width = mascotDock.offsetWidth || 160;
  const height = mascotDock.offsetHeight || 140;
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxBottom = Math.max(8, window.innerHeight - height - 8);
  const clampedX = Math.min(Math.max(8, state.mascot.x), maxX);
  const clampedBottom = Math.min(Math.max(8, state.mascot.bottom), maxBottom);
  mascotDock.style.right = "auto";
  mascotDock.style.top = "auto";
  mascotDock.style.left = `${clampedX}px`;
  mascotDock.style.bottom = `${clampedBottom}px`;
}

function saveMascotPrefs(patch) {
  vscode.postMessage({
    type: "saveMascotPrefs",
    prefs: {
      mode: state.mascot.mode,
      minimized: state.mascot.minimized,
      x: state.mascot.x,
      bottom: state.mascot.bottom,
      ...patch,
    },
  });
}

function openMascotMenu(clientX, clientY) {
  if (!mascotMenu) return;
  mascotMenu.replaceChildren();
  const modes = [
    { id: "auto", label: "Show: Auto (follow session)" },
    { id: "both", label: "Show: Both (OMP & Claude)" },
    { id: "claude", label: "Show: Claude-tan only" },
    { id: "omp", label: "Show: OMP-tan only" },
  ];
  for (const item of modes) {
    const btn = el("button", `mascot-menu-item${state.mascot.mode === item.id ? " active" : ""}`, item.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.mascot.mode = item.id;
      state.mascot.minimized = false;
      saveMascotPrefs({ mode: item.id, minimized: false });
      closeMascotMenu();
      renderMascots();
    });
    mascotMenu.append(btn);
  }
  mascotMenu.append(el("div", "mascot-menu-sep"));
  const speedsBtn = el("button", "mascot-menu-item", "Model token speeds…");
  speedsBtn.type = "button";
  speedsBtn.addEventListener("click", () => {
    closeMascotMenu();
    openSpeedsModal();
  });
  mascotMenu.append(speedsBtn);
  mascotMenu.append(el("div", "mascot-menu-sep"));
  const pickClaude = el("button", "mascot-menu-item", "Custom Claude image…");
  pickClaude.type = "button";
  pickClaude.addEventListener("click", () => {
    closeMascotMenu();
    vscode.postMessage({ type: "pickMascotImage", target: "claude" });
  });
  const pickOmp = el("button", "mascot-menu-item", "Custom OMP image…");
  pickOmp.type = "button";
  pickOmp.addEventListener("click", () => {
    closeMascotMenu();
    vscode.postMessage({ type: "pickMascotImage", target: "omp" });
  });
  mascotMenu.append(pickClaude, pickOmp);
  if (state.mascot.hasCustom) {
    const resetBtn = el("button", "mascot-menu-item", "Reset default images");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", () => {
      closeMascotMenu();
      vscode.postMessage({ type: "resetMascotImages" });
    });
    mascotMenu.append(resetBtn);
  }
  mascotMenu.append(el("div", "mascot-menu-sep"));
  const minLabel = state.mascot.minimized ? "Expand mascot" : "Minimize to pill";
  const minBtn = el("button", "mascot-menu-item", minLabel);
  minBtn.type = "button";
  minBtn.addEventListener("click", () => {
    state.mascot.minimized = !state.mascot.minimized;
    saveMascotPrefs({ minimized: state.mascot.minimized });
    closeMascotMenu();
    renderMascots();
  });
  mascotMenu.append(minBtn);
  mascotMenu.hidden = false;
  const width = mascotMenu.offsetWidth || 190;
  const height = mascotMenu.offsetHeight || 180;
  const left = Math.min(Math.max(8, clientX - width + 24), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, clientY - height - 6), Math.max(8, window.innerHeight - height - 8));
  mascotMenu.style.left = `${left}px`;
  mascotMenu.style.top = `${top}px`;
}

function closeMascotMenu() {
  if (mascotMenu) mascotMenu.hidden = true;
}

function bindMascotWidget() {
  if (!mascotDock) return;
  let drag = null;
  mascotDock.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMascotMenu(event.clientX, event.clientY);
  });
  mascotDock.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".mascot-gear")) return;
    closeMascotMenu();
    const rect = mascotDock.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originBottom: window.innerHeight - rect.bottom,
      moved: false,
    };
    mascotDock.dataset.dragged = "0";
    mascotDock.setPointerCapture(event.pointerId);
  });
  mascotDock.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    mascotDock.dataset.dragged = "1";
    mascotDock.classList.add("dragging");
    state.mascot.x = Math.round(drag.originLeft + dx);
    state.mascot.bottom = Math.round(drag.originBottom - dy);
    applyMascotPosition();
  });
  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    mascotDock.classList.remove("dragging");
    if (moved) {
      saveMascotPrefs({ x: state.mascot.x, bottom: state.mascot.bottom });
      setTimeout(() => {
        mascotDock.dataset.dragged = "0";
      }, 0);
    }
  };
  mascotDock.addEventListener("pointerup", finishDrag);
  mascotDock.addEventListener("pointercancel", finishDrag);
  window.addEventListener("resize", () => applyMascotPosition());
  document.addEventListener("mousedown", (event) => {
    if (mascotMenu && !mascotMenu.hidden && !mascotMenu.contains(event.target) && !event.target.closest(".mascot-gear")) {
      closeMascotMenu();
    }
  });
}

function openSpeedsModal() {
  if (!speedsModal) return;
  state.speedsOpen = true;
  speedsModal.hidden = false;
  renderSpeedsModal();
}

function closeSpeedsModal() {
  if (!speedsModal) return;
  state.speedsOpen = false;
  speedsModal.hidden = true;
  speedsModal.replaceChildren();
}

function aggregateModelSpeeds() {
  const groups = new Map();
  for (const session of state.sessions) {
    if (state.speedsSource !== "all" && session.source !== state.speedsSource) continue;
    if (state.speedsScope === "workspace" && !session.inWorkspace) continue;
    const model = shortModel(session.model);
    if (!model) continue;
    const key = `${session.source}:${model.toLowerCase()}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        source: session.source,
        sourceLabel: session.source === "omp" ? "OMP" : "Claude",
        model,
        sessions: 0,
        outputTokens: 0,
        genMs: 0,
        ttftWeightedMs: 0,
        ttftSamples: 0,
        totalTokens: 0,
        cost: 0,
      };
      groups.set(key, row);
    }
    row.sessions += 1;
    row.totalTokens += Number(session.totalTokens) || 0;
    row.cost += Number(session.cost) || 0;
    const out = Number(session.outputTokens) || 0;
    const ms = Number(session.genMs) || 0;
    if (out > 0 && ms > 0) {
      row.outputTokens += out;
      row.genMs += ms;
    }
    const ttftCount = Number(session.ttftCount) || 0;
    const avgTtft = Number(session.avgTtftMs) || 0;
    if (ttftCount > 0 && avgTtft > 0) {
      row.ttftSamples += ttftCount;
      row.ttftWeightedMs += avgTtft * ttftCount;
    }
  }
  const list = [...groups.values()].map((row) => ({
    ...row,
    tokPerSec: row.outputTokens > 0 && row.genMs > 0 ? (row.outputTokens * 1000) / row.genMs : 0,
    avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftWeightedMs / row.ttftSamples) : 0,
  }));
  list.sort((a, b) => (b.tokPerSec - a.tokPerSec) || (b.totalTokens - a.totalTokens));
  return list;
}

function renderSpeedsModal() {
  if (!speedsModal || !state.speedsOpen) return;
  const rows = aggregateModelSpeeds();
  const maxTps = rows.reduce((max, item) => Math.max(max, item.tokPerSec), 0) || 1;

  const card = el("div", "speeds-card");
  card.addEventListener("click", (event) => event.stopPropagation());

  const head = el("div", "speeds-head");
  const titleWrap = el("div", "speeds-title-wrap");
  titleWrap.append(
    el("h3", "speeds-title", "Model Token Throughput"),
    el("span", "speeds-sub", "Weighted output tokens ÷ API generation time across local sessions"),
  );
  const closeBtn = el("button", "speeds-close", "Close");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", closeSpeedsModal);
  head.append(titleWrap, closeBtn);

  const toolbar = el("div", "speeds-toolbar");
  const sourceGroup = el("div", "chips");
  for (const [id, label] of [["all", "All"], ["omp", "OMP"], ["claude", "Claude Code"]]) {
    const btn = el("button", `chip${state.speedsSource === id ? " active" : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.speedsSource = id;
      renderSpeedsModal();
    });
    sourceGroup.append(btn);
  }
  const scopeGroup = el("div", "chips");
  for (const [id, label] of [["all", "All workspaces"], ["workspace", "This workspace"]]) {
    const btn = el("button", `scope${state.speedsScope === id ? " active" : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.speedsScope = id;
      renderSpeedsModal();
    });
    scopeGroup.append(btn);
  }
  toolbar.append(sourceGroup, scopeGroup);

  const body = el("div", "speeds-body");
  if (!rows.length) {
    body.append(el("div", "empty", "No model usage data found for this filter."));
  } else {
    const table = el("table", "speeds-table");
    const thead = el("thead");
    const trHead = el("tr");
    for (const h of ["Model", "Source", "Throughput (tok/s)", "Avg TTFT", "Output Tok", "Sessions", "Cost"]) {
      trHead.append(el("th", "", h));
    }
    thead.append(trHead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      const tdModel = el("td", "speeds-model", row.model);
      const tdSource = el("td");
      tdSource.append(el("span", `source-tag ${row.source}`, row.sourceLabel));
      const tdTps = el("td", "speeds-tps-cell");
      if (row.tokPerSec > 0) {
        const barWrap = el("div", "speeds-bar-wrap");
        const bar = el("div", `speeds-bar ${row.source}`);
        bar.style.width = `${Math.max(4, Math.round((row.tokPerSec / maxTps) * 100))}%`;
        barWrap.append(bar);
        const val = el("span", "speeds-tps-val", `${row.tokPerSec.toFixed(1)} tok/s`);
        tdTps.append(val, barWrap);
      } else {
        tdTps.textContent = "—";
      }
      const tdTtft = el("td", "speeds-num", row.avgTtftMs > 0 ? formatTtft(row.avgTtftMs) : "—");
      const tdOut = el("td", "speeds-num", formatCompactTokens(row.outputTokens) || "—");
      const tdSessions = el("td", "speeds-num", String(row.sessions));
      const tdCost = el("td", "speeds-num", formatUSD(row.cost) || "—");
      tr.append(tdModel, tdSource, tdTps, tdTtft, tdOut, tdSessions, tdCost);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    body.append(table);
  }

  card.append(head, toolbar, body);
  speedsModal.replaceChildren(card);
}

speedsModal?.addEventListener("click", closeSpeedsModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.speedsOpen) {
    event.preventDefault();
    closeSpeedsModal();
  }
});
