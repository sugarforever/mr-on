import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.db = new DatabaseSync(join(this.dir, "state.sqlite"));
    chmodSync(join(this.dir, "state.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,goal TEXT NOT NULL,intervalMinutes INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,hash TEXT,content TEXT,updatedAt INTEGER,createdAt INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),itemId TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT,eventId TEXT,sessionId TEXT,sessionPath TEXT,result TEXT,error TEXT,createdAt INTEGER NOT NULL,startedAt INTEGER,finishedAt INTEGER);
  CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),runId TEXT NOT NULL,hash TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,sessionId TEXT,sessionPath TEXT,createdAt INTEGER NOT NULL,UNIQUE(taskId,hash));
  CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,taskId TEXT NOT NULL,itemId TEXT NOT NULL,runId TEXT NOT NULL,sessionId TEXT,title TEXT NOT NULL,body TEXT NOT NULL,read INTEGER DEFAULT 0,createdAt INTEGER NOT NULL,UNIQUE(itemId,runId));
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,taskId TEXT NOT NULL,itemId TEXT NOT NULL,runId TEXT NOT NULL,sessionId TEXT,role TEXT NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,taskId TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS followups(id TEXT PRIMARY KEY,taskId TEXT NOT NULL,itemId TEXT NOT NULL,prompt TEXT NOT NULL,dueAt INTEGER NOT NULL,status TEXT NOT NULL,runId TEXT);
  CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .some((column) => column.name === "retryRunId")
    ) {
      this.db.exec("ALTER TABLE runs ADD COLUMN retryRunId TEXT");
    }
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='Run interrupted by a service restart; please retry manually.',finishedAt=? WHERE status='running'",
      )
      .run(Date.now());
    this.db.exec(
      "UPDATE events SET status='interrupted' WHERE id IN (SELECT eventId FROM runs WHERE status='interrupted'); UPDATE followups SET status='interrupted' WHERE runId IN (SELECT id FROM runs WHERE status='interrupted');",
    );
  }
  all(table: string): Row[] {
    if (
      ![
        "tasks",
        "runs",
        "items",
        "notifications",
        "messages",
        "events",
        "followups",
      ].includes(table)
    )
      throw Error("invalid table");
    return this.db
      .prepare(
        `SELECT * FROM ${table} ORDER BY ${table === "followups" ? "dueAt" : "createdAt"} DESC,rowid DESC`,
      )
      .all() as Row[];
  }
  task(id: string) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
      Row | undefined;
    if (!t) throw Error("Monitor not found");
    return t;
  }
  item(id: string) {
    const t = this.db.prepare("SELECT * FROM items WHERE id=?").get(id) as
      Row | undefined;
    if (!t) throw Error("Research thread not found");
    return t;
  }
  private txDepth = 0;
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const r = fn();
      this.db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
      return r;
    } catch (e) {
      this.db.exec(
        depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK",
      );
      throw e;
    } finally {
      this.txDepth--;
    }
  }
  createTask(input: Row) {
    const t = validateTask(input);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks(id,name,url,goal,intervalMinutes,nextAt,createdAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        t.name,
        t.url,
        t.goal,
        t.intervalMinutes,
        Date.now() + t.intervalMinutes * 60000,
        Date.now(),
      );
    return this.task(id);
  }
  updateTask(id: string, input: Row) {
    const old = this.task(id);
    const t = validateTask({ ...old, ...input });
    const changed = t.url !== old.url;
    this.db
      .prepare(
        "UPDATE tasks SET name=?,url=?,goal=?,intervalMinutes=?,paused=?,nextAt=?,hash=?,content=? WHERE id=?",
      )
      .run(
        t.name,
        t.url,
        t.goal,
        t.intervalMinutes,
        input.paused === undefined ? old.paused : input.paused ? 1 : 0,
        Date.now() + t.intervalMinutes * 60000,
        changed ? null : old.hash,
        changed ? null : old.content,
        id,
      );
    return this.task(id);
  }
  enqueue(
    taskId: string,
    kind = "check",
    itemId: string | null = null,
    prompt: string | null = null,
    eventId: string | null = null,
  ) {
    this.task(taskId);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs(id,taskId,itemId,kind,status,prompt,eventId,createdAt) VALUES(?,?,?,?,'queued',?,?,?)",
      )
      .run(id, taskId, itemId, kind, prompt, eventId, Date.now());
    return id;
  }
  receiveEvent(id: string, taskId: string, payload: unknown) {
    if (!id || id.length > 200)
      throw Error("eventId must contain 1–200 characters");
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT taskId FROM events WHERE id=?")
        .get(id);
      if (existing) {
        if (existing.taskId !== taskId)
          throw Error("eventId already belongs to another monitor");
        return { duplicate: true, eventId: id };
      }
      this.task(taskId);
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?,'pending',?)")
        .run(id, taskId, JSON.stringify(payload), Date.now());
      const runId = this.enqueue(taskId, "check", null, null, id);
      return { duplicate: false, eventId: id, runId };
    });
  }
  followup(itemId: string, prompt: string, dueAt: number) {
    const item = this.item(itemId);
    if (
      !prompt.trim() ||
      prompt.length > 8000 ||
      !Number.isFinite(dueAt) ||
      dueAt < Date.now() - 60000
    )
      throw Error("Please provide a question and valid time");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO followups VALUES(?,?,?,?,?,'pending',NULL)")
      .run(id, item.taskId, itemId, prompt, dueAt);
    return id;
  }
  scheduleDue(now = Date.now()) {
    this.tx(() => {
      for (const t of this.db
        .prepare("SELECT * FROM tasks WHERE paused=0 AND nextAt<=?")
        .all(now) as Row[]) {
        if (
          !this.db
            .prepare(
              "SELECT id FROM runs WHERE taskId=? AND kind='check' AND status IN ('queued','running')",
            )
            .get(t.id)
        )
          this.enqueue(t.id);
        this.db
          .prepare("UPDATE tasks SET nextAt=? WHERE id=?")
          .run(now + t.intervalMinutes * 60000, t.id);
      }
      for (const f of this.db
        .prepare(
          "SELECT f.* FROM followups f JOIN tasks t ON f.taskId=t.id WHERE f.status='pending' AND f.dueAt<=? AND t.paused=0",
        )
        .all(now) as Row[]) {
        const runId = this.enqueue(f.taskId, "followup", f.itemId, f.prompt);
        this.db
          .prepare("UPDATE followups SET status='queued',runId=? WHERE id=?")
          .run(runId, f.id);
      }
    });
  }
  config() {
    const row = this.db.prepare("SELECT value FROM settings WHERE id=1").get();
    return row
      ? JSON.parse(row.value as string)
      : {
          mode: "demo",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "",
        };
  }
  saveConfig(c: Row) {
    const old = this.config();
    const mode = c.mode === "live" ? "live" : "demo";
    const baseUrl = String(c.baseUrl || old.baseUrl);
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" || u.username || u.password)
      throw Error("Model endpoint must be an HTTPS URL without credentials");
    const model = String(c.model || old.model).slice(0, 200);
    const apiKey =
      c.apiKey === undefined || c.apiKey === "" ? old.apiKey : String(c.apiKey);
    if (mode === "live" && !apiKey) throw Error("Please configure an API key");
    this.db
      .prepare(
        "INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify({ mode, baseUrl, model, apiKey }));
  }
  snapshot() {
    const config = this.config();
    const runs = this.all("runs").slice(0, 100);
    const notifications = this.all("notifications").slice(0, 100);
    const messages = this.all("messages").slice(0, 300);
    const followups = this.all("followups");
    const referencedItems = new Set(
      [...runs, ...notifications, ...messages, ...followups].map(
        (row) => row.itemId,
      ),
    );
    return {
      tasks: this.all("tasks").map(({ content, ...t }) => t),
      runs,
      items: this.all("items").filter(
        (item, index) => index < 100 || referencedItems.has(item.id),
      ),
      notifications,
      messages,
      events: this.all("events").slice(0, 100),
      followups,
      config: {
        mode: config.mode,
        baseUrl: config.baseUrl,
        model: config.model,
        hasKey: !!config.apiKey,
      },
    };
  }
  close() {
    this.db.close();
  }
  retryRun(id: string) {
    return this.tx(() => {
      const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as
        Row | undefined;
      if (!run || !["failed", "interrupted"].includes(run.status))
        throw Error(
          "Only failed or interrupted runs that have not been retried can be retried",
        );
      const runId = this.enqueue(
        run.taskId,
        run.kind,
        run.itemId,
        run.prompt,
        run.eventId,
      );
      this.db
        .prepare("UPDATE runs SET status='retried',retryRunId=? WHERE id=?")
        .run(runId, id);
      this.db
        .prepare("UPDATE followups SET runId=?,status='queued' WHERE runId=?")
        .run(runId, id);
      if (run.eventId)
        this.db
          .prepare("UPDATE events SET status='pending' WHERE id=?")
          .run(run.eventId);
      return runId;
    });
  }
}
function validateTask(t: Row) {
  const name = String(t.name || "").trim(),
    goal = String(t.goal || "").trim(),
    url = String(t.url || "").trim();
  if (!name || name.length > 100 || !goal || goal.length > 2000)
    throw Error(
      "Monitor name must contain 1–100 characters and research goal 1–2000 characters",
    );
  const u = new URL(url);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    url.length > 2000
  )
    throw Error("Please enter a public HTTP(S) URL");
  const intervalMinutes = Number(t.intervalMinutes);
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 43200
  )
    throw Error("Check interval must be between 1 and 43200 minutes");
  return { name, goal, url, intervalMinutes };
}
