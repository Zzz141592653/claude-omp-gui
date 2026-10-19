const test = require("node:test");
const assert = require("node:assert/strict");
const { panelIsOpen, releaseClosedPanel, formatStatusText } = require("../panel-life");

function disposedPanel() {
  return {
    get webview() {
      throw new Error("Webview is disposed");
    },
  };
}

test("a closed panel is not reusable", () => {
  assert.equal(panelIsOpen(undefined), false);
  assert.equal(panelIsOpen(disposedPanel()), false);
  assert.equal(panelIsOpen({ webview: {} }), true);
});

test("closing a panel drops it when the disposed webview throws", () => {
  let panel = { id: 1 };
  const closed = disposedPanel();
  releaseClosedPanel(
    () => {
      panel = undefined;
    },
    () => {
      void closed.webview;
    }
  );
  assert.equal(panel, undefined);
});

test("a different cleanup error still drops the closed panel", () => {
  let panel = { webview: {} };
  assert.throws(
    () =>
      releaseClosedPanel(
        () => {
          panel = undefined;
        },
        () => {
          throw new Error("disk full");
        }
      ),
    /disk full/
  );
  assert.equal(panel, undefined);
});

test("status bar text always keeps the Sessions label visible alongside live counts", () => {
  assert.equal(formatStatusText(0, 0), "$(comment-discussion) Sessions");
  assert.equal(formatStatusText(1, 0), "$(comment-discussion) Sessions · 1 running");
  assert.equal(formatStatusText(0, 2), "$(comment-discussion) Sessions · 2 new");
  assert.equal(formatStatusText(2, 3), "$(comment-discussion) Sessions · 2 running · 3 new");
});
