import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { PiAgent, isolatedResources } from "../src/agent.js";
test("real Pi SDK uses isolated resources and native persistent session with demo provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-pi-"));
  const store = new Store(dir);
  try {
    const agent = new PiAgent(store);
    const input = {
      prompt: "<current_document>version 2</current_document>",
      url: "https://example.com",
      signal: AbortSignal.timeout(10000),
      onSession: () => {},
    };
    const first = await agent.reply(input);
    assert.match(first.text, /离线演示/);
    assert.ok(readFileSync(first.sessionPath, "utf8").includes("version 2"));
    const next = await agent.reply({
      ...input,
      prompt: "继续分析",
      sessionId: first.sessionId,
      sessionPath: first.sessionPath,
    });
    assert.equal(first.sessionId, next.sessionId);
    assert.match(next.text, /第 2 条用户消息/);
    assert.deepEqual(isolatedResources().getAgentsFiles().agentsFiles, []);
    assert.deepEqual(isolatedResources().getExtensions().extensions, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("long native session invokes SDK compaction and preserves its identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-pi-compact-"));
  const store = new Store(dir);
  try {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const agent = new PiAgent(store);
    const input = {
      prompt: "开始研究",
      url: "https://example.com",
      signal: AbortSignal.timeout(10000),
      onSession: () => {},
    };
    const first = await agent.reply(input);
    const manager = SessionManager.open(first.sessionPath);
    for (let i = 0; i < 12; i++) {
      manager.appendMessage({
        role: "user",
        content: "资料摘录 " + "内容 ".repeat(2500),
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "已分析这一段。" }],
        api: "openai-completions",
        provider: "mr-on-demo",
        model: "offline-fixture",
        usage: {
          input: 90000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 90100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
    const next = await agent.reply({
      ...input,
      prompt: "继续研究",
      sessionId: first.sessionId,
      sessionPath: first.sessionPath,
    });
    assert.equal(next.sessionId, first.sessionId);
    assert.ok(
      SessionManager.open(first.sessionPath)
        .getEntries()
        .some((e) => e.type === "compaction"),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
