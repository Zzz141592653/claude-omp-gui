function isDisposedError(error) {
  return Boolean(error && /disposed/i.test(String(error.message || error)));
}

function panelIsOpen(panel) {
  if (!panel) return false;
  try {
    void panel.webview;
    return true;
  } catch (error) {
    if (isDisposedError(error)) return false;
    throw error;
  }
}

function releaseClosedPanel(release, cleanup) {
  try {
    cleanup();
  } catch (error) {
    if (!isDisposedError(error)) throw error;
  } finally {
    release();
  }
}

function formatStatusText(running, fresh) {
  const bits = [];
  if (running > 0) bits.push(`${running} running`);
  if (fresh > 0) bits.push(`${fresh} new`);
  if (!bits.length) return "$(comment-discussion) Sessions";
  return `$(comment-discussion) Sessions · ${bits.join(" · ")}`;
}

module.exports = { panelIsOpen, releaseClosedPanel, formatStatusText };
