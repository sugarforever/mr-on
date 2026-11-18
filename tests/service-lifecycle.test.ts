import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as service from "../src/service.js";
import { renderService } from "../src/service-config.js";

function fixture(platform = "linux") {
  const home = mkdtempSync(join(tmpdir(), "mr-service-life-"));
  const root = join(home, "package space");
  mkdirSync(join(root, "dist/src"), { recursive: true });
  writeFileSync(join(root, "dist/src/server.js"), "");
  const calls: string[][] = [];
  const urls: string[] = [];
  const io = {
    home,
    root,
    node: "/opt/node space/node",
    platform,
    uid: process.getuid!(),
    run: (argv: string[]) => {
      calls.push(argv);
      return { status: 0 };
    },
    fetch: async (url: string) => {
      urls.push(url);
      return { ok: true };
    },
    output: (_text: string) => {},
    readinessTimeoutMs: 20,
  };
  return {
    home,
    root,
    calls,
    urls,
    io,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("service exports an import-safe async command", () => {
  assert.equal(typeof service.main, "function");
});

test("install pins absolute paths and controls reuse installed port and data", async () => {
  const f = fixture();
  try {
    await service.main(
      ["install", "--data", join(f.home, "data space"), "--port", "5522"],
      f.io,
    );
    assert.deepEqual(f.urls, ["http://127.0.0.1:5522/readyz"]);
    assert.match(
      readFileSync(
        join(f.home, ".config/systemd/user/mr-on-gateway.service"),
        "utf8",
      ),
      /package space/,
    );
    f.urls.length = 0;
    await service.main(["restart"], {
      ...f.io,
      root: "/elsewhere",
      defaultData: "/wrong",
    });
    assert.deepEqual(f.urls, ["http://127.0.0.1:5522/readyz"]);
    await assert.rejects(() => service.main(["install"], f.io), /已存在/);
    await service.main(["uninstall"], f.io);
    await service.main(["uninstall"], f.io);
    assert.equal(existsSync(join(f.home, "data space")), true);
  } finally {
    f.clean();
  }
});

test("missing status and stop are harmless; manager failures retain definition", async () => {
  const f = fixture();
  try {
    await service.main(["status"], f.io);
    await service.main(["stop"], f.io);
    assert.equal(f.calls.length, 0);
    await assert.rejects(
      () =>
        service.main(["install"], {
          ...f.io,
          run: () => ({ status: 1 }),
        }),
      /系统命令失败/,
    );
    assert.equal(
      existsSync(join(f.home, ".config/systemd/user/mr-on-gateway.service")),
      true,
    );
  } finally {
    f.clean();
  }
});

test("readiness is bounded and uses no model; error preserves installed definition", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        service.main(["install"], {
          ...f.io,
          fetch: async () => ({ ok: false }),
          readinessTimeoutMs: 1,
        }),
      /readyz.*logs/,
    );
    assert.equal(
      existsSync(join(f.home, ".config/systemd/user/mr-on-gateway.service")),
      true,
    );
  } finally {
    f.clean();
  }
});

test("rejects npx installation targets, foreign definitions and unsupported systems", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        service.main(["install"], {
          ...f.io,
          root: "/home/me/.npm/_npx/abcd/node_modules/mr-on",
        }),
      /npm install -g/,
    );
    await assert.rejects(
      () => service.main(["install"], { ...f.io, platform: "win32" }),
      /macOS.*Linux/,
    );
    const d = renderService("linux", {
      ...f.io,
      data: join(f.home, "data"),
      port: 4317,
    });
    mkdirSync(join(f.home, ".config/systemd/user"), { recursive: true });
    writeFileSync(d.path, "not ours");
    await assert.rejects(() => service.main(["stop"], f.io), /安全/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.clean();
  }
});

test("macOS start is idempotent and stopped uninstall accepts ESRCH", async () => {
  const f = fixture("darwin");
  try {
    await service.main(["install"], f.io);
    f.calls.length = 0;
    await service.main(["start"], f.io);
    assert.deepEqual(
      f.calls.map((a) => a[1]),
      ["print"],
    );
    await service.main(["uninstall"], {
      ...f.io,
      run: () => ({ status: 3 }),
    });
    assert.equal(
      existsSync(join(f.home, "Library/LaunchAgents/ai.mr-on.gateway.plist")),
      false,
    );
  } finally {
    f.clean();
  }
});

test("legacy definition readiness uses its saved data and port; dry-run preserves bytes", async () => {
  const f = fixture();
  try {
    await service.main(["install", "--port", "5523"], f.io);
    const path = join(f.home, ".config/systemd/user/mr-on-gateway.service");
    const legacy = readFileSync(path, "utf8").replace(
      /^# mr-on-config:.*\n/m,
      "",
    );
    writeFileSync(path, legacy);
    f.urls.length = 0;
    await service.main(["start"], f.io);
    assert.deepEqual(f.urls, ["http://127.0.0.1:5523/readyz"]);
    let output = "";
    await service.main(["logs", "--dry-run"], {
      ...f.io,
      output: (s: string) => {
        output = s;
      },
    });
    assert.equal(JSON.parse(output).definition.content, legacy);
  } finally {
    f.clean();
  }
});

test("root install is refused", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => service.main(["install"], { ...f.io, uid: 0 }),
      /普通用户/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.clean();
  }
});

test("macOS stopped status succeeds while unrelated manager failures are reported", async () => {
  const f = fixture("darwin");
  try {
    await service.main(["install"], f.io);
    await service.main(["stop"], { ...f.io, run: () => ({ status: 3 }) });
    await service.main(["status"], { ...f.io, run: () => ({ status: 113 }) });
    await assert.rejects(
      () => service.main(["start"], { ...f.io, run: () => ({ status: 1 }) }),
      /系统命令失败/,
    );
  } finally {
    f.clean();
  }
});

test("readiness retries real HTTP 503 and aborts a stalled endpoint", async () => {
  const { createServer } = await import("node:http");
  let count = 0;
  let stalled = false;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/readyz");
    count++;
    if (stalled) return;
    res.writeHead(count === 1 ? 503 : 200).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const f = fixture();
  try {
    await service.main(["install", "--port", String(port)], {
      ...f.io,
      fetch: undefined,
      readinessTimeoutMs: 2000,
    });
    assert.equal(count, 2);
    stalled = true;
    const before = Date.now();
    await assert.rejects(
      () =>
        service.main(["start"], {
          ...f.io,
          fetch: undefined,
          readinessTimeoutMs: 40,
        }),
      /readyz.*logs/,
    );
    assert.ok(Date.now() - before < 1500);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    f.clean();
  }
});
