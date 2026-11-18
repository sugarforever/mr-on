import { acquireLock } from "./data-lock.js";
import { testModelConnection } from "./model-settings.js";
import express from "express";
import {
  startTelegram,
  telegramConfigFile,
  privateFile,
} from "./telegram-runtime.js";
import { Channel, ChannelError } from "./channel.js";
import { channelRoutes } from "./channel-http.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { PiAgent } from "./agent.js";
import { demoReader, DEMO_URL } from "./demo-data.js";
import { Profile } from "./profile.js";
export function createApp(dir: string, webhookToken: string) {
  const store = new Store(dir);
  const engine = new Engine(store, new PiAgent(store), demoReader(store));
  const profile = new Profile(store, new PiAgent(store));
  const channel = new Channel(store, profile);
  profile.tick();
  const runtime = {
    instanceId: randomUUID(),
    startedAt: Date.now(),
    lastTickAt: null as number | null,
    stopping: false,
  };
  const ready = () =>
    !runtime.stopping &&
    runtime.lastTickAt !== null &&
    Date.now() - runtime.lastTickAt < 5000;
  const runtimeSnapshot = () => ({
    ...runtime,
    ready: ready(),
    queued: Number(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status='queued'")
        .get()!.n,
    ),
    running: Number(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'")
        .get()!.n,
    ),
    lastFinishedAt:
      store.db.prepare("SELECT MAX(finishedAt) AS at FROM runs").get()!.at ??
      null,
    lastCheckAt:
      store.db
        .prepare(
          "SELECT MAX(finishedAt) AS at FROM runs WHERE kind='check' AND status='done'",
        )
        .get()!.at ?? null,
    lastFailureAt:
      store.db
        .prepare(
          "SELECT MAX(finishedAt) AS at FROM runs WHERE status IN ('failed','interrupted')",
        )
        .get()!.at ?? null,
  });
  const beginStop = () => {
    runtime.stopping = true;
  };
  const clients = new Set<express.Response>();
  const announce = () => {
    for (const client of clients) client.write("event: update\ndata: {}\n\n");
  };
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Cache-Control": "no-store",
    });
    let host: URL;
    try {
      host = new URL(`http://${req.headers.host}`);
    } catch {
      return res.status(403).json({ error: "Invalid host" });
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname))
      return res.status(403).json({ error: "Local access only" });
    if (req.headers.origin && req.headers.origin !== host.origin)
      return res.status(403).json({ error: "Cross-site request rejected" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "Cross-site request rejected" });
    if (
      ["POST", "PATCH", "PUT"].includes(req.method) &&
      !req.is("application/json")
    )
      return res.status(415).json({ error: "Please use application/json" });
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => {
    try {
      store.db.prepare("SELECT 1").get();
      res
        .status(ready() ? 200 : 503)
        .json({ ready: ready(), pid: process.pid });
    } catch {
      res.status(503).json({ ready: false });
    }
  });
  app.use((req, res, next) => {
    if (runtime.stopping && req.method !== "GET")
      return res
        .status(503)
        .json({ error: "Service is shutting down; try again shortly" });
    next();
  });
  app.use("/api/profile/facts", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    if (req.method !== "GET") res.once("finish", announce);
    next();
  });
  app.use("/api/local-config", (req, res, next) => {
    const expected = Buffer.from("Bearer " + webhookToken);
    const actual = Buffer.from(req.headers.authorization || "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return res.status(401).json({ error: "Authentication required" });
    next();
  });
  app.get("/api/local-config", (_req, res) =>
    res.json(store.snapshot().config),
  );
  app.post("/api/local-config/test", async (req, res, next) => {
    try {
      const { validateModelSettings } = await import("./model-settings.js");
      await testModelConnection(
        validateModelSettings(req.body, store.config()),
      );
      res.json({ ok: true });
    } catch {
      res
        .status(400)
        .json({ error: "Connection test failed; settings unchanged" });
    }
  });
  app.post("/api/local-config", (req, res) => {
    store.saveConfig(req.body);
    res.json({ ok: true });
  });
  const access = channelRoutes(app, channel, store, () => {
    void engine.drain().finally(announce);
    void profile.drain().finally(announce);
  });
  app.get("/api/state", (_req, res) =>
    res.json({
      ...store.snapshot(),
      profile: profile.snapshot(),
      runtime: runtimeSnapshot(),
    }),
  );
  app.get("/api/stream", (req, res) => {
    if (clients.size >= 16) return res.status(429).end();
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.flushHeaders();
    clients.add(res);
    res.write("event: ready\ndata: {}\n\n");
    req.once("close", () => clients.delete(res));
  });
  app.get("/api/profile", (_req, res) => res.json(profile.snapshot()));
  app.post("/api/profile/answers", (req, res) => {
    const receipt = access.submit(req, "profile");
    void profile.drain().finally(announce);
    res.status(202).json(receipt);
  });
  app.patch("/api/profile/facts", (req, res) => {
    profile.saveFacts(req.body.facts);
    res.json({ ok: true });
  });
  app.post("/api/profile/skip", (req, res) => {
    profile.skip(String(req.body.dimension));
    res.json({ ok: true });
  });
  app.post("/api/profile/preferences", (req, res) => {
    if (typeof req.body.enabled !== "boolean")
      throw Error("Please provide valid invitation settings");
    profile.preferences(req.body.enabled);
    res.json({ ok: true });
  });
  app.post("/api/profile/snooze", (_req, res) => {
    profile.snooze();
    res.json({ ok: true });
  });
  app.post("/api/profile/read", (_req, res) => {
    profile.markRead();
    res.json({ ok: true });
  });
  app.post("/api/profile/forget", (_req, res) => {
    profile.forget();
    res.json({ ok: true });
  });
  app.post("/api/profile/jobs/:id/retry", (req, res) => {
    const jobId = profile.retry(req.params.id);
    void profile.drain().finally(announce);
    res.status(202).json({ jobId });
  });
  app.post("/api/config", (req, res) => {
    store.saveConfig(req.body);
    res.json({ ok: true });
  });
  app.post("/api/tasks", (req, res) =>
    res.status(201).json(store.createTask(req.body)),
  );
  app.patch("/api/tasks/:id", (req, res) =>
    res.json(store.updateTask(req.params.id, req.body)),
  );
  app.post("/api/tasks/:id/run", (req, res) => {
    const runId = store.enqueue(req.params.id);
    void engine.drain();
    res.status(202).json({ runId });
  });
  app.post("/api/runs/:id/retry", (req, res) => {
    const runId = store.retryRun(req.params.id);
    void engine.drain();
    res.status(202).json({ runId });
  });
  app.post("/api/items/:id/messages", (req, res) => {
    // Compatibility endpoint: older Web clients receive a generated request ID.
    req.body.requestId ??= randomUUID();
    const receipt = access.submit(req, `research:${req.params.id}`);
    void engine.drain().finally(announce);
    res.status(202).json(receipt);
  });
  app.post("/api/items/:id/followups", (req, res) =>
    res.status(201).json({
      id: store.followup(
        req.params.id,
        String(req.body.text || ""),
        Number(req.body.dueAt),
      ),
    }),
  );
  app.post("/api/followups/:id/cancel", (req, res) => {
    store.db
      .prepare(
        "UPDATE followups SET status='cancelled' WHERE id=? AND status='pending'",
      )
      .run(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/notifications/:id/read", (req, res) => {
    store.db
      .prepare("UPDATE notifications SET read=1 WHERE id=?")
      .run(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/webhook", (req, res) => {
    const expected = Buffer.from(
      "Basic " + Buffer.from("events:" + webhookToken).toString("base64"),
    );
    const provided = Buffer.from(req.headers.authorization || "");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      return res
        .status(401)
        .set("WWW-Authenticate", 'Basic realm="mr-on events"')
        .json({ error: "Webhook Basic authentication required" });
    const result = store.receiveEvent(
      String(req.body.eventId || ""),
      String(req.body.taskId || ""),
      req.body.payload ?? {},
    );
    void engine.drain();
    res.status(202).json(result);
  });
  app.post("/api/demo/start", (req, res) => {
    if (store.config().mode !== "demo")
      throw Error("Please switch to offline demo in model settings first");
    const previous = store.all("tasks").find((t) => t.url === DEMO_URL);
    const task =
      previous ||
      store.createTask({
        name: "Pi releases",
        url: DEMO_URL,
        goal: "Track session, event, and upgrade compatibility changes and suggest further validation.",
        intervalMinutes: 60,
      });
    const runId = store.enqueue(task.id);
    void engine.drain();
    res.json({ taskId: task.id, runId });
  });
  app.post("/api/demo/change", (_req, res) => {
    if (store.config().mode !== "demo")
      throw Error("Please switch to offline demo first");
    const task = store.all("tasks").find((t) => t.url === DEMO_URL);
    if (!task) throw Error("Please load the demo monitor first");
    store.db.exec("UPDATE demo_document SET revision=revision+1 WHERE id=1");
    const runId = store.enqueue(task.id);
    void engine.drain();
    res.json({ taskId: task.id, runId });
  });
  const sourcePublic = fileURLToPath(new URL("../public/", import.meta.url));
  const publicDir = existsSync(join(sourcePublic, "index.html"))
    ? sourcePublic
    : fileURLToPath(new URL("../../public/", import.meta.url));
  app.use(express.static(publicDir));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ChannelError)
        return void res.status(err.status).json({ error: err.message });
      const clientError =
        err instanceof Error &&
        /Monitor|Research thread|eventId|Please|interval|Model endpoint|Questions|Only|demo|JSON|Invalid|too large|Unexpected|must/i.test(
          err.message,
        );
      res.status(err.status === 413 ? 413 : 400).json({
        error: clientError
          ? err.message
          : "Request failed. Check your input and service status.",
      });
    },
  );
  let lastChanges = 0;
  const tick = () => {
    if (runtime.stopping) return;
    store.scheduleDue();
    profile.tick();
    void engine.drain();
    void profile.drain();
    runtime.lastTickAt = Date.now();
    const changes = Number(
      store.db.prepare("SELECT total_changes() AS n").get()!.n,
    );
    if (changes !== lastChanges) {
      announce();
      lastChanges = changes;
    }
  };
  const closeStreams = () => {
    access.close();
    for (const client of clients) client.end();
    clients.clear();
  };
  return {
    app,
    store,
    engine,
    profile,
    channel,
    tick,
    closeStreams,
    beginStop,
  };
}
export function start(options: { data?: string; port?: number } = {}) {
  const dir = resolve(options.data || process.env.MR_ON_DATA || ".data");
  const port = options.port ?? Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Port must be between 1 and 65535");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(dir);
  let service: ReturnType<typeof createApp>;
  try {
    const tokenPath = join(dir, "webhook-token");
    if (!existsSync(tokenPath))
      writeFileSync(tokenPath, randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
    service = createApp(dir, readFileSync(tokenPath, "utf8").trim());
  } catch (error) {
    release();
    throw error;
  }
  const { app, store, engine, profile, tick, closeStreams, beginStop } =
    service;
  const log = (event: string, extra: object = {}) =>
    console.log(
      JSON.stringify({ time: new Date().toISOString(), event, ...extra }),
    );
  const telegramPath =
    process.env.MR_ON_TELEGRAM_CONFIG || join(dir, "telegram.json");
  // File absence means no adapter, no token reads and no outbound Telegram calls.
  const telegram = existsSync(telegramPath)
    ? (async () => {
        try {
          const config = telegramConfigFile(telegramPath, (event) =>
            log(event),
          );
          if (!config().enabled) return undefined;
          const token =
            process.env.MR_ON_TELEGRAM_TOKEN ||
            privateFile(join(dir, "telegram-token")).trim();
          return await startTelegram(
            store,
            service.channel,
            token,
            config,
            undefined,
            (event) => log(event),
          );
        } catch {
          log("telegram.start_failed");
          return undefined;
        }
      })()
    : Promise.resolve(undefined);
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = app.listen(port, "127.0.0.1", () => {
    writeFileSync(
      join(dir, "gateway.json"),
      JSON.stringify({
        origin: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      }),
      { mode: 0o600 },
    );
    log("gateway.started", { port, pid: process.pid });
    if (stopping) return;
    timer = setInterval(safeTick, 1000);
    safeTick();
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    beginStop();
    clearInterval(timer);
    closeStreams();
    log("gateway.stopping");
    const deadline = setTimeout(() => {
      console.error(
        JSON.stringify({
          time: new Date().toISOString(),
          event: "gateway.stop_timeout",
        }),
      );
      // Do not release the lock or close SQLite underneath active work.
      // Startup recovery marks unfinished runs interrupted.
      process.exit(1);
    }, 100000);
    deadline.unref();
    const httpClosed = new Promise<void>((done) => server.close(() => done()));
    stopping = (async () => {
      await Promise.all([
        httpClosed,
        engine.stop(),
        profile.stop(),
        telegram.then((adapter) => adapter?.stop()),
      ]);
      store.close();
      release();
      clearTimeout(deadline);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      log("gateway.stopped");
    })();
    return stopping;
  };
  function onSignal() {
    void stop();
  }
  function safeTick() {
    try {
      tick();
    } catch {
      console.error(
        JSON.stringify({
          time: new Date().toISOString(),
          event: "gateway.scheduler_failed",
        }),
      );
      process.exitCode = 1;
      void stop();
    }
  }
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  server.once("error", () => {
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        event: "gateway.listen_failed",
      }),
    );
    process.exitCode = 1;
    void stop();
  });
  return { server, store, engine, stop };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  start();
