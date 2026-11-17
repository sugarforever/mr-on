import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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

test(
  "CLI preserves existing definitions and can uninstall an already stopped macOS service",
  { skip: process.platform !== "darwin" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-install-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "launchctl"),
      '#!/bin/sh\nif [ "$1" = "bootout" ]; then exit 3; fi\nexit 0\n',
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      HOME: dir,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const cli = (action: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/service.ts",
          action,
          "--data",
          join(dir, "data"),
        ],
        { env, encoding: "utf8" },
      );
    try {
      assert.equal(cli("install").status, 0);
      const path = join(dir, "Library/LaunchAgents/ai.mr-on.gateway.plist");
      const original = readFileSync(path, "utf8");
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(cli("install").status, 1);
      assert.equal(readFileSync(path, "utf8"), original);
      assert.equal(cli("uninstall").status, 0);
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
