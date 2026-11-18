import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Package = { name?: string; version?: string; private?: boolean };
type Lock = Package & { packages?: Record<string, Package> };

export function validateRelease(tag: string, pkg: Package, lock: Lock): string {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ||
    tag.trim() !== tag
  )
    throw Error("Only stable vMAJOR.MINOR.PATCH tags can be published");
  const version = tag.slice(1);
  if (
    !pkg.name ||
    pkg.private ||
    pkg.version !== version ||
    lock.version !== version ||
    lock.name !== pkg.name ||
    lock.packages?.[""]?.version !== version ||
    lock.packages?.[""]?.name !== pkg.name
  )
    throw Error(
      "Release tag, package and lockfile must identify the same public package version",
    );
  return version;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  console.log(
    validateRelease(
      process.env.RELEASE_TAG || "",
      read("package.json"),
      read("package-lock.json"),
    ),
  );
}
