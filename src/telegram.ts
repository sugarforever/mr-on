import { Channel, ChannelError } from "./channel.js";
import { Store, type Row } from "./store.js";

export type TelegramConfig = {
  enabled: boolean;
  grants: { userId: number; chatId: number; conversations: string[] }[];
};
export type TelegramApi = (
  method: string,
  body: Row,
  signal?: AbortSignal,
) => Promise<any>;
export class TelegramApiError extends Error {
  constructor(
    public code = 0,
    public retryAfter = 0,
  ) {
    super(`Telegram API request failed (${code})`);
  }
}
const positiveId = (id: unknown): id is number =>
  Number.isSafeInteger(id) && Number(id) > 0;
export function parseTelegramConfig(value: unknown): TelegramConfig {
  const c = value as TelegramConfig;
  if (
    !c ||
    typeof c.enabled !== "boolean" ||
    !Array.isArray(c.grants) ||
    c.grants.length > 100
  )
    throw Error("Invalid Telegram configuration");
  const pairs = new Set<string>();
  for (const g of c.grants) {
    if (
      !g ||
      !positiveId(g.userId) ||
      !positiveId(g.chatId) ||
      g.userId !== g.chatId ||
      !Array.isArray(g.conversations) ||
      g.conversations.length > 1000 ||
      !g.conversations.every(
        (id) =>
          typeof id === "string" &&
          (id === "profile" || /^research:[A-Za-z0-9-]{1,100}$/.test(id)),
      ) ||
      pairs.has(`${g.userId}:${g.chatId}`)
    )
      throw Error("Invalid Telegram grant");
    pairs.add(`${g.userId}:${g.chatId}`);
  }
  return c;
}

// API descriptions and native fetch exceptions can include token-bearing URLs.
// Deliberately expose only numeric codes, never the original error or cause.
export function telegramApi(
  token: string,
  transport: typeof fetch = fetch,
): TelegramApi {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
    throw Error("Invalid Telegram token");
  return async (method, body, signal) => {
    if (
      !["getMe", "getWebhookInfo", "getUpdates", "sendMessage"].includes(method)
    )
      throw Error("Unsupported Telegram method");
    try {
      const response = await transport(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(35000),
          ]),
        },
      );
      const result = (await response.json()) as Row;
      if (!response.ok || result.ok !== true) {
        const code = Number(result.error_code || response.status);
        const retry = Number(result.parameters?.retry_after);
        throw new TelegramApiError(
          Number.isInteger(code) ? code : 0,
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0,
        );
      }
      return result.result;
    } catch (e) {
      if (e instanceof TelegramApiError) throw e;
      throw new TelegramApiError();
    }
  };
}

const help =
  "Use /list, /bind <conversation>, /status, /history, /unbind. In research, send a question. For profile, use /answer <dimension> <text>. Use /questions to see profile dimensions and prompts. No task management is available.";
export class TelegramAdapter {
  private delivering = false;
  constructor(
    private store: Store,
    private channel: Channel,
    private bot: string,
    private config: () => TelegramConfig,
    private api: TelegramApi,
  ) {
    if (!/^\d+$/.test(bot)) throw Error("Invalid Telegram bot identity");
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_offsets(bot TEXT PRIMARY KEY,offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_bindings(bot TEXT,userId INTEGER,chatId INTEGER,conversation TEXT NOT NULL,PRIMARY KEY(bot,userId,chatId));
      CREATE TABLE IF NOT EXISTS telegram_watches(bot TEXT,userId INTEGER,chatId INTEGER,conversation TEXT,runId TEXT,PRIMARY KEY(bot,runId));
      CREATE TABLE IF NOT EXISTS telegram_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,bot TEXT,userId INTEGER,chatId INTEGER,conversation TEXT,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram_rate(bot TEXT PRIMARY KEY,nextAt INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS telegram_profile_reset AFTER DELETE ON profile_messages BEGIN
        DELETE FROM telegram_outbox WHERE conversation='profile';
        DELETE FROM telegram_watches WHERE conversation='profile'; END;
    `);
  }
  offset() {
    return Number(
      this.store.db
        .prepare("SELECT offset FROM telegram_offsets WHERE bot=?")
        .get(this.bot)?.offset || 0,
    );
  }
  private grant(user: number, chat: number) {
    const config = this.config();
    return config.enabled
      ? config.grants.find((g) => g.userId === user && g.chatId === chat)
      : undefined;
  }
  private allowed(user: number, chat: number, conversation: string | null) {
    const grant = this.grant(user, chat);
    return (
      !!grant && (!conversation || grant.conversations.includes(conversation))
    );
  }
  private queue(
    user: number,
    chat: number,
    conversation: string | null,
    text: string,
  ) {
    // UTF-16 chunks remain below Telegram's 4096-character maximum, without splitting surrogate pairs.
    let chunk = "";
    for (const char of text || "(No text result)") {
      if (chunk.length + char.length > 3500) {
        this.insert(user, chat, conversation, chunk);
        chunk = "";
      }
      chunk += char;
    }
    if (chunk) this.insert(user, chat, conversation, chunk);
  }
  private insert(
    user: number,
    chat: number,
    conversation: string | null,
    text: string,
  ) {
    this.store.db
      .prepare(
        "INSERT INTO telegram_outbox(bot,userId,chatId,conversation,body) VALUES(?,?,?,?,?)",
      )
      .run(this.bot, user, chat, conversation, text);
  }
  accept(update: Row) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0 || id < this.offset()) return;
    this.store.tx(() => {
      const m = update.message;
      if (
        m &&
        m.chat?.type === "private" &&
        positiveId(m.from?.id) &&
        positiveId(m.chat.id) &&
        m.from.id === m.chat.id &&
        m.from.is_bot === false &&
        !m.sender_chat &&
        typeof m.text === "string" &&
        this.grant(m.from.id, m.chat.id)
      ) {
        this.command(id, m.from.id, m.chat.id, m.text);
      }
      this.store.db
        .prepare(
          "INSERT INTO telegram_offsets VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET offset=excluded.offset",
        )
        .run(this.bot, id + 1);
    });
  }
  private command(updateId: number, user: number, chat: number, text: string) {
    const current = this.store.db
      .prepare(
        "SELECT conversation FROM telegram_bindings WHERE bot=? AND userId=? AND chatId=?",
      )
      .get(this.bot, user, chat)?.conversation as string | undefined;
    const reply = (text: string, conversation: string | null = null) =>
      this.queue(user, chat, conversation, text);
    const input = text.trim();
    if (input === "/start" || input === "/help") return reply(help);
    if (input === "/list") {
      const grant = this.grant(user, chat)!;
      const entries = this.channel
        .list()
        .filter((c) => grant.conversations.includes(String(c.id)));
      if (!entries.length) return reply("No conversations granted.");
      for (const entry of entries) reply(String(entry.id), String(entry.id));
      return;
    }
    if (input === "/unbind") {
      this.store.db
        .prepare(
          "DELETE FROM telegram_bindings WHERE bot=? AND userId=? AND chatId=?",
        )
        .run(this.bot, user, chat);
      return reply(
        "Unbound. Pending results remain tied to their original conversation.",
      );
    }
    const bind = /^\/bind (\S+)$/.exec(input);
    if (bind) {
      if (!this.allowed(user, chat, bind[1]))
        return reply("Conversation is not authorized.");
      try {
        this.channel.bind(bind[1]);
      } catch {
        return reply("Conversation not found.");
      }
      this.store.db
        .prepare(
          "INSERT INTO telegram_bindings VALUES(?,?,?,?) ON CONFLICT(bot,userId,chatId) DO UPDATE SET conversation=excluded.conversation",
        )
        .run(this.bot, user, chat, bind[1]);
      return reply(`Bound to ${bind[1]}.`, bind[1]);
    }
    if (!current || !this.allowed(user, chat, current))
      return reply(
        "Select an authorized conversation with /list and /bind <conversation>.",
      );
    if (input === "/questions" && current === "profile") {
      return reply(
        (this.channel.history(current) as Row).profile.questions
          .map((q: Row) => `${q.id}: ${q.question}`)
          .join("\n"),
        current,
      );
    }
    if (input === "/status" || input === "/history") {
      const h = this.channel.history(current);
      return reply(
        input === "/status"
          ? `${current}\n${
              h.runs
                .slice(-5)
                .map((r) => `${r.id}: ${r.status}`)
                .join("\n") || "No runs."
            }`
          : `${current}\n${
              h.messages
                .slice(-10)
                .map((m) => `${m.role}: ${m.body}`)
                .join("\n") || "No messages."
            }`,
        current,
      );
    }
    let dimension: string | undefined,
      message = input;
    if (current === "profile") {
      const answer = /^\/answer (\S+) ([\s\S]+)$/.exec(input);
      if (!answer) return reply(help);
      dimension = answer[1];
      message = answer[2];
    } else if (input.startsWith("/")) return reply(help);
    if (current === "profile") {
      const history = this.channel.history(current) as Row;
      if (
        message.length > 4000 ||
        !history.profile.questions.some((q: Row) => q.id === dimension)
      )
        return reply(
          "Invalid profile dimension or answer (maximum 4000 characters).",
          current,
        );
      if (
        history.runs.some((r: Row) => ["queued", "running"].includes(r.status))
      )
        return reply(
          "Profile is busy. Wait for the current answer, then send again.",
          current,
        );
    }
    try {
      // Nested Channel transaction is a savepoint: offset, receipt, queue, watch and acknowledgement commit together.
      const receipt = this.channel.submit(
        current,
        {
          requestId: `tg:${this.bot}:${updateId}`,
          text: message,
          ...(dimension ? { dimension } : {}),
        },
        {
          principalId: `telegram:${this.bot}:${user}:${chat}`,
          clientId: `telegram:${this.bot}:${chat}`,
          channel: "telegram",
        },
      );
      this.store.db
        .prepare("INSERT INTO telegram_watches VALUES(?,?,?,?,?)")
        .run(this.bot, user, chat, current, receipt.runId);
      reply(`Accepted in ${current}. Run ${receipt.runId}.`, current);
    } catch (e) {
      // Only known input errors are shown; never forward arbitrary execution/database errors.
      if (e instanceof ChannelError && e.status < 500)
        reply(
          "Message rejected. Check its length and conversation, then retry with a new message.",
          current,
        );
      else throw e;
    }
  }
  collect() {
    this.store.tx(() => {
      for (const watch of this.store.db
        .prepare("SELECT * FROM telegram_watches WHERE bot=?")
        .all(this.bot) as Row[]) {
        if (!this.allowed(watch.userId, watch.chatId, watch.conversation)) {
          this.removeWatch(watch.runId);
          continue;
        }
        const h = this.channel.history(watch.conversation);
        const run = h.runs.find((r) => r.id === watch.runId);
        if (!run) {
          this.removeWatch(watch.runId);
          continue;
        }
        if (["queued", "running"].includes(run.status)) continue;
        const messages = h.messages.filter(
          (m) => (m.runId || m.jobId) === run.id && m.role === "assistant",
        );
        this.queue(
          watch.userId,
          watch.chatId,
          watch.conversation,
          `${watch.conversation}\nRun ${run.id}: ${run.status}\n${run.status === "done" ? messages.map((m) => m.body).join("\n") || run.result || "Completed." : "Check the local app for details and manual retry."}`,
        );
        this.removeWatch(watch.runId);
      }
    });
  }
  private removeWatch(run: string) {
    this.store.db
      .prepare("DELETE FROM telegram_watches WHERE bot=? AND runId=?")
      .run(this.bot, run);
  }
  async deliver(now = Date.now(), signal?: AbortSignal) {
    if (this.delivering) return;
    this.delivering = true;
    try {
      // Purge revoked rows before choosing a delivery. Disabled configuration pauses delivery.
      if (!this.config().enabled) return;
      for (const row of this.store.db
        .prepare("SELECT * FROM telegram_outbox WHERE bot=?")
        .all(this.bot) as Row[]) {
        if (!this.allowed(row.userId, row.chatId, row.conversation))
          this.store.db
            .prepare("DELETE FROM telegram_outbox WHERE id=?")
            .run(row.id);
      }
      const rate = Number(
        this.store.db
          .prepare("SELECT nextAt FROM telegram_rate WHERE bot=?")
          .get(this.bot)?.nextAt || 0,
      );
      if (rate > now) return;
      const row = this.store.db
        .prepare(
          "SELECT * FROM telegram_outbox WHERE bot=? ORDER BY id LIMIT 1",
        )
        .get(this.bot) as Row | undefined;
      if (
        !row ||
        row.nextAt > now ||
        signal?.aborted ||
        !this.allowed(row.userId, row.chatId, row.conversation)
      )
        return;
      let wait = 1100;
      const startedAt = Date.now();
      const completedAt = () => now + Math.max(0, Date.now() - startedAt);
      try {
        await this.api(
          "sendMessage",
          {
            chat_id: row.chatId,
            text: row.body,
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        this.store.db
          .prepare("DELETE FROM telegram_outbox WHERE id=?")
          .run(row.id);
      } catch (e) {
        if (e instanceof TelegramApiError && [401, 409].includes(e.code))
          throw e;
        wait = Math.max(
          e instanceof TelegramApiError ? e.retryAfter : 0,
          Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)),
        );
        this.store.db
          .prepare(
            "UPDATE telegram_outbox SET attempts=attempts+1,nextAt=? WHERE id=?",
          )
          .run(completedAt() + wait, row.id);
      }
      this.store.db
        .prepare(
          "INSERT INTO telegram_rate VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET nextAt=excluded.nextAt",
        )
        .run(this.bot, completedAt() + wait);
    } finally {
      this.delivering = false;
    }
  }
}
