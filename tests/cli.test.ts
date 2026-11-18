import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveDataDir } from "../src/paths.js";
import { runCli } from "../src/cli.js";

test("data precedence uses a stable home default", () => {
  assert.equal(
    resolveDataDir(undefined, {}, "/home/example"),
    "/home/example/.mr-on",
  );
  assert.equal(
    resolveDataDir(undefined, { MR_ON_DATA: "env" }),
    resolve("env"),
  );
  assert.equal(
    resolveDataDir("explicit", { MR_ON_DATA: "env" }),
    resolve("explicit"),
  );
});

test("dispatch defaults to foreground and shares resolved data", async () => {
  const calls: unknown[] = [];
  const handler = (args: string[], data: string) => {
    calls.push([args, data]);
  };
  const handlers = {
    start: handler,
    service: handler,
    client: handler,
    onboard: handler,
    configure: handler,
  };
  await runCli(["--data", "/tmp/example"], handlers);
  for (const command of ["start", "service", "client", "onboard", "configure"])
    await runCli([command, "example", "--data", "/tmp/example"], handlers);
  assert.deepEqual(calls, [
    [[], "/tmp/example"],
    ...Array.from({ length: 5 }, () => [["example"], "/tmp/example"]),
  ]);
});

test("unknown commands and missing data fail before dispatch", async () => {
  await assert.rejects(runCli(["unknown"]), /未知命令/);
  await assert.rejects(runCli(["start", "--data"]), /--data/);
  await assert.rejects(runCli(["start", "--data", "--help"]), /--data/);
});
