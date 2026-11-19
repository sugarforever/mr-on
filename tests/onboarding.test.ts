import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { runOnboarding } from "../src/onboarding.js";

function fixture(answers: (string | null)[]) {
  const dir = mkdtempSync(join(tmpdir(), "mr-on-onboard-"));
  const output: string[] = [];
  const prompts: { secret?: boolean }[] = [];
  return {
    dir,
    output,
    prompts,
    io: {
      async ask(_text: string, options?: { secret?: boolean }) {
        prompts.push(options || {});
        return answers.shift() ?? null;
      },
      write(text: string) {
        output.push(text);
      },
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("offline onboarding saves demo without connection or service and configure retains key", async () => {
  const f = fixture(["demo", "y", "n"]);
  try {
    await runOnboarding("onboard", f.dir, {
      io: f.io,
      install: async () => {
        throw Error("unexpected install");
      },
    });
    const store = new Store(f.dir);
    assert.equal(store.config().mode, "demo");
    store.saveConfig({ mode: "live", apiKey: "secret" });
    store.close();
  } finally {
    f.close();
  }
});
test("live configure retains hidden existing key and skips test unless explicitly requested", async () => {
  const f = fixture(["live", "", "new-model", "", "n", "y"]);
  try {
    const store = new Store(f.dir);
    store.saveConfig({ mode: "live", apiKey: "keep-secret" });
    store.close();
    await runOnboarding("configure", f.dir, { io: f.io });
    const after = new Store(f.dir);
    assert.equal(after.config().apiKey, "keep-secret");
    assert.equal(after.config().model, "new-model");
    after.close();
    assert.ok(f.prompts.some((p) => p.secret));
    assert.ok(!f.output.join("").includes("keep-secret"));
  } finally {
    f.close();
  }
});
test("failed connection and cancellation leave existing settings intact", async () => {
  for (const answers of [
    ["live", "https://example.com/v1", "new", "secret", "y"],
    [null],
  ]) {
    const f = fixture(answers);
    try {
      await runOnboarding("configure", f.dir, {
        io: f.io,
        test: async () => {
          throw Error("secret");
        },
      });
      const store = new Store(f.dir);
      assert.equal(store.config().mode, "demo");
      store.close();
      assert.ok(!f.output.join("").includes("secret"));
    } finally {
      f.close();
    }
  }
});
test("store rejects blank or excessive model and credential-bearing endpoint without changing settings", () => {
  const f = fixture([]);
  try {
    const s = new Store(f.dir);
    for (const c of [
      { model: "   " },
      { model: "x".repeat(201) },
      { baseUrl: "https://name:secret@example.com" },
    ])
      assert.throws(() => s.saveConfig(c));
    assert.equal(s.config().model, "gpt-4o-mini");
    s.close();
  } finally {
    f.close();
  }
});

test("non-TTY fails before creating data", async () => {
  const { terminalIO } = await import("../src/onboarding.js");
  const f = fixture([]);
  try {
    await assert.rejects(
      runOnboarding("configure", join(f.dir, "absent"), {
        io: terminalIO(
          { isTTY: false } as any,
          { isTTY: false, write() {} } as any,
        ),
      }),
      /交互式/,
    );
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(f.dir, "absent")), false);
  } finally {
    f.close();
  }
});
test("live gateway configuration is authenticated, respects origins and is visible to browser and subsequent jobs", async () => {
  const { createApp } = await import("../src/server.js");
  const { acquireLock } = await import("../src/data-lock.js");
  const { openConfiguration } = await import("../src/configuration.js");
  const { writeFileSync } = await import("node:fs");
  const f = fixture([]);
  const release = acquireLock(f.dir);
  const svc = createApp(f.dir, "local-secret");
  const server = svc.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  writeFileSync(join(f.dir, "gateway.json"), JSON.stringify({ origin }));
  writeFileSync(join(f.dir, "webhook-token"), "local-secret", { mode: 0o600 });
  try {
    const config = await openConfiguration(f.dir);
    assert.equal((await fetch(origin + "/api/local-config")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/local-config", {
          method: "POST",
          headers: {
            authorization: "Bearer local-secret",
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: '{"mode":"demo"}',
        })
      ).status,
      403,
    );
    const task = svc.store.createTask({
      name: "test",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    const run = svc.store.enqueue(task.id);
    svc.store.db
      .prepare("UPDATE runs SET status='running' WHERE id=?")
      .run(run);
    await config.save({ mode: "demo", model: "next-model", apiKey: "hidden" });
    config.close();
    const state = (await (await fetch(origin + "/api/state")).json()) as any;
    assert.equal(state.config.model, "next-model");
    assert.equal(state.config.hasKey, true);
    assert.equal(
      svc.store.db.prepare("SELECT status FROM runs WHERE id=?").get(run)!
        .status,
      "running",
    );
    assert.ok(!JSON.stringify(state).includes("hidden"));
    assert.equal(svc.store.config().model, "next-model");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    svc.closeStreams();
    await svc.engine.stop();
    await svc.profile.stop();
    svc.store.close();
    release();
    f.close();
  }
});
test("a second stopped configuration cannot recover or overwrite an active session", async () => {
  const { openConfiguration } = await import("../src/configuration.js");
  const f = fixture([]);
  try {
    const first = await openConfiguration(f.dir);
    await assert.rejects(openConfiguration(f.dir));
    await first.save({ mode: "demo", model: "kept" });
    first.close();
    const next = await openConfiguration(f.dir);
    assert.equal(next.current.model, "kept");
    next.close();
  } finally {
    f.close();
  }
});
test("connection test uses one bounded Pi Chat Completions request with fixed content and no tools", async () => {
  const { testModelConnection } = await import("../src/model-settings.js");
  let calls = 0;
  const fixtureFetch: typeof fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "fixture");
    assert.equal(body.messages.at(-1).content, "Reply OK.");
    assert.equal(body.tools, undefined);
    return new Response(
      "data: " +
        JSON.stringify({
          id: "test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "OK" },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  await testModelConnection(
    {
      mode: "live",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture",
      apiKey: "secret",
    },
    fixtureFetch,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    testModelConnection(
      {
        mode: "live",
        baseUrl: "https://fixture.invalid/v1",
        model: "fixture",
        apiKey: "secret",
      },
      async () => {
        calls++;
        return new Response("secret", { status: 429 });
      },
    ),
    (e) => !String(e).includes("secret"),
  );
  assert.equal(calls, 1);
  await testModelConnection(
    {
      mode: "demo",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture",
      apiKey: "",
    },
    () => {
      throw Error("network");
    },
  );
});

test("terminal key entry suppresses secret, supports erase and cancels on EOF", async () => {
  const { PassThrough } = await import("node:stream");
  const { terminalIO } = await import("../src/onboarding.js");
  const input = new PassThrough() as any;
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v: boolean) => {
    input.isRaw = v;
  };
  const output = new PassThrough() as any;
  output.isTTY = true;
  let displayed = "";
  output.on("data", (b: Buffer) => (displayed += b));
  const io = terminalIO(input, output);
  const answer = io.ask("密钥", { secret: true });
  for (const ch of "private") input.emit("keypress", ch, { name: ch });
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "", { name: "return" });
  assert.equal(await answer, "privat");
  assert.ok(!displayed.includes("private"));
  assert.equal(input.isRaw, false);
  const ended = io.ask("下一步");
  input.emit("end");
  assert.equal(await ended, null);
  assert.equal(input.isRaw, false);
});
test("service failure preserves saved configuration and offers a concrete next command", async () => {
  const f = fixture(["demo", "y", "y"]);
  try {
    await runOnboarding("onboard", f.dir, {
      io: f.io,
      install: async () => {
        throw Error("secret");
      },
    });
    const s = new Store(f.dir);
    assert.equal(s.config().mode, "demo");
    s.close();
    assert.ok(f.output.join("").includes("mron service install --data"));
    assert.ok(!f.output.join("").includes("secret"));
  } finally {
    f.close();
  }
});
test("stopped configuration does not perform gateway job recovery", async () => {
  const { openConfiguration } = await import("../src/configuration.js");
  const f = fixture([]);
  try {
    const s = new Store(f.dir);
    const t = s.createTask({
      name: "test",
      url: "https://demo.mr-on.invalid/releases",
      goal: "test",
      intervalMinutes: 60,
    });
    const id = s.enqueue(t.id);
    s.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(id);
    s.close();
    const config = await openConfiguration(f.dir);
    await config.save({ mode: "demo" });
    config.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(f.dir, "state.sqlite"));
    assert.equal(
      db.prepare("SELECT status FROM runs WHERE id=?").get(id)!.status,
      "running",
    );
    db.close();
  } finally {
    f.close();
  }
});
test("cancellation after save preserves exact custom data command", async () => {
  const f = fixture(["demo", "y", null]);
  try {
    await runOnboarding("onboard", f.dir, { io: f.io });
    assert.ok(
      f.output
        .join("")
        .includes("mron service install --data " + JSON.stringify(f.dir)),
    );
  } finally {
    f.close();
  }
});
