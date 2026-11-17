import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
test("local API rejects foreign origins and unauthenticated hooks; demo is complete and keys stay server-side", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-http-"));
  const { app, store, engine } = createApp(dir, "test-hook-secret");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  const call = (
    path: string,
    body?: any,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal(
      (await call("/api/demo/start", {}, { origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/webhook", { eventId: "1", taskId: "x" })).status,
      401,
    );
    const demo = (await (await call("/api/demo/start", {})).json()) as any;
    assert.ok(demo.taskId);
    await engine.drain();
    let s = (await (await call("/api/state")).json()) as any;
    assert.equal(s.notifications.length, 0);
    await call("/api/demo/change", {});
    await engine.drain();
    s = (await (await call("/api/state")).json()) as any;
    assert.equal(s.notifications.length, 1);
    const item = s.items[0];
    await call(`/api/items/${item.id}/messages`, { text: "有什么影响？" });
    await engine.drain();
    s = (await (await call("/api/state")).json()) as any;
    assert.equal(s.items[0].sessionId, item.sessionId);
    assert.equal(s.messages.length, 2);
    const auth = {
      authorization:
        "Basic " + Buffer.from("events:test-hook-secret").toString("base64"),
    };
    assert.equal(
      (
        await call(
          "/api/webhook",
          { eventId: "one", taskId: demo.taskId },
          auth,
        )
      ).status,
      202,
    );
    assert.equal(
      (
        (await (
          await call(
            "/api/webhook",
            { eventId: "one", taskId: demo.taskId },
            auth,
          )
        ).json()) as any
      ).duplicate,
      true,
    );
    await engine.drain();
    await call("/api/config", { mode: "demo", apiKey: "SECRET-NEVER-RETURN" });
    const raw = await (await call("/api/state")).text();
    assert.ok(!raw.includes("SECRET-NEVER-RETURN"));
    assert.equal(JSON.parse(raw).config.hasKey, true);
    assert.match(await (await fetch(base)).text(), /mr-on/);
  } finally {
    await engine.stop();
    await new Promise<void>((r, e) =>
      server.close((err) => (err ? e(err) : r())),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retry retains external event and followup associations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-http-retry-"));
  const { app, store, engine } = createApp(dir, "token");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const task = store.createTask({
      name: "demo",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    const receipt = store.receiveEvent("failed-event", task.id, {});
    store.db
      .prepare("UPDATE runs SET status='failed' WHERE id=?")
      .run(receipt.runId!);
    store.db
      .prepare("UPDATE events SET status='failed' WHERE id='failed-event'")
      .run();
    const result = (await (
      await fetch(base + `/api/runs/${receipt.runId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as any;
    await engine.drain();
    assert.equal(store.snapshot().events[0].status, "done");
    assert.equal(
      store.snapshot().runs.find((r) => r.id === result.runId)?.eventId,
      "failed-event",
    );
  } finally {
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retrying the same failed run is idempotently rejected after its first replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-retry-once-"));
  const { app, store, engine } = createApp(dir, "token");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const task = store.createTask({
      name: "demo",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    const id = store.enqueue(task.id);
    store.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(id);
    const retry = () =>
      fetch(base + `/api/runs/${id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await retry()).status, 202);
    assert.equal((await retry()).status, 400);
    await engine.drain();
    assert.equal(store.snapshot().runs.length, 2);
    assert.equal(
      store.snapshot().runs.find((r) => r.id === id)?.status,
      "retried",
    );
    assert.ok(store.snapshot().runs.find((r) => r.id === id)?.retryRunId);
  } finally {
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("profile API pushes state changes over SSE and supports complete client round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-profile-http-"));
  const { app, store, engine, profile, closeStreams } = createApp(dir, "token");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const controller = new AbortController();
  const call = (path: string, body: unknown = {}, method = "POST") =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const response = await fetch(base + "/api/stream", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /event: ready/,
    );
    const initial = (await (await fetch(base + "/api/profile")).json()) as any;
    assert.equal(initial.invitations.length, 1);
    const pending = reader.read();
    const sent = await call("/api/profile/answers", {
      requestId: "profile-http",
      dimension: "goals",
      text: "完成产品验证",
    });
    assert.equal(sent.status, 202);
    assert.match(
      new TextDecoder().decode((await pending).value),
      /event: update/,
    );
    await profile.drain();
    const state = (await (await fetch(base + "/api/state")).json()) as any;
    assert.ok(state.profile.sessionId);
    assert.equal(state.profile.facts.goals.value, "完成产品验证");
    assert.equal(state.profile.invitations[0].status, "answered");
    assert.equal(
      (
        await call(
          "/api/profile/facts",
          { facts: { goals: "新目标" } },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(profile.snapshot().sessionId, null);
    assert.equal((await call("/api/profile/forget")).status, 200);
    assert.equal(profile.snapshot().enabled, false);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    controller.abort();
    closeStreams();
    await Promise.all([engine.stop(), profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("valid multi-field Chinese profile fits the bounded batch endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-profile-body-"));
  const { app, store, engine, profile } = createApp(dir, "token");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const facts = Object.fromEntries(
      profile.questions.map((q) => [q.id, "字".repeat(4000)]),
    );
    const response = await fetch(base + "/api/profile/facts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts }),
    });
    assert.equal(response.status, 200);
    assert.equal(profile.snapshot().facts.background.value.length, 4000);
  } finally {
    await Promise.all([engine.stop(), profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
