const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Mermaid's sequence lexer ends a statement at ";", so any semicolon inside sequence
// text (message, note, participant alias, block label, title) makes the whole diagram
// fail to parse. Both webviews must escape it as the "#59;" entity.
const HOSTS = ["media/panel.js", "media/fileview.js"];

function loadEscape(host) {
  const src = fs.readFileSync(path.join(__dirname, "..", host), "utf8");
  const match = /function escapeMermaidSequenceSemicolons\(source\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(match, `${host} should define escapeMermaidSequenceSemicolons`);
  return new Function(`return (${match[0]})`)();
}

function loadFormatError(host) {
  const src = fs.readFileSync(path.join(__dirname, "..", host), "utf8");
  const match = /function formatMermaidError\(result\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(match, `${host} should define formatMermaidError`);
  return new Function(`return (${match[0]})`)();
}

function loadDiagramSizer(host) {
  const src = fs.readFileSync(path.join(__dirname, "..", host), "utf8");
  const start = src.indexOf("function parseDiagramNaturalWidth(svg)");
  const end = src.indexOf("function attachZoomButton(host, getSvg)");
  assert.ok(start >= 0 && end > start, `${host} should define parseDiagramNaturalWidth and sizeDiagramSvg`);
  return new Function(`${src.slice(start, end)}\nreturn { parseDiagramNaturalWidth, sizeDiagramSvg };`)();
}

for (const host of HOSTS) {
  const escapeSeq = loadEscape(host);

  test(`${host}: a semicolon inside message text is escaped so the diagram parses`, () => {
    assert.equal(
      escapeSeq(`    Wire->>Algo: <br/>"Bank; Prelim Talks"`),
      `    Wire->>Algo: <br/>"Bank#59; Prelim Talks"`
    );
  });

  test(`${host}: a semicolon inside note, alias, block label and title text is escaped`, () => {
    const source = [
      "sequenceDiagram",
      "    title Phase; Two",
      "    participant A as Alpha; Beta",
      "    Note over A: 收盘; 跳水",
      "    alt choice; other",
      "        A->>A: hi",
      "    end",
    ].join("\n");
    assert.equal(
      escapeSeq(source),
      [
        "sequenceDiagram",
        "    title Phase#59; Two",
        "    participant A as Alpha#59; Beta",
        "    Note over A: 收盘#59; 跳水",
        "    alt choice, other",
        "        A->>A: hi",
        "    end",
      ].join("\n")
    );
  });

  test(`${host}: a trailing semicolon keeps its statement-terminator meaning`, () => {
    assert.equal(escapeSeq("    A->>B: done;"), "    A->>B: done;");
  });

  test(`${host}: comments and semicolon-free sources are left untouched`, () => {
    const source = ["sequenceDiagram", "    %% keep; this as written", "    A->>B: plain text"].join("\n");
    assert.equal(escapeSeq(source), source);
  });

  const formatError = loadFormatError(host);

  test(`${host}: a parse failure names the offending line in the banner`, () => {
    assert.equal(
      formatError({
        svg: "",
        error:
          'Parse error on line 11:\n... W/ DoorDash & Uber"    Algo->>Book: 15\n-----------------------^\nExpecting SOLID_OPEN_ARROW, got NEWLINE',
      }),
      "mermaid: parse error at line 11 — showing source"
    );
  });

  test(`${host}: an unfinished snippet is reported as incomplete, not as a syntax error`, () => {
    assert.equal(
      formatError({ svg: "", error: "incomplete diagram", incomplete: true }),
      "mermaid: incomplete diagram — showing source"
    );
  });

  test(`${host}: errors without a line number fall back to a generic banner`, () => {
    assert.equal(formatError({ svg: "", error: "Syntax error" }), "mermaid: could not render this diagram — showing source");
    assert.equal(formatError(undefined), "mermaid: could not render this diagram — showing source");
  });

  const { sizeDiagramSvg } = loadDiagramSizer(host);

  function makeStubSvg(attrs = {}) {
    const bag = new Map(Object.entries(attrs));
    const style = {
      width: "",
      height: "",
      maxWidth: "",
      minWidth: "",
      removeProperty(prop) {
        if (prop === "min-width") this.minWidth = "";
      },
    };
    return {
      style,
      getAttribute(name) {
        return bag.has(name) ? bag.get(name) : null;
      },
      removeAttribute(name) {
        bag.delete(name);
      },
    };
  }

  test(`${host}: diagrams cap maxWidth at their natural viewBox width so narrow diagrams do not stretch`, () => {
    const svg = makeStubSvg({ viewBox: "0 0 446 910", height: "910" });
    sizeDiagramSvg(svg);
    assert.equal(svg.getAttribute("height"), null);
    assert.equal(svg.style.width, "100%");
    assert.equal(svg.style.height, "auto");
    assert.equal(svg.style.maxWidth, "446px");
  });

  test(`${host}: diagrams without viewBox or width fall back to 100% maxWidth`, () => {
    const svg = makeStubSvg({});
    sizeDiagramSvg(svg);
    assert.equal(svg.style.maxWidth, "100%");
  });
}
