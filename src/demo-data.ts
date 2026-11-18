import { Store } from "./store.js";
import { readPublicUrl } from "./reader.js";
export const DEMO_URL = "https://demo.mr-on.invalid/releases";
export const BASELINE =
  "Pi Demo 1.0: persistent sessions and public source reading.";
export function demoReader(store: Store) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS demo_document(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO demo_document VALUES(1,1)",
  );
  return async (url: string, signal?: AbortSignal) => {
    if (url === DEMO_URL) {
      if (store.config().mode !== "demo")
        throw Error("Demo sources are only available in demo mode");
      const rev = store.db
        .prepare("SELECT revision FROM demo_document WHERE id=1")
        .get()!.revision;
      return `${BASELINE}\nDemo version ${rev}：${Number(rev) > 1 ? "Adds event triggers and deprecates legacy configuration fields; check compatibility before upgrading." : "No breaking changes at present."}`;
    }
    return readPublicUrl(url, signal);
  };
}
