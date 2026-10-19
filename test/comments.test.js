const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRecord, openRound, closeRound, noteLiveFile } = require("../comments");

test("an old comment list becomes the current review", () => {
  const record = normalizeRecord({ comments: [{ id: "a", body: "keep" }] });
  assert.equal(record.current.comments.length, 1);
  assert.equal(record.current.comments[0].id, "a");
  assert.deepEqual(record.versions, []);
  assert.equal(record.comments, undefined);
});

test("opening a changed file archives the review and starts empty", () => {
  const record = normalizeRecord(null);
  record.current = {
    comments: [{ id: "a", body: "old" }],
    baseHash: "hash-v1",
    snapshot: "/tmp/v1.txt",
  };
  const archived = openRound(record, "version two");
  assert.equal(archived, true);
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].comments[0].id, "a");
  assert.equal(record.versions[0].snapshot, "/tmp/v1.txt");
  assert.deepEqual(record.current.comments, []);
  assert.notEqual(record.current.baseHash, "hash-v1");
});

test("opening the same text keeps the current comments", () => {
  const record = normalizeRecord(null);
  openRound(record, "same text");
  record.current.comments.push({ id: "a", body: "here" });
  const hash = record.current.baseHash;
  const archived = openRound(record, "same text");
  assert.equal(archived, false);
  assert.equal(record.versions.length, 0);
  assert.equal(record.current.comments.length, 1);
  assert.equal(record.current.baseHash, hash);
});

test("a review with no saved text is not archived on the first open", () => {
  const record = normalizeRecord({ comments: [{ id: "a", body: "existing" }] });
  const archived = openRound(record, "whatever is on disk now");
  assert.equal(archived, false);
  assert.equal(record.versions.length, 0);
  assert.equal(record.current.comments.length, 1);
  assert.ok(record.current.baseHash);
});

test("an empty review follows the file while it is open", () => {
  const record = normalizeRecord(null);
  openRound(record, "first");
  const moved = noteLiveFile(record, "second");
  assert.equal(moved, true);
  assert.equal(record.versions.length, 0);
  assert.notEqual(record.current.baseHash, "");
  const again = noteLiveFile(record, "second");
  assert.equal(again, false);
});

test("sending closes the review and the next one starts empty", () => {
  const record = normalizeRecord(null);
  openRound(record, "draft");
  record.current.comments.push({ id: "a", body: "send me" });
  record.current.snapshot = "/tmp/draft.txt";
  const closed = closeRound(record, "draft");
  assert.equal(closed, true);
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].reason, "send");
  assert.equal(record.versions[0].comments[0].id, "a");
  assert.deepEqual(record.current.comments, []);
  assert.equal(closeRound(record, "draft"), false);
});

test("openReviewedFile creates FileView with search bar, focusFindInFileView, and renders Markdown + KaTeX", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const Module = require("module");

  const postedMessages = [];
  let messageHandler = null;
  let webviewHtml = "";
  const mockVscode = {
    ViewColumn: { Active: 1 },
    Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
    RelativePattern: class {},
    workspace: {
      createFileSystemWatcher: () => ({ onDidChange() {}, dispose() {} }),
    },
    commands: { executeCommand: () => Promise.resolve() },
    window: {
      createWebviewPanel: () => {
        const webview = {
          cspSource: "vscode-webview-resource:",
          asWebviewUri: (u) => u.toString(),
          onDidReceiveMessage: (fn) => { messageHandler = fn; },
          postMessage: (msg) => { postedMessages.push(msg); return Promise.resolve(true); },
          get html() { return webviewHtml; },
          set html(v) { webviewHtml = v; },
        };
        return {
          title: "",
          active: true,
          reveal() {},
          onDidDispose() {},
          webview,
        };
      },
    },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return mockVscode;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../review")];
    const { openReviewedFile, focusFindInFileView } = require("../review");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-review-"));
    const mdFile = path.join(tmpDir, "note.md");
    fs.writeFileSync(mdFile, "以**哥伦比娅（少女）**为核心：$\\frac{125\\%}{160\\%} = \\mathbf{78.125\\%}$\n");
    const ctx = {
      extensionPath: path.resolve(__dirname, ".."),
      globalStorageUri: { fsPath: tmpDir },
    };
    await openReviewedFile(ctx, { file: mdFile, line: 1 }, null);
    await messageHandler({ type: "ready" });
    const stateMsg = postedMessages.find((m) => m.type === "state");
    for (const id of ["file", "session", "notice", "doc", "comments", "version-row", "version", "send", "diff", "find", "find-count", "find-prev", "find-next", "menu", "popover", "diagram"]) {
      assert.ok(webviewHtml.includes(`id="${id}"`), `Missing #${id} in FileView HTML`);
    }
    assert.ok(stateMsg?.html.includes("<strong>哥伦比娅（少女）</strong>"));
    assert.ok(stateMsg?.html.includes("class=\"katex\""));
    assert.equal(focusFindInFileView(), true);
    assert.ok(postedMessages.some((m) => m.type === "focusFind"));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    Module._load = origLoad;
  }
});
