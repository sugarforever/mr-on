import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

test("Channel shares durable history, atomic receipts, scoped replay and revocable identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-channel-"));
  const svc = createApp(dir, "hook-secret");
  const server = svc.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, body?: unknown, token?: string) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await call("/api/demo/start", {});
    await svc.engine.drain();
    await call("/api/demo/change", {});
    await svc.engine.drain();
    const item = svc.store.all("items")[0];
    const id = `research:${item.id}`;
    const path = `/api/channel/conversations/${id}`;
    const initial = await call(path);
    assert.equal(initial.status, 200);
    const snapshot = (await initial.json()) as any;
    assert.equal(snapshot.sessionId, item.sessionId);
    const input = { requestId: "shared-one", text: "继续分析" };
    const first = await call(path + "/messages", input);
    assert.equal(first.status, 202);
    const receipt = (await first.json()) as any;
    assert.ok(receipt.messageId);
    assert.ok(receipt.runId);
    await svc.engine.drain();
    assert.deepEqual(
      await (await call(path + "/messages", input)).json(),
      receipt,
    );
    assert.equal(
      (await call(path + "/messages", { ...input, text: "冲突" })).status,
      409,
    );
    const history = (await (await call(path)).json()) as any;
    assert.equal(history.messages.length, 2);
    assert.equal(history.sessionId, item.sessionId);
    const replay = (await (
      await call(path + `/events?cursor=${snapshot.cursor}`)
    ).json()) as any;
    assert.ok(
      replay.events.some((e: any) => e.type === "run" && e.status === "done"),
    );
    assert.ok(
      replay.events.every(
        (e: any, i: number) => !i || e.seq > replay.events[i - 1].seq,
      ),
    );
    assert.equal(
      ((await (await call(path + "/events?cursor=invalid")).json()) as any)
        .snapshotRequired,
      true,
    );
    assert.equal(
      (
        (await (
          await call(
            "/api/channel/conversations/profile/events?cursor=" +
              history.cursor,
          )
        ).json()) as any
      ).snapshotRequired,
      true,
    );
    assert.equal((await call(path, undefined, "hook-secret")).status, 401);
    assert.equal((await call(path + "/messages", input, "bad")).status, 401);
  } finally {
    svc.closeStreams();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentials are hash-only; revocation terminates subscriptions and protects every action", async () => {
  const { issueCredential, listCredentials, revokeCredential } =
    await import("../src/credentials.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-auth-"));
  const svc = createApp(dir, "webhook-token");
  const server = svc.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const credential = issueCredential(svc.store.db, "test CLI");
  const headers = {
    authorization: `Bearer ${credential.secret}`,
    "content-type": "application/json",
  };
  const controller = new AbortController();
  try {
    assert.ok(
      !JSON.stringify(listCredentials(svc.store.db)).includes(
        credential.secret,
      ),
    );
    assert.ok(
      !JSON.stringify(
        svc.store.db.prepare("SELECT * FROM channel_credentials").all(),
      ).includes(credential.secret),
    );
    assert.equal((await fetch(base + "/api/state", { headers })).status, 403);
    const profilePath = base + "/api/channel/conversations/profile";
    const stream = await fetch(profilePath + "/stream", {
      headers,
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /event: snapshot/,
    );
    const submitted = await fetch(profilePath + "/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "profile-via-cli",
        dimension: "goals",
        text: "验证共享画像",
      }),
    });
    assert.equal(submitted.status, 202);
    const admission = svc.store.db
      .prepare(
        "SELECT * FROM channel_requests WHERE requestId='profile-via-cli'",
      )
      .get()!;
    assert.equal(admission.principalId, credential.id);
    assert.equal(admission.channel, "cli");
    assert.ok(admission.clientId);
    await svc.profile.drain();
    const state = (await (await fetch(profilePath, { headers })).json()) as any;
    assert.equal(state.messages.length, 2);
    assert.ok(state.sessionId);
    revokeCredential(svc.store.db, credential.id);
    // Open streams close on the next authorization poll, even while idle.
    let done = false;
    const end = (async () => {
      while (!(await reader.read()).done) {}
      done = true;
    })();
    await Promise.race([
      end,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("revoked stream stayed open")), 2000),
      ),
    ]);
    assert.equal(done, true);
    for (const suffix of ["", "/events", "/stream"])
      assert.equal(
        (await fetch(profilePath + suffix, { headers })).status,
        401,
      );
    assert.equal(
      (
        await fetch(profilePath + "/messages", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      401,
    );
    const raw = await (await fetch(base + "/api/state")).text();
    assert.ok(!raw.includes(credential.secret));
    assert.ok(!raw.includes("mr_cli_"));
    svc.profile.forget();
    assert.throws(
      () =>
        svc.channel.submit(
          "profile",
          {
            requestId: "profile-via-cli",
            dimension: "goals",
            text: "验证共享画像",
          },
          { clientId: "browser", channel: "web" },
        ),
      /reset/,
    );
  } finally {
    controller.abort();
    svc.closeStreams();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic admission rolls back queue and message together; receipts survive restart and interrupted work stays manual", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-admit-"));
  let svc = createApp(dir, "hook");
  try {
    const task = svc.store.createTask({
      name: "test",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    await svc.engine.runNow(task.id);
    svc.store.db.exec(
      "UPDATE demo_document SET revision=revision+1 WHERE id=1",
    );
    await svc.engine.runNow(task.id);
    const item = svc.store.all("items")[0],
      id = "research:" + item.id;
    const input = { requestId: "restart-request", text: "持久提交" };
    const who = { clientId: "test", channel: "web" as const };
    svc.store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON channel_requests BEGIN SELECT RAISE(ABORT,'test rollback'); END;",
    );
    assert.throws(() => svc.channel.submit(id, input, who), /rollback/);
    assert.equal(svc.store.all("messages").length, 0);
    assert.equal(
      svc.store.all("runs").filter((r) => r.kind === "message").length,
      0,
    );
    svc.store.db.exec("DROP TRIGGER reject_receipt");
    const receipt = svc.channel.submit(id, input, who);
    svc.store.db
      .prepare("UPDATE runs SET status='running' WHERE id=?")
      .run(receipt.runId);
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    svc = createApp(dir, "hook");
    assert.deepEqual(
      svc.channel.submit(id, input, { clientId: "cli", channel: "cli" }),
      receipt,
    );
    const history = svc.channel.history(id);
    assert.equal(history.messages.length, 1);
    assert.equal(
      history.runs.find((r) => r.id === receipt.runId)?.status,
      "interrupted",
    );
    assert.ok(
      svc.channel
        .replay(id, Buffer.from(JSON.stringify([id, 0])).toString("base64url"))
        .events.some((e: any) => e.status === "interrupted"),
    );
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration of pre-Channel profile requests preserves acceptance and conflicting reuse returns 409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-channel-migrate-"));
  let svc = createApp(dir, "hook");
  try {
    const legacy = svc.profile.answer({
      requestId: "legacy-answer",
      dimension: "goals",
      text: "原有回答",
    });
    await svc.profile.drain();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    svc = createApp(dir, "hook");
    try {
      svc.channel.submit(
        "profile",
        { requestId: "legacy-answer", dimension: "goals", text: "不同内容" },
        { clientId: "cli", channel: "cli" },
      );
      assert.fail("must conflict");
    } catch (e: any) {
      assert.equal(e.status, 409);
    }
    const receipt = svc.channel.submit(
      "profile",
      { requestId: "legacy-answer", dimension: "goals", text: "原有回答" },
      { clientId: "cli", channel: "cli" },
    );
    assert.equal(receipt.runId, legacy.id);
    assert.equal(svc.profile.snapshot().messages.length, 2);
    assert.throws(
      () =>
        svc.channel.submit(
          "research:unknown",
          { requestId: "legacy-answer", text: "different" },
          { clientId: "cli", channel: "cli" },
        ),
      /not found/,
    );
    try {
      svc.channel.submit(
        "profile",
        { requestId: "legacy-answer", dimension: "goals", text: "不同内容" },
        { clientId: "cli", channel: "cli" },
      );
      assert.fail("must conflict");
    } catch (e: any) {
      assert.equal(e.status, 409);
    }
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile history is complete beyond overview limits and migrated IDs conflict across conversations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-history-")),
    svc = createApp(dir, "hook");
  try {
    for (let i = 0; i < 205; i++)
      svc.store.db
        .prepare(
          "INSERT INTO profile_messages VALUES(?,NULL,'assistant','goals',?,NULL,?)",
        )
        .run("history-" + i, "reply-" + i, i);
    assert.equal(svc.profile.snapshot().messages.length, 200);
    assert.equal(svc.channel.history("profile").messages.length, 205);
    const task = svc.store.createTask({
      name: "test",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    await svc.engine.runNow(task.id);
    svc.store.db.exec(
      "UPDATE demo_document SET revision=revision+1 WHERE id=1",
    );
    await svc.engine.runNow(task.id);
    const item = svc.store.all("items")[0];
    const receipt = svc.channel.submit(
      "profile",
      { requestId: "global-id", text: "目标", dimension: "goals" },
      { clientId: "browser-tab", channel: "web" },
    );
    assert.ok(receipt.runId);
    assert.throws(
      () =>
        svc.channel.submit(
          "research:" + item.id,
          { requestId: "global-id", text: "目标" },
          { clientId: "cli-process", channel: "cli" },
        ),
      (e: any) => e.status === 409,
    );
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
