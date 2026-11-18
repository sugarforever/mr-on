import {
  openSync,
  writeFileSync,
  closeSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
export function acquireLock(dir: string): () => void {
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
    if (alive)
      throw Error("A service is already running with this data directory");
    unlinkSync(path);
    return acquireLock(dir);
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {}
  };
}
