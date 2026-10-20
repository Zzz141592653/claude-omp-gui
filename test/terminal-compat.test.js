const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function loadReview(vscode, childProcess, filesystem = fs) {
  const filename = path.resolve(__dirname, "../review.js");
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, console, Buffer, Error, setTimeout, clearTimeout,
    require(name) {
      if (name === "vscode") return vscode;
      if (name === "child_process") return childProcess;
      if (name === "fs") return filesystem;
      return originalRequire(name);
    },
  }, { filename });
  return module.exports;
}

test("unsupported or unidentifiable hosts never automate an application or stage the prompt", async (t) => {
  const cases = [
    ["Warp", "1 /Applications/Warp.app/Contents/MacOS/stable", false],
    ["Warp Preview", "1 /Applications/Warp Preview.app/Contents/MacOS/warp", false],
    ["unknown host", "1 /Applications/Other.app/Contents/MacOS/Other", false],
    ["misleading child arguments", "1 /bin/sh -c echo /Applications/Terminal.app/Contents/MacOS/Terminal iTerm2", false],
    ["failed process lookup", "", true],
  ];
  for (const [label, parentRow, fail] of cases) {
    await t.test(label, async () => {
      let launches = 0;
      let stagedPrompts = 0;
      const filesystem = new Proxy(fs, {
        get(target, key) {
          if (key === "writeFileSync") return (file, ...args) => {
            if (path.basename(file).startsWith("agent-sessions-prompt-")) stagedPrompts++;
            return target.writeFileSync(file, ...args);
          };
          return target[key];
        },
      });
      const childProcess = {
        execFileSync(command, args) {
          assert.equal(command, "ps");
          if (fail) throw new Error("process unavailable");
          if (args[0] === "-t") return "111\n";
          if (args[1] === "111") return parentRow;
          throw new Error("Unexpected process lookup");
        },
        spawn() { launches++; throw new Error("Unsafe application automation"); },
      };
      const review = loadReview({ window: { terminals: [] } }, childProcess, filesystem);
      await assert.rejects(review.pasteIntoTerminal("/dev/ttysTEST", "private review content"), /Automatic sending .*not supported/);
      assert.equal(launches, 0, "unsupported sends must not launch application automation");
      assert.equal(stagedPrompts, 0, "unsupported sends must not write private prompts to disk");
    });
  }
});

test("review failures and copying keep comments open; successful sending alone closes them", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-terminal-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "client.js");
  fs.writeFileSync(file, "charge();\nread();\n");
  let onMessage;
  let state;
  let clipboard = "";
  let failClipboard = false;
  let launches = 0;
  const vscode = {
    ViewColumn: { Active: 1 },
    Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) },
    RelativePattern: class {},
    env: { clipboard: { async writeText(text) {
      if (failClipboard) throw new Error("Clipboard unavailable");
      clipboard = text;
    } } },
    workspace: { createFileSystemWatcher: () => ({ onDidChange() {}, dispose() {} }) },
    window: {
      terminals: [],
      showErrorMessage() {},
      createWebviewPanel() {
        return {
          active: true, reveal() {}, onDidDispose() {},
          webview: {
            cspSource: "vscode-webview-resource:", asWebviewUri: uri => uri.toString(),
            onDidReceiveMessage(handler) { onMessage = handler; },
            async postMessage(message) { if (message.type === "state") state = message; },
          },
        };
      },
    },
  };
  const childProcess = {
    execFileSync(command, args) {
      assert.equal(command, "ps");
      if (args[0] === "-ax") return "111 ttysTEST claude --resume review-session\n";
      if (args[0] === "-t") return "111\n";
      if (args[1] === "111") return "222 /bin/zsh\n";
      if (args[1] === "222") return "1 /Applications/Warp.app/Contents/MacOS/stable\n";
      throw new Error("Unexpected process lookup");
    },
    spawn() { launches++; throw new Error("Unsafe application automation"); },
  };
  const review = loadReview(vscode, childProcess);
  const context = { extensionPath: path.resolve(__dirname, ".."), globalStorageUri: { fsPath: directory } };
  await review.openReviewedFile(context, { file, line: 1 }, {
    key: "claude:review-session", source: "claude", sourceLabel: "Claude Code",
    title: "Review", filePath: path.join(directory, "review-session.jsonl"), cwd: directory,
  });
  await onMessage({ type: "ready" });
  await onMessage({ type: "add", quote: "read();", body: "Retry only this call.", startLine: 1, endLine: 1 });
  const commentId = state.comments[0].id;
  const checkOpen = () => {
    assert.equal(state.comments[0].id, commentId);
    assert.equal(state.comments[0].body, "Retry only this call.");
    assert.equal(state.versions.length, 0);
    assert.equal(state.canCopy, true);
  };
  await onMessage({ type: "send" });
  checkOpen();
  assert.match(state.notice, /Automatic sending to Warp is not supported/);
  assert.equal(launches, 0);
  await onMessage({ type: "copyComments" });
  checkOpen();
  assert.equal(clipboard, "Selection:\n> read();\n\nComment: Retry only this call.");
  failClipboard = true;
  await onMessage({ type: "copyComments" });
  checkOpen();
  assert.match(state.notice, /Clipboard unavailable/);
  failClipboard = false;
  vscode.window.terminals.push({ processId: Promise.resolve(111), show() {}, sendText() {} });
  await onMessage({ type: "send" });
  assert.equal(state.comments.length, 0);
  assert.equal(state.canCopy, false);
  assert.equal(state.versions.length, 1);
  const archivedId = state.versions[0].id;
  clipboard = "do not replace";
  await onMessage({ type: "showVersion", id: archivedId });
  assert.equal(state.comments[0].id, commentId);
  assert.equal(state.canCopy, false);
  await onMessage({ type: "copyComments" });
  assert.equal(clipboard, "do not replace", "archived comments must not be copied as the current review");
});
