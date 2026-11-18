import { homedir } from "node:os";
import { resolve } from "node:path";

/** Packaged commands never select data inside the package or npx cache. */
export function resolveDataDir(
  explicit?: string,
  env: { MR_ON_DATA?: string } = process.env,
  home = homedir(),
): string {
  return resolve(explicit || env.MR_ON_DATA || resolve(home, ".mr-on"));
}
