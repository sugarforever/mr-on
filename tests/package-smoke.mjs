import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

const temp = mkdtempSync(join(tmpdir(), "mr-on-package-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
let child;
try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", temp]),
  )[0];
  for (const { path } of packed.files) {
    assert.match(
      path,
      /^(dist\/src\/[^/]+\.js|public\/.+|skills\/.+|package.json|LICENSE|README.md|docs\/(npm-release|gateway-service|onboarding).md)$/,
    );
    assert.doesNotMatch(
      path,
      /(?:state\.sqlite|webhook-token|\.env|\.data\/|node_modules\/|tests\/)/,
    );
  }
  run("npm", [
    "install",
    "--prefix",
    temp,
    "--omit=dev",
    join(temp, packed.filename),
  ]);
  const cli = join(temp, "node_modules/.bin/mr-on");
  const env = {
    ...process.env,
    HOME: temp,
    MR_ON_DATA: join(temp, "unused-data"),
  };
  assert.match(run(cli, ["--help"], { cwd: temp, env }), /用法：mr-on/);
  assert.equal(run(cli, ["--version"], { cwd: temp, env }).trim(), "0.1.0");
  assert(!readdirSync(temp).includes("unused-data"));
  assert(!readdirSync(temp).includes(".mr-on"));
  for (const command of ["onboard", "configure"]) {
    const nonInteractive = spawnSync(cli, [command], {
      cwd: temp,
      env,
      encoding: "utf8",
      input: "",
    });
    assert.equal(nonInteractive.status, 1);
    assert.match(nonInteractive.stdout, /交互式/);
    assert(!readdirSync(temp).includes("unused-data"));
  }
  assert(packed.files.some(({ path }) => path === "docs/onboarding.md"));
  assert(packed.files.some(({ path }) => path === "docs/gateway-service.md"));
  const invalid = spawnSync(cli, ["unknown-secret-marker"], {
    cwd: temp,
    env,
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert(!invalid.stderr.includes("unknown-secret-marker"));
  const dry = JSON.parse(
    run(
      cli,
      [
        "service",
        "install",
        "--dry-run",
        "--platform",
        "linux",
        "--data",
        join(temp, "explicit data"),
      ],
      { cwd: temp, env },
    ),
  );
  assert(dry.definition.content.includes(join(temp, "explicit data")));
  // Let the OS select an available port, then start the installed executable.
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  child = spawn(cli, ["start", "--data", join(temp, "actual data")], {
    cwd: temp,
    env: { ...env, PORT: String(port) },
    stdio: "ignore",
  });
  let response;
  for (let i = 0; i < 100; i++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(response?.ok, "installed gateway must start outside source checkout");
  assert.match(await response.text(), /<html/);
  const asset = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert(asset.ok);
  // The compiled skill loader must find the bundled skill without source files.
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(new URL(`file://${resolve(temp, "node_modules/mr-on/dist/src/user-skill.js")}`).href)}); if (!m.loadUnderstandingSkill()) process.exit(1);`,
    ],
    { cwd: temp },
  );
  console.log(
    "Tarball install, executable, data paths, web assets and bundled skills passed",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  rmSync(temp, { recursive: true, force: true });
}
