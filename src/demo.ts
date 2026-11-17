import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { PiAgent } from "./agent.js";
import { demoReader, DEMO_URL } from "./demo-data.js";
const dir = mkdtempSync(join(tmpdir(), "mr-on-demo-"));
let store = new Store(dir);
try {
  let engine = new Engine(store, new PiAgent(store), demoReader(store));
  const task = store.createTask({
    name: "Pi 发布动态",
    url: DEMO_URL,
    goal: "判断升级兼容性影响",
    intervalMinutes: 60,
  });
  await engine.runNow(task.id);
  await engine.runNow(task.id);
  assert.equal(store.snapshot().notifications.length, 0);
  console.log("✓ 初始基线 + 无变化检查：0 条通知");
  store.db.exec("UPDATE demo_document SET revision=2");
  await engine.runNow(task.id);
  const item = store.snapshot().items[0];
  assert.ok(item?.sessionId);
  console.log("✓ 资料变化 → 通知 → Pi 原生持久会话");
  await engine.message(item.id, "升级前应该验证什么？");
  assert.equal(store.snapshot().items[0].sessionId, item.sessionId);
  console.log("✓ 追问通过 itemId 路由并复用原会话");
  store.followup(item.id, "继续分析迁移步骤", Date.now() + 20);
  store.receiveEvent("demo-event-1", task.id, { source: "demo" });
  assert.equal(store.receiveEvent("demo-event-1", task.id, {}).duplicate, true);
  await engine.drain();
  console.log("✓ 持久事件收件 + eventId 去重");
  store.close();
  store = new Store(dir);
  engine = new Engine(store, new PiAgent(store), demoReader(store));
  store.scheduleDue(Date.now() + 1000);
  await engine.drain();
  assert.equal(store.snapshot().items[0].sessionId, item.sessionId);
  assert.equal(store.snapshot().notifications.length, 2);
  console.log("✓ 重启后恢复 follow-up 计划并复用 Pi 会话");
  console.log(
    "离线演示完成：真实 Pi SDK + 固定 fixture；未验证真实在线模型服务。",
  );
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
