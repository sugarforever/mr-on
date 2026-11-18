import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderService } from "../src/service-config.js";

const options = {
  node: "/opt/Node Tools/node",
  root: "/opt/mr on",
  data: "/var/lib/mr on",
  port: 4317,
  home: "/home/user",
  uid: 501,
};
test("service definitions preserve spaced paths, data, restart and stop policies", () => {
  const linux = renderService("linux", options);
  assert.match(
    linux.content,
    /ExecStart="\/opt\/Node Tools\/node" "\/opt\/mr on\/dist\/src\/server.js"/,
  );
  assert.match(linux.content, /Environment="MR_ON_DATA=\/var\/lib\/mr on"/);
  assert.match(linux.content, /Restart=always/);
  assert.match(linux.content, /TimeoutStopSec=120/);
  const mac = renderService("darwin", { ...options, root: "/opt/a&b" });
  assert.match(mac.content, /\/opt\/a&amp;b\/dist\/src\/server.js/);
  assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/);
  assert.deepEqual(mac.commands.start, [
    "launchctl",
    "bootstrap",
    "gui/501",
    "/home/user/Library/LaunchAgents/ai.mr-on.gateway.plist",
  ]);
});
test("service definitions reject invalid ports, relative paths and injected directives", () => {
  for (const override of [
    { port: 0 },
    { port: 1.5 },
    { root: "relative" },
    { data: "/tmp/a\nRestart=no" },
  ])
    assert.throws(() => renderService("linux", { ...options, ...override }));
  assert.throws(() => renderService("win32", options));
  const linux = renderService("linux", { ...options, data: "/tmp/100%/$HOME" });
  assert.match(linux.content, /100%%\/\$HOME/);
});
test("CLI dry-run installs nothing and passes arguments without a shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-service-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/service.ts",
        "install",
        "--dry-run",
        "--platform",
        "linux",
        "--data",
        join(dir, "data space"),
      ],
      { encoding: "utf8", env: { ...process.env, HOME: dir } },
    );
    const plan = JSON.parse(output);
    assert.equal(plan.dryRun, true);
    assert.match(plan.definition.content, /Restart=always/);
    assert.deepEqual(plan.commands[0], [
      "systemctl",
      "--user",
      "daemon-reload",
    ]);
    assert.equal(existsSync(join(dir, "data space")), false);
    assert.equal(existsSync(join(dir, ".config")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
