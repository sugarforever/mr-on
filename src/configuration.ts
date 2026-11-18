import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./data-lock.js";
import { Store } from "./store.js";
import {
  testModelConnection,
  validateModelSettings,
} from "./model-settings.js";

// A stopped configuration session holds the same exclusive lock as the gateway.
// A live session never opens SQLite: the owning process merges and validates keys.
export async function openConfiguration(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let release: () => void;
  try {
    release = acquireLock(dir);
  } catch {
    let origin: URL, token: string;
    try {
      origin = new URL(
        JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8")).origin,
      );
      if (
        origin.protocol !== "http:" ||
        origin.hostname !== "127.0.0.1" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw Error();
      token = readFileSync(join(dir, "webhook-token"), "utf8").trim();
    } catch {
      throw Error("配置正被使用；请稍后重试，或先停止网关。");
    }
    const request = async (suffix = "", body?: unknown) => {
      try {
        const r = await fetch(new URL("/api/local-config" + suffix, origin), {
          method: body ? "POST" : "GET",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            origin: origin.origin,
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(suffix ? 17000 : 5000),
        });
        if (!r.ok) {
          await r.body?.cancel();
          throw Error();
        }
        return await r.json();
      } catch {
        throw Error("网关配置请求失败；设置未确认，请重试。");
      }
    };
    const current = await request();
    return {
      current,
      save: (c: Record<string, unknown>) => request("", c),
      test: (c: Record<string, unknown>) => request("/test", c),
      close() {},
    };
  }
  let store: Store;
  try {
    store = new Store(dir, { recover: false });
  } catch (e) {
    release();
    throw e;
  }
  return {
    current: store.snapshot().config,
    async save(c: Record<string, unknown>) {
      store.saveConfig(c);
    },
    async test(c: Record<string, unknown>) {
      await testModelConnection(validateModelSettings(c, store.config()));
    },
    close() {
      store.close();
      release();
    },
  };
}
