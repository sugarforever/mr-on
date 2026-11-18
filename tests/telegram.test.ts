import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { TelegramAdapter, type TelegramConfig } from "../src/telegram.js";

const update = (
  id: number,
  text: string,
  user = 42,
  chat = 42,
  type = "private",
) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    from: { id: user, is_bot: false, first_name: "Test" },
    chat: { id: chat, type },
    text,
  },
});

test("Telegram authenticates private pairs, admits once across restart and delivers only its submitted results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-telegram-"));
  let svc = createApp(dir, "hook");
  let config: TelegramConfig = {
    enabled: true,
    grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
  };
  const sent: any[] = [];
  const api = async (method: string, body: any) => {
    assert.equal(method, "sendMessage");
    sent.push(body);
    return { message_id: sent.length };
  };
  let adapter = new TelegramAdapter(
    svc.store,
    svc.channel,
    "123",
    () => config,
    api,
  );
  try {
    adapter.accept(update(1, "/bind profile", 43));
    adapter.accept(update(2, "/bind profile", 42, 42, "group"));
    adapter.accept(update(3, "/bind profile"));
    adapter.accept(update(4, "/answer goals Learn TypeScript"));
    adapter.accept(update(4, "/answer goals Learn TypeScript"));
    assert.equal(svc.channel.history("profile").messages.length, 1);
    const receipt = svc.store.db
      .prepare("SELECT * FROM channel_requests WHERE channel='telegram'")
      .get()!;
    assert.equal(receipt.principalId, "telegram:123:42:42");
    await svc.profile.drain();
    const history = svc.channel.history("profile");
    assert.ok(history.sessionId);
    assert.ok(history.messages.every((m) => m.sessionId === history.sessionId));
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    svc = createApp(dir, "hook");
    adapter = new TelegramAdapter(
      svc.store,
      svc.channel,
      "123",
      () => config,
      api,
    );
    adapter.accept(update(4, "/answer goals Learn TypeScript"));
    assert.equal(adapter.offset(), 5);
    assert.equal(svc.channel.history("profile").messages.length, 2);
    adapter.collect();
    for (let i = 0; i < 10; i++) await adapter.deliver(Date.now() + i * 2000);
    assert.ok(sent.some((m) => m.text.includes(history.messages[1].body)));
    assert.ok(sent.every((m) => m.chat_id === 42 && !m.parse_mode));
    const count = sent.length;
    svc.channel.submit(
      "profile",
      { requestId: "web-only", dimension: "goals", text: "private web answer" },
      { clientId: "browser", channel: "web" },
    );
    await svc.profile.drain();
    adapter.collect();
    await adapter.deliver(Date.now() + 60000);
    assert.equal(sent.length, count);
    adapter.accept(update(5, "/history"));
    config = { enabled: true, grants: [] };
    await adapter.deliver(Date.now() + 90000);
    assert.equal(sent.length, count);
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram outbox survives send failure, honors retry_after, purges revoked scopes and clears reset profile results", async () => {
  const { TelegramApiError } = await import("../src/telegram.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-outbox-")),
    svc = createApp(dir, "hook");
  let config: TelegramConfig = {
    enabled: true,
    grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
  };
  let attempts = 0;
  const sent: string[] = [];
  const api = async (_: string, b: any) => {
    if (++attempts === 1) throw new TelegramApiError(429, 7000);
    sent.push(b.text);
    return {};
  };
  try {
    let adapter = new TelegramAdapter(
      svc.store,
      svc.channel,
      "123",
      () => config,
      api,
    );
    adapter.accept(update(1, "/bind profile"));
    await adapter.deliver(10000);
    await adapter.deliver(16999);
    assert.equal(attempts, 1);
    adapter = new TelegramAdapter(
      svc.store,
      svc.channel,
      "123",
      () => config,
      api,
    );
    await adapter.deliver(
      Number(
        svc.store.db
          .prepare("SELECT nextAt FROM telegram_outbox ORDER BY id LIMIT 1")
          .get()!.nextAt,
      ),
    );
    assert.equal(sent.length, 1);
    adapter.accept(update(2, "/answer goals " + "a".repeat(4001)));
    assert.equal(svc.channel.history("profile").messages.length, 0);
    adapter.accept(update(3, "/answer background My work"));
    await svc.profile.drain();
    adapter.collect();
    svc.profile.forget();
    await adapter.deliver(20000);
    assert.ok(!sent.some((s) => s.includes("My work")));
    adapter.accept(update(4, "/bind profile"));
    config = { enabled: false, grants: config.grants };
    const n = sent.length;
    await adapter.deliver(50000);
    assert.equal(sent.length, n);
    config = { enabled: true, grants: [] };
    await adapter.deliver(60000);
    config = {
      enabled: true,
      grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
    };
    await adapter.deliver(70000);
    assert.equal(sent.length, n);
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bot API transport sanitizes secrets, uses bounded POST requests and parses 429", async () => {
  const { telegramApi, TelegramApiError, parseTelegramConfig } =
    await import("../src/telegram.js");
  const token = "123:secret_TEST";
  const api = telegramApi(token, (async (url: any, init: any) => {
    assert.equal(url, `https://api.telegram.org/bot${token}/getUpdates`);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: token,
        parameters: { retry_after: 3 },
      }),
      { status: 429 },
    );
  }) as typeof fetch);
  await assert.rejects(
    api("getUpdates", {}),
    (e: any) =>
      e instanceof TelegramApiError &&
      e.retryAfter === 3000 &&
      !JSON.stringify(e).includes(token) &&
      !String(e).includes(token),
  );
  const failed = telegramApi(token, (async () => {
    throw Error(`https://api.telegram.org/bot${token}/sendMessage`);
  }) as typeof fetch);
  await assert.rejects(
    failed("sendMessage", {}),
    (e: any) => !String(e.stack).includes(token) && !e.cause,
  );
  assert.throws(() =>
    parseTelegramConfig({
      enabled: true,
      grants: [{ userId: 42, chatId: 43, conversations: ["profile"] }],
    }),
  );
});

test("runtime refuses existing webhooks and duplicate local pollers, and aborts long polling on stop", async () => {
  const { startTelegram } = await import("../src/telegram-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-runtime-")),
    svc = createApp(dir, "hook");
  const config: TelegramConfig = { enabled: true, grants: [] };
  let polling = false,
    aborted = false;
  const events: string[] = [];
  const api = async (method: string, _body: any, signal?: AbortSignal) => {
    if (method === "getMe") return { id: 987654321, is_bot: true };
    if (method === "getWebhookInfo") return { url: "" };
    assert.equal(method, "getUpdates");
    polling = true;
    return new Promise((_, reject) =>
      signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(Error("abort"));
        },
        { once: true },
      ),
    );
  };
  let runtime: Awaited<ReturnType<typeof startTelegram>> | undefined;
  try {
    await assert.rejects(
      startTelegram(
        svc.store,
        svc.channel,
        "987654321:test",
        () => config,
        async (method) =>
          method === "getMe"
            ? { id: 987654321, is_bot: true }
            : { url: "https://existing.invalid/secret" },
        (e) => events.push(e),
      ),
      /webhook/i,
    );
    runtime = await startTelegram(
      svc.store,
      svc.channel,
      "987654321:test",
      () => config,
      api,
      (e) => events.push(e),
    );
    await assert.rejects(
      startTelegram(
        svc.store,
        svc.channel,
        "987654321:test",
        () => config,
        api,
        () => {},
      ),
      /poller/i,
    );
    for (let i = 0; i < 100 && !polling; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(polling);
    await runtime.stop();
    assert.ok(aborted);
  } finally {
    await runtime?.stop();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic Telegram admission rolls back offset and receipt on storage failure, and research grants isolate sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-atomic-")),
    svc = createApp(dir, "hook");
  const sent: any[] = [];
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
    const first = svc.store.all("items")[0];
    svc.store.db.exec(
      "UPDATE demo_document SET revision=revision+1 WHERE id=1",
    );
    await svc.engine.runNow(task.id);
    const second = svc.store.all("items")[0];
    const id = "research:" + first.id,
      other = "research:" + second.id;
    const config: TelegramConfig = {
      enabled: true,
      grants: [
        { userId: 42, chatId: 42, conversations: [id] },
        { userId: 43, chatId: 43, conversations: [other] },
      ],
    };
    const adapter = new TelegramAdapter(
      svc.store,
      svc.channel,
      "123",
      () => config,
      async (_, b) => {
        sent.push(b);
        return {};
      },
    );
    adapter.accept(update(1, "/bind " + id));
    svc.store.db.exec(
      "CREATE TRIGGER reject_tg_watch BEFORE INSERT ON telegram_watches BEGIN SELECT RAISE(ABORT,'watch rollback'); END",
    );
    assert.throws(
      () => adapter.accept(update(2, "Explain the change")),
      /rollback/,
    );
    assert.equal(adapter.offset(), 2);
    assert.equal(svc.channel.history(id).messages.length, 0);
    assert.equal(
      svc.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM channel_requests WHERE channel='telegram'",
        )
        .get()!.n,
      0,
    );
    svc.store.db.exec("DROP TRIGGER reject_tg_watch");
    adapter.accept(update(2, "Explain the change"));
    adapter.accept(update(3, "/bind " + other, 43, 43));
    adapter.accept(update(4, "Explain second", 43, 43));
    adapter.accept(update(5, "/bind " + other));
    adapter.accept(update(6, "/history"));
    await svc.engine.drain();
    adapter.collect();
    for (let i = 0; i < 30; i++)
      await adapter.deliver(100000 + Date.now() + i * 2000);
    const h1 = svc.channel.history(id),
      h2 = svc.channel.history(other);
    assert.equal(h1.sessionId, first.sessionId);
    assert.equal(h2.sessionId, second.sessionId);
    assert.notEqual(h1.sessionId, h2.sessionId);
    const run1 = h1.runs.find((r) => r.kind === "message")!,
      run2 = h2.runs.find((r) => r.kind === "message")!;
    assert.ok(
      sent.some(
        (m) => m.chat_id === 42 && m.text.includes(`Run ${run1.id}: done`),
      ),
    );
    assert.ok(
      sent.some(
        (m) => m.chat_id === 43 && m.text.includes(`Run ${run2.id}: done`),
      ),
    );
    assert.ok(!sent.some((m) => m.chat_id === 42 && m.text.includes(run2.id)));
    assert.ok(!sent.some((m) => m.chat_id === 43 && m.text.includes(run1.id)));
  } finally {
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local fake Telegram HTTP service runs polling through Channel/Pi and recovers multipart delivery without cancelling work", async () => {
  const { createServer } = await import("node:http");
  const { telegramApi } = await import("../src/telegram.js");
  const { startTelegram } = await import("../src/telegram-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-http-")),
    svc = createApp(dir, "hook");
  const replies: any[] = [],
    offsets: number[] = [];
  let incoming = [
    update(10, "/bind profile"),
    update(11, "/answer goals Build a project"),
  ];
  const fake = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      method = req.url!.split("/").at(-1);
    let result: any;
    if (method === "getMe")
      result = {
        id: 987654322,
        is_bot: true,
        first_name: "Test",
        username: "test_bot",
      };
    else if (method === "getWebhookInfo")
      result = {
        url: "",
        has_custom_certificate: false,
        pending_update_count: 0,
      };
    else if (method === "getUpdates") {
      offsets.push(body.offset);
      result = incoming.filter((u) => u.update_id >= body.offset);
      incoming = [];
    } else if (method === "sendMessage") {
      replies.push(body);
      result = {
        message_id: replies.length,
        date: 1,
        chat: { id: 42, type: "private" },
        text: body.text,
      };
    } else {
      res.writeHead(400);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => fake.once("listening", r));
  const api = telegramApi("987654322:fake", ((url: any, init: any) =>
    fetch(
      `http://127.0.0.1:${(fake.address() as any).port}/${new URL(url).pathname.split("/").at(-1)}`,
      init,
    )) as typeof fetch);
  let runtime: Awaited<ReturnType<typeof startTelegram>> | undefined;
  try {
    runtime = await startTelegram(
      svc.store,
      svc.channel,
      "987654322:fake",
      () => ({
        enabled: true,
        grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
      }),
      api,
    );
    for (
      let i = 0;
      i < 100 && svc.channel.history("profile").messages.length === 0;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    await runtime.stop(); // Transport disconnect does not cancel admitted work.
    await svc.profile.drain();
    const h = svc.channel.history("profile");
    assert.equal(h.messages.length, 2);
    assert.ok(h.sessionId);
    svc.store.db
      .prepare("UPDATE profile_messages SET body=? WHERE role='assistant'")
      .run("🦊".repeat(4000) + " END");
    const adapter = new TelegramAdapter(
      svc.store,
      svc.channel,
      "987654322",
      () => ({
        enabled: true,
        grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
      }),
      api,
    );
    adapter.collect();
    for (let i = 0; i < 10; i++)
      await adapter.deliver(Date.now() + 100000 + i * 2000);
    const final = replies.filter(
      (m) => m.text.includes("🦊") || m.text.includes(" END"),
    );
    assert.equal(final.length, 3);
    assert.ok(
      final.every(
        (m) => m.text.length <= 3500 && !/[\uD800-\uDBFF]$/.test(m.text),
      ),
    );
    assert.ok(
      final
        .map((m) => m.text)
        .join("")
        .includes("🦊".repeat(4000) + " END"),
    );
    assert.ok(offsets.includes(0));
    assert.equal(adapter.offset(), 12);
  } finally {
    await runtime?.stop();
    await new Promise<void>((r) => fake.close(() => r()));
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private config changes fail closed and recover without exposing contents", async () => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const { telegramConfigFile } = await import("../src/telegram-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-config-")),
    path = join(dir, "telegram.json"),
    events: string[] = [];
  try {
    const config = telegramConfigFile(path, (e) => events.push(e));
    assert.equal(config().enabled, false);
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
      }),
      { mode: 0o600 },
    );
    assert.equal(config().grants[0].userId, 42);
    chmodSync(path, 0o644);
    assert.equal(config().enabled, false);
    chmodSync(path, 0o600);
    writeFileSync(path, "secret invalid content");
    assert.equal(config().enabled, false);
    writeFileSync(path, JSON.stringify({ enabled: true, grants: [] }));
    assert.deepEqual(config(), { enabled: true, grants: [] });
    assert.ok(
      events.length > 0 &&
        events.every((e) => e === "telegram.configuration_disabled"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote poller conflict stops the adapter without retrying or leaking descriptions", async () => {
  const { startTelegram } = await import("../src/telegram-runtime.js");
  const { TelegramApiError } = await import("../src/telegram.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-conflict-")),
    svc = createApp(dir, "hook"),
    events: string[] = [];
  let polls = 0;
  const runtime = await startTelegram(
    svc.store,
    svc.channel,
    "987654323:test",
    () => ({ enabled: true, grants: [] }),
    async (method) => {
      if (method === "getMe") return { id: 987654323, is_bot: true };
      if (method === "getWebhookInfo") return { url: "" };
      polls++;
      throw new TelegramApiError(409);
    },
    (e) => events.push(e),
  );
  try {
    for (let i = 0; i < 100 && !events.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events, ["telegram.poller_conflict"]);
    assert.equal(polls, 1);
    assert.equal(svc.channel.history("profile").messages.length, 0);
  } finally {
    await runtime.stop();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued list entries respect conversation-only revocation and slow 429 waits after response", async (t) => {
  const { TelegramApiError } = await import("../src/telegram.js");
  const dir = mkdtempSync(join(tmpdir(), "mr-tg-review-")),
    svc = createApp(dir, "hook");
  let config: TelegramConfig = {
      enabled: true,
      grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
    },
    clock = 1000;
  const sent: string[] = [];
  t.mock.method(Date, "now", () => clock);
  const adapter = new TelegramAdapter(
    svc.store,
    svc.channel,
    "123",
    () => config,
    async (_, b) => {
      sent.push(b.text);
      return {};
    },
  );
  try {
    adapter.accept(update(1, "/list"));
    config = {
      enabled: true,
      grants: [{ userId: 42, chatId: 42, conversations: [] }],
    };
    await adapter.deliver(1000);
    assert.equal(sent.length, 0);
    config = {
      enabled: true,
      grants: [{ userId: 42, chatId: 42, conversations: ["profile"] }],
    };
    adapter.accept(update(2, "/bind profile"));
    const slow = new TelegramAdapter(
      svc.store,
      svc.channel,
      "123",
      () => config,
      async () => {
        clock = 11000;
        throw new TelegramApiError(429, 7000);
      },
    );
    await slow.deliver(1000);
    assert.equal(
      svc.store.db
        .prepare("SELECT nextAt FROM telegram_outbox WHERE bot='123'")
        .get()!.nextAt,
      18000,
    );
  } finally {
    t.mock.restoreAll();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "OS-backed poller lock releases after process death and serializes simultaneous recovery",
  { timeout: 20000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "mr-tg-lock-"));
    const source = `
    import {createApp} from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
    import {startTelegram} from ${JSON.stringify(new URL("../src/telegram-runtime.ts", import.meta.url).href)};
    const svc=createApp(process.argv[1],"hook");
    try {
      const runtime=await startTelegram(svc.store,svc.channel,"${900000000 + process.pid}:test",()=>({enabled:false,grants:[]}),async(m)=>m==="getMe"?{id:${900000000 + process.pid},is_bot:true}:{url:""});
      process.send("ready");
      process.on("SIGTERM",async()=>{await runtime.stop();await Promise.all([svc.engine.stop(),svc.profile.stop()]);svc.store.close();process.exit(0);});
    } catch(e) {process.send(String(e).includes("poller")?"blocked":"error");svc.store.close();process.exit(0);}
  `;
    const children: ReturnType<typeof spawn>[] = [];
    const launch = (name: string) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          source,
          join(dir, name),
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      children.push(child);
      const state = new Promise<string>((resolve, reject) => {
        child.once("message", (m) => resolve(String(m)));
        child.once("error", reject);
        child.once("exit", () => reject(Error("poller exited before status")));
      });
      return { child, state };
    };
    try {
      const initial = launch("initial");
      assert.equal(await initial.state, "ready");
      const dead = new Promise((r) => initial.child.once("exit", r));
      initial.child.kill("SIGKILL");
      await dead;
      const a = launch("a"),
        b = launch("b");
      assert.deepEqual((await Promise.all([a.state, b.state])).sort(), [
        "blocked",
        "ready",
      ]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((r) => child.once("exit", r)),
        ),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
