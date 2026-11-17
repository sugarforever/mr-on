import { createHash, randomUUID } from "node:crypto";
import { Store, type Row } from "./store.js";
import { Profile } from "./profile.js";
import { credentialSchema } from "./credentials.js";
export class ChannelError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Channel {
  constructor(
    private store: Store,
    private profile: Profile,
  ) {
    credentialSchema(store.db);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_bindings(id TEXT PRIMARY KEY,kind TEXT NOT NULL,businessId TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_requests(requestId TEXT PRIMARY KEY,conversationId TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,principalId TEXT NOT NULL,clientId TEXT NOT NULL,channel TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversationId TEXT NOT NULL,type TEXT NOT NULL,entityId TEXT NOT NULL,status TEXT,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_events_conversation ON channel_events(conversationId,seq);
      CREATE TRIGGER IF NOT EXISTS channel_run_insert AFTER INSERT ON runs WHEN NEW.itemId IS NOT NULL BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,status,createdAt) VALUES('research:'||NEW.itemId,'run',NEW.id,NEW.status,NEW.createdAt); END;
      CREATE TRIGGER IF NOT EXISTS channel_run_update AFTER UPDATE ON runs WHEN NEW.itemId IS NOT NULL AND (NEW.status != OLD.status OR OLD.itemId IS NULL) BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,status,createdAt) VALUES('research:'||NEW.itemId,'run',NEW.id,NEW.status,CAST(strftime('%s','now') AS INTEGER)*1000); END;
      CREATE TRIGGER IF NOT EXISTS channel_message AFTER INSERT ON messages BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,createdAt) VALUES('research:'||NEW.itemId,'message',NEW.id,NEW.createdAt); END;
      CREATE TRIGGER IF NOT EXISTS channel_profile_insert AFTER INSERT ON profile_jobs BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,status,createdAt) VALUES('profile','run',NEW.id,NEW.status,NEW.createdAt); END;
      CREATE TRIGGER IF NOT EXISTS channel_profile_update AFTER UPDATE OF status ON profile_jobs WHEN NEW.status != OLD.status BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,status,createdAt) VALUES('profile','run',NEW.id,NEW.status,CAST(strftime('%s','now') AS INTEGER)*1000); END;
      CREATE TRIGGER IF NOT EXISTS channel_profile_message AFTER INSERT ON profile_messages BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,createdAt) VALUES('profile','message',NEW.id,NEW.createdAt); END;
      CREATE TRIGGER IF NOT EXISTS channel_profile_reset AFTER DELETE ON profile_messages BEGIN
        INSERT INTO channel_events(conversationId,type,entityId,createdAt) VALUES('profile','reset','profile',CAST(strftime('%s','now') AS INTEGER)*1000); END;
    `);
    // Preserve request IDs admitted by older profile-only clients during upgrade.
    for (const job of store.db
      .prepare("SELECT * FROM profile_jobs")
      .all() as Row[]) {
      const message = store.db
        .prepare(
          "SELECT id FROM profile_messages WHERE jobId=? AND role='user'",
        )
        .get(job.id);
      if (!message) continue;
      const receipt = {
        conversationId: "profile",
        runId: job.id,
        jobId: job.id,
        messageId: message.id,
        sessionId: job.sessionId,
      };
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["profile", job.text, job.dimension]))
        .digest("hex");
      store.db
        .prepare(
          "INSERT OR IGNORE INTO channel_requests VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          job.requestId,
          "profile",
          fingerprint,
          JSON.stringify(receipt),
          "local-owner",
          "legacy-browser",
          "web",
          job.createdAt,
        );
    }
    this.bind("profile");
    for (const item of store.all("items")) this.bind("research:" + item.id);
  }
  bind(id: string) {
    const kind = id === "profile" ? "profile" : "research";
    const businessId = kind === "profile" ? "profile" : id.slice(9);
    if (kind === "research") {
      if (!id.startsWith("research:"))
        throw new ChannelError(404, "Conversation not found");
      try {
        this.store.item(businessId);
      } catch {
        throw new ChannelError(404, "Conversation not found");
      }
    }
    this.store.db
      .prepare("INSERT OR IGNORE INTO conversation_bindings VALUES(?,?,?,?)")
      .run(id, kind, businessId, Date.now());
    return { id, kind, businessId };
  }
  list() {
    for (const item of this.store.all("items"))
      this.bind("research:" + item.id);
    return this.store.db
      .prepare("SELECT * FROM conversation_bindings ORDER BY createdAt,id")
      .all();
  }
  private cursor(id: string, seq: number) {
    return Buffer.from(JSON.stringify([id, seq])).toString("base64url");
  }
  private head(id: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS n FROM channel_events WHERE conversationId=?",
        )
        .get(id)!.n,
    );
  }
  history(id: string) {
    const binding = this.bind(id);
    if (binding.kind === "profile") {
      const p = {
        ...this.profile.snapshot(),
        messages: this.store.db
          .prepare("SELECT * FROM profile_messages ORDER BY createdAt,rowid")
          .all() as Row[],
        jobs: this.store.db
          .prepare("SELECT * FROM profile_jobs ORDER BY createdAt,rowid")
          .all() as Row[],
      };
      return {
        ...binding,
        sessionId: p.sessionId,
        messages: p.messages,
        runs: p.jobs,
        profile: p,
        cursor: this.cursor(id, this.head(id)),
      };
    }
    const item = this.store.item(binding.businessId);
    return {
      ...binding,
      sessionId: item.sessionId,
      item,
      messages: this.store.db
        .prepare(
          "SELECT * FROM messages WHERE itemId=? ORDER BY createdAt,rowid",
        )
        .all(item.id),
      runs: this.store.db
        .prepare("SELECT * FROM runs WHERE itemId=? ORDER BY createdAt,rowid")
        .all(item.id),
      cursor: this.cursor(id, this.head(id)),
    };
  }
  replay(id: string, cursor?: string) {
    this.bind(id);
    let seq: number;
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor || "", "base64url").toString(),
      );
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        parsed[0] !== id ||
        !Number.isSafeInteger(parsed[1]) ||
        parsed[1] < 0
      )
        throw Error();
      seq = parsed[1];
      if (
        seq > this.head(id) ||
        (seq !== 0 &&
          !this.store.db
            .prepare(
              "SELECT seq FROM channel_events WHERE conversationId=? AND seq=?",
            )
            .get(id, seq))
      )
        throw Error();
    } catch {
      return {
        snapshotRequired: true,
        snapshot: this.history(id),
        events: [],
        cursor: this.cursor(id, this.head(id)),
      };
    }
    const events = this.store.db
      .prepare(
        "SELECT * FROM channel_events WHERE conversationId=? AND seq>? ORDER BY seq LIMIT 256",
      )
      .all(id, seq) as Row[];
    return {
      snapshotRequired: false,
      events: events.map((e) => ({ ...e, cursor: this.cursor(id, e.seq) })),
      cursor: this.cursor(id, events.length ? events.at(-1)!.seq : seq),
    };
  }
  submit(
    id: string,
    input: Row,
    identity: {
      principalId?: string;
      clientId: string;
      channel: "web" | "cli";
    },
  ) {
    const binding = this.bind(id);
    if (
      typeof input.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(input.requestId) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > (binding.kind === "profile" ? 4000 : 8000)
    )
      throw new ChannelError(400, "Invalid requestId or message");
    const text = input.text.trim();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          id,
          text,
          binding.kind === "profile" ? input.dimension : null,
        ]),
      )
      .digest("hex");
    return this.store.tx(() => {
      const prior = this.store.db
        .prepare("SELECT * FROM channel_requests WHERE requestId=?")
        .get(input.requestId) as Row | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ChannelError(409, "requestId conflict");
        const receipt = JSON.parse(prior.receipt);
        if (
          binding.kind === "profile" &&
          !this.store.db
            .prepare("SELECT id FROM profile_jobs WHERE id=?")
            .get(receipt.runId)
        )
          throw new ChannelError(
            410,
            "Profile history was reset; use a new requestId",
          );
        return receipt;
      }
      let receipt: Row;
      if (binding.kind === "profile") {
        const job = this.profile.answer({
          requestId: input.requestId,
          dimension: input.dimension,
          text,
        });
        const msg = this.store.db
          .prepare(
            "SELECT id FROM profile_messages WHERE jobId=? AND role='user'",
          )
          .get(job.id)!;
        receipt = {
          conversationId: id,
          runId: job.id,
          jobId: job.id,
          messageId: msg.id,
          sessionId: this.profile.snapshot().sessionId,
        };
      } else {
        const item = this.store.item(binding.businessId);
        const runId = this.store.enqueue(item.taskId, "message", item.id, text),
          messageId = randomUUID();
        this.store.db
          .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)")
          .run(
            messageId,
            item.taskId,
            item.id,
            runId,
            item.sessionId,
            "user",
            text,
            Date.now(),
          );
        receipt = {
          conversationId: id,
          runId,
          messageId,
          itemId: item.id,
          sessionId: item.sessionId,
        };
      }
      this.store.db
        .prepare("INSERT INTO channel_requests VALUES(?,?,?,?,?,?,?,?)")
        .run(
          input.requestId,
          id,
          fingerprint,
          JSON.stringify(receipt),
          identity.principalId || "local-owner",
          identity.clientId,
          identity.channel,
          Date.now(),
        );
      return receipt;
    });
  }
}
