import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { assertPublicAddress } from "../src/reader.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mr-on-"));
  const store = new Store(dir);
  let text = "release 1";
  let active = 0;
  let max = 0;
  const agent = {
    async reply(input: any) {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return {
        text: `解释: ${input.prompt}`,
        sessionId: input.sessionId || crypto.randomUUID(),
        sessionPath:
          input.sessionPath || join(dir, crypto.randomUUID() + ".jsonl"),
      };
    },
  };
  const engine = new Engine(store, agent, async () => text);
  const task = store.createTask({
    name: "Pi 版本",
    url: "https://example.com/releases",
    goal: "跟踪兼容性变化",
    intervalMinutes: 60,
  });
  return {
    dir,
    store,
    engine,
    task,
    setText: (s: string) => (text = s),
    getMax: () => max,
    clean() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("baseline and unchanged checks stay quiet; changes create durable item and reuse its session on reply", async () => {
  const x = setup();
  try {
    await x.engine.runNow(x.task.id);
    assert.equal(x.store.snapshot().notifications.length, 0);
    await x.engine.runNow(x.task.id);
    assert.equal(x.store.snapshot().notifications.length, 0);
    x.setText("release 2 breaking API");
    await x.engine.runNow(x.task.id);
    const first = x.store.snapshot();
    assert.equal(first.notifications.length, 1);
    assert.equal(first.items.length, 1);
    const item = first.items[0];
    assert.ok(item.sessionId);
    await x.engine.message(item.id, "影响升级吗？");
    const after = x.store.snapshot();
    assert.equal(after.items[0].sessionId, item.sessionId);
    assert.equal(after.messages.length, 2);
    assert.equal(after.messages[0].itemId, item.id);
    assert.equal(after.messages[0].taskId, x.task.id);
    await x.engine.runNow(x.task.id);
    assert.equal(x.store.snapshot().notifications.length, 1);
  } finally {
    x.clean();
  }
});
test("webhook event id is persistent and deduplicated", async () => {
  const x = setup();
  try {
    const a = x.store.receiveEvent("source-1", x.task.id, {});
    const b = x.store.receiveEvent("source-1", x.task.id, {});
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(x.store.snapshot().runs.length, 1);
    await x.engine.drain();
    assert.equal(x.store.snapshot().events[0].status, "done");
  } finally {
    x.clean();
  }
});
test("same-task runs serialize while independent tasks use bounded concurrency", async () => {
  const x = setup();
  try {
    await x.engine.runNow(x.task.id);
    x.setText("changed");
    await Promise.all([x.engine.runNow(x.task.id), x.engine.runNow(x.task.id)]);
    assert.equal(x.getMax(), 1);
    assert.equal(x.store.snapshot().notifications.length, 1);
  } finally {
    x.clean();
  }
});
test("restart coalesces missed checks and interrupts in-flight work; follow-up retains item routing", async () => {
  const x = setup();
  try {
    await x.engine.runNow(x.task.id);
    x.setText("changed");
    await x.engine.runNow(x.task.id);
    const item = x.store.snapshot().items[0];
    x.store.followup(item.id, "明天继续分析", Date.now() - 1000);
    x.store.db
      .prepare("UPDATE tasks SET nextAt=? WHERE id=?")
      .run(Date.now() - 10000000, x.task.id);
    x.store.scheduleDue();
    x.store.scheduleDue();
    assert.equal(
      x.store.snapshot().runs.filter((r: any) => r.status === "queued").length,
      2,
    );
    x.store.db
      .prepare(
        "UPDATE runs SET status='running' WHERE kind='check' AND status='queued'",
      )
      .run();
    x.store.close();
    const restored = new Store(x.dir);
    assert.ok(
      restored.snapshot().runs.some((r: any) => r.status === "interrupted"),
    );
    const engine = new Engine(
      restored,
      {
        reply: async (i: any) => ({
          text: "继续",
          sessionId: i.sessionId,
          sessionPath: i.sessionPath,
        }),
      },
      async () => "changed",
    );
    await engine.drain();
    assert.equal(restored.snapshot().items[0].sessionId, item.sessionId);
    restored.close();
  } finally {
    rmSync(x.dir, { recursive: true, force: true });
  }
});
test("private and special network ranges are rejected, including mapped IPv6", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "100.64.0.1",
    "0.0.0.0",
  ])
    assert.throws(() => assertPublicAddress(ip));
  assert.doesNotThrow(() => assertPublicAddress("8.8.8.8"));
});
test("independent tasks run concurrently with a limit of two", async () => {
  const x = setup();
  try {
    const second = x.store.createTask({
      name: "Second",
      url: "https://example.org",
      goal: "Track releases",
      intervalMinutes: 60,
    });
    const third = x.store.createTask({
      name: "Third",
      url: "https://example.net",
      goal: "Track releases",
      intervalMinutes: 60,
    });
    for (const t of [x.task, second, third]) await x.engine.runNow(t.id);
    x.setText("updated");
    for (const t of [x.task, second, third]) x.store.enqueue(t.id);
    await x.engine.drain();
    assert.equal(x.getMax(), 2);
    assert.equal(x.store.snapshot().notifications.length, 3);
  } finally {
    x.clean();
  }
});
test("editing URL during a running check cannot overwrite the new source baseline", async () => {
  const x = setup();
  try {
    await x.engine.runNow(x.task.id);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const engine = new Engine(
      x.store,
      {
        reply: async (i: any) => ({
          text: "analysis",
          sessionId: "session",
          sessionPath: "path",
        }),
      },
      async () => {
        entered();
        await gate;
        return "old source updated";
      },
    );
    const running = engine.runNow(x.task.id);
    await ready;
    x.store.updateTask(x.task.id, { url: "https://new.example.com" });
    release();
    await running;
    assert.equal(x.store.task(x.task.id).hash, null);
    assert.equal(x.store.snapshot().notifications.length, 0);
  } finally {
    x.clean();
  }
});
test("followup state is marked interrupted at restart rather than left queued forever", () => {
  const x = setup();
  try {
    x.store.db
      .prepare(
        "INSERT INTO followups VALUES('f',?,'item','prompt',?,'queued','run')",
      )
      .run(x.task.id, Date.now());
    x.store.db
      .prepare(
        "INSERT INTO runs(id,taskId,kind,status,createdAt) VALUES('run',?,'followup','running',?)",
      )
      .run(x.task.id, Date.now());
    x.store.close();
    const restored = new Store(x.dir);
    assert.equal(restored.snapshot().followups[0].status, "interrupted");
    restored.close();
  } finally {
    rmSync(x.dir, { recursive: true, force: true });
  }
});
test("snapshot retains older items referenced by recent notifications and pending followups", () => {
  const x = setup();
  try {
    for (let i = 0; i < 102; i++)
      x.store.db
        .prepare("INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          "item-" + i,
          x.task.id,
          "run-" + i,
          "hash-" + i,
          "title",
          "summary",
          "session-" + i,
          "path",
          Date.now() + i,
        );
    x.store.followup("item-0", "future analysis", Date.now() + 60000);
    x.store.db
      .prepare(
        "INSERT INTO notifications(id,taskId,itemId,runId,sessionId,title,body,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run("note", x.task.id, "item-1", "r", "s", "title", "body", Date.now());
    const snapshot = x.store.snapshot();
    assert.ok(snapshot.items.some((i) => i.id === "item-0"));
    assert.ok(snapshot.items.some((i) => i.id === "item-1"));
  } finally {
    x.clean();
  }
});
test("event id deduplication survives reopening the SQLite database", () => {
  const x = setup();
  try {
    x.store.receiveEvent("persisted", x.task.id, { release: "v2" });
    x.store.close();
    const restored = new Store(x.dir);
    assert.equal(
      restored.receiveEvent("persisted", x.task.id, {}).duplicate,
      true,
    );
    assert.equal(restored.snapshot().runs.length, 1);
    restored.close();
  } finally {
    rmSync(x.dir, { recursive: true, force: true });
  }
});
