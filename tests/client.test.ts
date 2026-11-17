import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../src/server.js";
import { issueCredential } from "../src/credentials.js";
function cli(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", resolve("src/client.ts"), ...args],
        { env: { ...process.env, ...env } },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.once("error", reject);
      child.once("exit", (code) => done({ code, out, err }));
    },
  );
}
test("CLI reads the reply submitted by Web in the same native Pi session and retries a stable request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-client-")),
    svc = createApp(dir, "hook");
  const server = svc.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const tokenFile = join(dir, "cli-token"),
    cred = issueCredential(svc.store.db, "integration");
  writeFileSync(tokenFile, cred.secret, { mode: 0o600 });
  const env = {
    MR_ON_URL: base,
    MR_ON_CREDENTIAL_FILE: tokenFile,
    MR_ON_DATA: dir,
  };
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await post("/api/demo/start", {});
    await svc.engine.drain();
    await post("/api/demo/change", {});
    await svc.engine.drain();
    const item = svc.store.all("items")[0],
      id = "research:" + item.id;
    const sent = await post(`/api/channel/conversations/${id}/messages`, {
      requestId: "web-closed",
      text: "浏览器关闭后继续",
    });
    assert.equal(sent.status, 202);
    await sent.body?.cancel();
    await svc.engine.drain();
    const history = await cli(["history", id], env);
    assert.equal(history.code, 0, history.err);
    const state = JSON.parse(history.out);
    assert.equal(state.messages.length, 2);
    assert.equal(state.sessionId, item.sessionId);
    assert.ok(
      readFileSync(item.sessionPath, "utf8").includes("浏览器关闭后继续"),
    );
    const first = await cli(
      ["send", id, "CLI跟进", "--request-id", "cli-retry"],
      env,
    );
    assert.equal(first.code, 0, first.err);
    await svc.engine.drain();
    const again = await cli(
      ["send", id, "CLI跟进", "--request-id", "cli-retry"],
      env,
    );
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(JSON.parse(first.out), JSON.parse(again.out));
    const list = await cli(["credentials", "list"], env);
    assert.equal(list.code, 0, list.err);
    assert.ok(!list.out.includes(cred.secret));
    const unsafe = await cli(["history", id], {
      ...env,
      MR_ON_URL: "https://example.com",
    });
    assert.notEqual(unsafe.code, 0);
    assert.ok(!unsafe.err.includes(cred.secret));
  } finally {
    svc.closeStreams();
    await Promise.all([svc.engine.stop(), svc.profile.stop()]);
    await new Promise<void>((r) => server.close(() => r()));
    svc.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
