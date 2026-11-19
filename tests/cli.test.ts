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

test("CLI shows controlled service recovery guidance but redacts arbitrary errors", async () => {
  const cli = await import("../src/cli.js");
  const config = await import("../src/service-config.js");
  assert.equal(typeof cli.cliErrorMessage, "function");
  const guidance =
    "npx 缓存不能作为后台服务路径；请先 npm install -g @verysmallwoods/mron";
  assert.equal(
    cli.cliErrorMessage(new config.ServiceCommandError(guidance)),
    guidance,
  );
  assert.doesNotMatch(
    cli.cliErrorMessage(new Error("api-key-secret")),
    /api-key-secret/,
  );
});

test("executable rejects npx service targets with global-install guidance", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "mr-npx-cli-"));
  try {
    const pkg = join(root, "_npx/package");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
    for (const file of [
      "cli.ts",
      "paths.ts",
      "service.ts",
      "service-config.ts",
    ])
      copyFileSync(resolve("src", file), join(pkg, "src", file));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(pkg, "src/cli.ts"),
        "service",
        "install",
      ],
      {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm install -g @verysmallwoods\/mron/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
