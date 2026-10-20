const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasConversationEntries, hasOmpProcess, hasClaudeProcess, loadTranscript, refreshSessionMeta } = require("../sources");

test("a process exit record is not a new reply", () => {
  const entries = [
    {
      type: "custom",
      customType: "session_exit",
      data: { reason: "sigterm" },
    },
  ];
  assert.equal(hasConversationEntries("omp", entries), false);
});

test("an assistant message is a conversation update", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  assert.equal(hasConversationEntries("omp", entries), true);
});

test("a title update is not a conversation update", () => {
  assert.equal(hasConversationEntries("omp", [{ type: "title", title: "renamed" }]), false);
  assert.equal(hasConversationEntries("claude", [{ type: "ai-title", aiTitle: "renamed" }]), false);
});

test("tool activity still counts as conversation", () => {
  assert.equal(
    hasConversationEntries("omp", [{ type: "custom", customType: "tool_execution_start", data: { toolCallId: "1" } }]),
    true,
  );
  assert.equal(hasConversationEntries("claude", [{ type: "user", message: { content: [{ type: "tool_result" }] } }]), true);
});

test("hasOmpProcess matches omp and custom omp-* binaries but not unrelated child commands", () => {
  assert.equal(hasOmpProcess("-zsh\nomp\n"), true);
  assert.equal(hasOmpProcess("-zsh\nomp-gemini-test --model vertex-proxy/gemini-4-argon\n"), true);
  assert.equal(hasOmpProcess("/opt/homebrew/bin/omp-gemini-test --resume 123\n"), true);
  assert.equal(hasOmpProcess("-zsh\nnode /Users/me/.omp/plugins/start.mjs\n"), false);
});

test("hasClaudeProcess matches claude and custom claude-* binaries but not unrelated child commands", () => {
  assert.equal(hasClaudeProcess("-zsh\nclaude\n"), true);
  assert.equal(hasClaudeProcess("/Users/me/.local/bin/claude --resume d7461f7a-3215-47cd-876b-a36078b27e8e\n"), true);
  assert.equal(hasClaudeProcess("claude-code --model claude-sonnet-4-6\n"), true);
  assert.equal(hasClaudeProcess("-zsh\nnode /Users/me/.claude/plugins/cache/glean/mcp/start.mjs\n"), false);
});

test("loadTranscript extracts model, context tokens, total tokens, and cost for omp and claude", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-test-"));
  try {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
    const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    const ompFile = path.join(dir, "omp.jsonl");
    fs.writeFileSync(
      ompFile,
      [
        JSON.stringify({ type: "model_change", model: "vertex-proxy/gemini-4-argon" }),
        JSON.stringify({
          type: "message",
          timestamp: yesterdayNoon,
          message: {
            role: "assistant",
            provider: "vertex-proxy",
            model: "gemini-4-argon",
            content: [{ type: "text", text: "yesterday" }],
            duration: 4000,
            ttft: 1000,
            usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.12 } },
            contextSnapshot: { promptTokens: 1000 },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: todayNoon,
          message: {
            role: "assistant",
            provider: "vertex-proxy",
            model: "gemini-4-argon",
            content: [{ type: "text", text: "first" }],
            duration: 6000,
            ttft: 2000,
            usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0, totalTokens: 5200, cost: { total: 0.05 } },
            contextSnapshot: { promptTokens: 5000 },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: todayNoon,
          message: {
            role: "assistant",
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "error",
          },
        }),
      ].join("\n") + "\n",
    );
    const ompTranscript = loadTranscript(ompFile, "omp");
    assert.equal(ompTranscript.stats.model, "vertex-proxy/gemini-4-argon");
    assert.equal(ompTranscript.stats.contextTokens, 5000);
    assert.equal(ompTranscript.stats.totalTokens, 6300);
    assert.equal(ompTranscript.stats.outputTokens, 300);
    assert.equal(ompTranscript.stats.tokPerSec, 30);
    assert.equal(ompTranscript.stats.avgTtftMs, 1500);
    assert.equal(ompTranscript.stats.cost, 0.17);
    assert.equal(ompTranscript.stats.todayCost, 0.05);
    const claudeFile = path.join(dir, "claude.jsonl");
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: "assistant",
          requestedModel: "glm-5.3",
          message: {
            id: "msg_1",
            model: "accounts/fireworks/models/glm-5p3",
            content: [{ type: "thinking", thinking: "t" }],
            usage: { input_tokens: 300, cache_read_input_tokens: 1700, cache_creation_input_tokens: 0, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          requestedModel: "glm-5.3",
          message: {
            id: "msg_1",
            model: "accounts/fireworks/models/glm-5p3",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 300, cache_read_input_tokens: 1700, cache_creation_input_tokens: 0, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "cost-state",
          totalCostUSD: 0.42,
          totalAPIDurationWithoutRetries: 2500,
          modelUsage: {
            "glm-5.3": { inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 1700, cacheCreationInputTokens: 0 },
          },
        }),
      ].join("\n") + "\n",
    );
    const claudeTranscript = loadTranscript(claudeFile, "claude");
    assert.equal(claudeTranscript.stats.model, "glm-5.3");
    assert.equal(claudeTranscript.stats.contextTokens, 2000);
    assert.equal(claudeTranscript.stats.totalTokens, 2100);
    assert.equal(claudeTranscript.stats.outputTokens, 100);
    assert.equal(claudeTranscript.stats.tokPerSec, 40);
    assert.equal(claudeTranscript.stats.cost, 0.42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claude sessions resolve per-turn todayCost and contextWindow from cost-state without omp models.yml", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-claude-only-"));
  try {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
    const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    const claudeFile = path.join(dir, "claude-only.jsonl");
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: "assistant",
          timestamp: yesterdayNoon,
          requestedModel: "old-unlisted-model",
          message: {
            id: "msg_old",
            model: "old-unlisted-model",
            content: [{ type: "text", text: "yesterday reply" }],
            usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: todayNoon,
          requestedModel: "new-unlisted-model[1m]",
          message: {
            id: "msg_new",
            model: "new-unlisted-model[1m]",
            content: [{ type: "text", text: "today reply" }],
            usage: { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 },
          },
        }),
        JSON.stringify({
          type: "cost-state",
          totalCostUSD: 0.35,
          modelUsage: {
            "old-unlisted-model": {
              inputTokens: 1000,
              outputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.1,
            },
            "new-unlisted-model[1m]": {
              inputTokens: 2000,
              outputTokens: 200,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.25,
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const transcript = loadTranscript(claudeFile, "claude");
    assert.equal(transcript.stats.model, "new-unlisted-model[1m]");
    assert.equal(transcript.stats.contextWindow, 1_000_000);
    assert.equal(transcript.stats.cost, 0.35);
    assert.equal(transcript.stats.todayCost, 0.25);
    assert.deepEqual(transcript.stats.recentTurnCosts, [0.25]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("omp and claude sessions aggregate subagent jsonl usage and refresh when subagents grow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-subagents-"));
  try {
    const now = new Date();
    const t1 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).toISOString();
    const t2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 5, 0).toISOString();
    const t3 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 10, 0).toISOString();

    const ompParent = path.join(dir, "session-parent.jsonl");
    const ompCompanion = path.join(dir, "session-parent");
    fs.mkdirSync(ompCompanion, { recursive: true });
    fs.writeFileSync(
      ompParent,
      [
        JSON.stringify({ type: "title", title: "Parent Session" }),
        JSON.stringify({
          type: "message",
          timestamp: t1,
          message: {
            role: "assistant",
            provider: "vertex-proxy",
            model: "gemini-4-argon",
            content: [{ type: "text", text: "main turn" }],
            duration: 2000,
            ttft: 500,
            usage: { input: 2000, output: 100, cacheRead: 8000, cacheWrite: 0, totalTokens: 10100, cost: { total: 0.84 } },
            contextSnapshot: { promptTokens: 10000 },
          },
        }),
      ].join("\n") + "\n",
    );
    const sub1 = path.join(ompCompanion, "SolverAgent.jsonl");
    fs.writeFileSync(
      sub1,
      JSON.stringify({
        type: "message",
        timestamp: t2,
        message: {
          role: "assistant",
          provider: "vertex-proxy",
          model: "gemini-4-argon",
          content: [{ type: "text", text: "sub1 turn" }],
          duration: 3000,
          ttft: 700,
          usage: { input: 500, output: 150, cacheRead: 1500, cacheWrite: 0, totalTokens: 2150, cost: { total: 0.35 } },
          contextSnapshot: { promptTokens: 2000 },
        },
      }) + "\n",
    );

    const ompSession = { source: "omp", filePath: ompParent };
    refreshSessionMeta(ompSession);
    assert.equal(ompSession.title, "Parent Session");
    assert.equal(ompSession.contextTokens, 10000);
    assert.equal(ompSession.totalTokens, 12250);
    assert.equal(ompSession.outputTokens, 250);
    assert.equal(ompSession.cost, 1.19);
    assert.equal(ompSession.todayCost, 1.19);
    assert.equal(ompSession.turnCount, 2);
    assert.deepEqual(ompSession.recentTurnCosts, [0.84, 0.35]);

    const sub2 = path.join(ompCompanion, "CancellationDecompilerAgent.jsonl");
    fs.writeFileSync(
      sub2,
      JSON.stringify({
        type: "message",
        timestamp: t3,
        message: {
          role: "assistant",
          provider: "vertex-proxy",
          model: "gemini-4-argon",
          content: [{ type: "text", text: "sub2 turn" }],
          duration: 5000,
          ttft: 900,
          usage: { input: 400, output: 250, cacheRead: 1000, cacheWrite: 0, totalTokens: 1650, cost: { total: 0.2 } },
          contextSnapshot: { promptTokens: 1400 },
        },
      }) + "\n",
    );

    refreshSessionMeta(ompSession);
    assert.equal(ompSession.contextTokens, 10000);
    assert.equal(ompSession.totalTokens, 13900);
    assert.equal(ompSession.outputTokens, 500);
    assert.equal(ompSession.cost, 1.39);
    assert.equal(ompSession.turnCount, 3);
    assert.deepEqual(ompSession.recentTurnCosts, [0.84, 0.35, 0.2]);

    const ompLoaded = loadTranscript(ompParent, "omp");
    assert.equal(ompLoaded.stats.cost, 1.39);
    assert.equal(ompLoaded.stats.totalTokens, 13900);
    assert.equal(ompLoaded.stats.contextTokens, 10000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
