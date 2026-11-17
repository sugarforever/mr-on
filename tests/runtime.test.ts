import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

test("readiness tracks scheduler heartbeat and draining, without model execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-runtime-"));
  const service = createApp(dir, "token");
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/readyz")).status, 503);
    service.tick();
    assert.equal((await fetch(base + "/readyz")).status, 200);
    const state = (await (await fetch(base + "/api/state")).json()) as any;
    assert.ok(state.runtime.instanceId);
    assert.ok(state.runtime.lastTickAt >= state.runtime.startedAt);
    assert.equal(state.runtime.lastFinishedAt, null);
    service.beginStop();
    assert.equal((await fetch(base + "/readyz")).status, 503);
    assert.equal(
      (
        await fetch(base + "/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      503,
    );
  } finally {
    await Promise.all([service.engine.stop(), service.profile.stop()]);
    service.closeStreams();
    await new Promise<void>((r) => server.close(() => r()));
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale scheduler loses readiness even though HTTP is alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-stale-"));
  const service = createApp(dir, "token");
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    service.tick();
    await new Promise((r) => setTimeout(r, 5100));
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/readyz")).status, 503);
  } finally {
    await Promise.all([service.engine.stop(), service.profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
