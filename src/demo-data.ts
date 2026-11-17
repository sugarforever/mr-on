import { Store } from "./store.js";
import { readPublicUrl } from "./reader.js";
export const DEMO_URL = "https://demo.mr-on.invalid/releases";
export const BASELINE = "Pi Demo 1.0：提供持久会话与公开资料读取。";
export function demoReader(store: Store) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS demo_document(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO demo_document VALUES(1,1)",
  );
  return async (url: string, signal?: AbortSignal) => {
    if (url === DEMO_URL) {
      if (store.config().mode !== "demo")
        throw Error("演示资料仅适用于演示模式");
      const rev = store.db
        .prepare("SELECT revision FROM demo_document WHERE id=1")
        .get()!.revision;
      return `${BASELINE}\n演示版本 ${rev}：${Number(rev) > 1 ? "新增事件唤醒，旧版配置字段将弃用；升级前请检查兼容性。" : "当前没有破坏性变化。"}`;
    }
    return readPublicUrl(url, signal);
  };
}
