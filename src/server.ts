import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
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
  profile.tick();
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
      return res.status(403).json({ error: "无效主机" });
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname))
      return res.status(403).json({ error: "仅限本机访问" });
    if (req.headers.origin && req.headers.origin !== host.origin)
      return res.status(403).json({ error: "拒绝跨站请求" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "拒绝跨站请求" });
    if (
      ["POST", "PATCH", "PUT"].includes(req.method) &&
      !req.is("application/json")
    )
      return res.status(415).json({ error: "请使用 application/json" });
    next();
  });
  app.use("/api/profile/facts", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    if (req.method !== "GET") res.once("finish", announce);
    next();
  });
  app.get("/api/state", (_req, res) =>
    res.json({ ...store.snapshot(), profile: profile.snapshot() }),
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
    const job = profile.answer(req.body);
    void profile.drain().finally(announce);
    res.status(202).json({ jobId: job.id });
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
      throw Error("请填写有效的主动交流设置");
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
    const item = store.item(req.params.id);
    const text = String(req.body.text || "").trim();
    if (!text || text.length > 8000) throw Error("问题需为 1–8000 字符");
    const runId = store.tx(() => {
      const id = store.enqueue(item.taskId, "message", item.id, text);
      store.db
        .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)")
        .run(
          crypto.randomUUID(),
          item.taskId,
          item.id,
          id,
          item.sessionId,
          "user",
          text,
          Date.now(),
        );
      return id;
    });
    void engine.drain();
    res.status(202).json({ runId, itemId: item.id, sessionId: item.sessionId });
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
        .json({ error: "需要 webhook Basic 认证" });
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
      throw Error("请先在模型设置中切换至离线演示");
    const previous = store.all("tasks").find((t) => t.url === DEMO_URL);
    const task =
      previous ||
      store.createTask({
        name: "Pi 发布动态",
        url: DEMO_URL,
        goal: "关注会话、事件和升级兼容性变化，并提出后续验证建议。",
        intervalMinutes: 60,
      });
    const runId = store.enqueue(task.id);
    void engine.drain();
    res.json({ taskId: task.id, runId });
  });
  app.post("/api/demo/change", (_req, res) => {
    if (store.config().mode !== "demo") throw Error("请先切换至离线演示");
    const task = store.all("tasks").find((t) => t.url === DEMO_URL);
    if (!task) throw Error("请先载入演示任务");
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
      const clientError =
        err instanceof Error &&
        /任务|事项|eventId|请输入|请先|请填|请配|周期|模型地址|问题|只能|演示|JSON|无效|too large|Unexpected|必须/.test(
          err.message,
        );
      res.status(err.status === 413 ? 413 : 400).json({
        error: clientError ? err.message : "请求失败，请检查输入与服务状态。",
      });
    },
  );
  let lastChanges = 0;
  const tick = () => {
    store.scheduleDue();
    profile.tick();
    void engine.drain();
    void profile.drain();
    const changes = Number(
      store.db.prepare("SELECT total_changes() AS n").get()!.n,
    );
    if (changes !== lastChanges) {
      announce();
      lastChanges = changes;
    }
  };
  const closeStreams = () => {
    for (const client of clients) client.end();
    clients.clear();
  };
  return { app, store, engine, profile, tick, closeStreams };
}
function acquireLock(dir: string): () => void {
  const path = join(dir, "service.lock");
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw Error("同一数据目录已有服务运行");
    unlinkSync(path);
    return acquireLock(dir);
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {}
  };
}
export function start() {
  const dir = resolve(process.env.MR_ON_DATA || ".data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(dir);
  const tokenPath = join(dir, "webhook-token");
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = readFileSync(tokenPath, "utf8").trim();
  const { app, store, engine, profile, tick, closeStreams } = createApp(
    dir,
    token,
  );
  const port = Number(process.env.PORT || 4317);
  const server = app.listen(port, "127.0.0.1", () =>
    console.log(
      `mr-on 已启动：http://127.0.0.1:${port}（默认离线演示；数据目录 ${dir}）`,
    ),
  );
  tick();
  const timer = setInterval(tick, 1000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    closeStreams();
    server.close();
    await Promise.all([engine.stop(), profile.stop()]);
    store.close();
    release();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  server.once("error", () => {
    clearInterval(timer);
    store.close();
    release();
    console.error("启动失败：端口不可用。");
    process.exitCode = 1;
  });
  return { server, store, engine, stop };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  start();
