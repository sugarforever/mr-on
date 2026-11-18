import { readFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.js";
import { Channel } from "./channel.js";
import {
  TelegramAdapter,
  TelegramApiError,
  parseTelegramConfig,
  telegramApi,
  type TelegramApi,
  type TelegramConfig,
} from "./telegram.js";

const disabled: TelegramConfig = { enabled: false, grants: [] };
export function privateFile(path: string) {
  const stat = statSync(path);
  if (
    !stat.isFile() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Telegram files must be private and owned by the service user");
  if (stat.size > 1024 * 1024) throw Error("Telegram file too large");
  return readFileSync(path, "utf8");
}
export function telegramConfigFile(path: string, log: (event: string) => void) {
  let invalid = false;
  return () => {
    try {
      const c = parseTelegramConfig(JSON.parse(privateFile(path)));
      invalid = false;
      return c;
    } catch {
      if (!invalid) log("telegram.configuration_disabled");
      invalid = true;
      return disabled;
    }
  };
}
function pollerLock(bot: string) {
  const dir = join(tmpdir(), `mr-on-telegram-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Unsafe Telegram lock directory");
  // Never unlink this file: SQLite's OS lock is released on process death and
  // serializes competing recovery attempts without a stale-PID takeover race.
  const path = join(dir, `${bot}.sqlite`);
  const lock = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw Error("A Telegram poller is already running for this bot");
  }
  return () => lock.close();
}
export async function startTelegram(
  store: Store,
  channel: Channel,
  token: string,
  config: () => TelegramConfig,
  api: TelegramApi = telegramApi(token),
  log: (event: string) => void = () => {},
) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
    throw Error("Invalid Telegram token");
  const bot = token.split(":")[0];
  let release: () => void;
  try {
    release = pollerLock(bot);
  } catch (e) {
    log("telegram.local_poller_conflict");
    throw e;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let adapter: TelegramAdapter;
  try {
    const me = await api("getMe", {}, signal);
    if (!me || String(me.id) !== bot || me.is_bot !== true)
      throw Error("Telegram bot identity mismatch");
    const webhook = await api("getWebhookInfo", {}, signal);
    if (!webhook || typeof webhook.url !== "string")
      throw Error("Invalid Telegram webhook response");
    if (webhook.url) {
      log("telegram.webhook_conflict");
      throw Error(
        "Telegram webhook exists; remove it explicitly before enabling polling",
      );
    }
    adapter = new TelegramAdapter(store, channel, bot, config, api);
  } catch (e) {
    release();
    throw e;
  }
  const wait = async (ms: number) => {
    try {
      await delay(ms, undefined, { signal });
    } catch {}
  };
  const fatal = (e: unknown) =>
    e instanceof TelegramApiError && [401, 409].includes(e.code);
  const fail = (e: unknown) => {
    log(
      e instanceof TelegramApiError && e.code === 409
        ? "telegram.poller_conflict"
        : "telegram.stopped_error",
    );
    controller.abort();
  };
  const poll = (async () => {
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!config().enabled) {
          await wait(1000);
          continue;
        }
        const updates = await api(
          "getUpdates",
          {
            offset: adapter.offset(),
            timeout: 25,
            limit: 100,
            allowed_updates: ["message"],
          },
          signal,
        );
        if (signal.aborted) break;
        if (!Array.isArray(updates))
          throw Error("Invalid Telegram update response");
        for (const update of updates) adapter.accept(update);
        failures = 0;
        // Also avoids spinning if a server returns immediately with no updates.
        await wait(100);
      } catch (e) {
        if (signal.aborted) break;
        if (fatal(e)) {
          fail(e);
          break;
        }
        log("telegram.poll_retry");
        await wait(
          Math.max(
            e instanceof TelegramApiError ? e.retryAfter : 0,
            Math.min(60000, 1000 * 2 ** Math.min(failures++, 6)),
          ),
        );
      }
    }
  })();
  const deliver = (async () => {
    while (!signal.aborted) {
      try {
        if (config().enabled) {
          adapter.collect();
          await adapter.deliver(Date.now(), signal);
        }
      } catch (e) {
        if (signal.aborted) break;
        if (fatal(e)) {
          fail(e);
          break;
        }
        log("telegram.delivery_retry");
      }
      await wait(250);
    }
  })();
  let stopped: Promise<void> | undefined;
  return {
    stop: () =>
      (stopped ??= (async () => {
        controller.abort();
        await Promise.all([poll, deliver]);
        release();
      })()),
  };
}
