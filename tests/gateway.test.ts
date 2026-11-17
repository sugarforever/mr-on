import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Store } from "../src/store.js";

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
test(
  "Gateway survives forced restart with durable jobs and rejects a competing process",
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-process-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const store = new Store(dir);
    const task = store.createTask({
      name: "restart",
      url: "https://demo.mr-on.invalid/releases",
      goal: "check",
      intervalMinutes: 60,
    });
    const interrupted = store.enqueue(task.id);
    store.db
      .prepare("UPDATE runs SET status='running' WHERE id=?")
      .run(interrupted);
    const queued = store.enqueue(task.id);
    store.close();
    const children: ChildProcess[] = [];
    const launch = () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/server.ts"],
        {
          env: { ...process.env, MR_ON_DATA: dir, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stdout!.resume();
      child.stderr!.resume();
      return child;
    };
    const waitReady = async () => {
      for (let n = 0; n < 100; n++) {
        try {
          if (
            (
              await fetch(base + "/readyz", {
                signal: AbortSignal.timeout(250),
              })
            ).ok
          )
            return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Gateway did not become ready");
    };
    try {
      const first = launch();
      await waitReady();
      let state = (await (await fetch(base + "/api/state")).json()) as any;
      assert.equal(
        state.runs.find((r: any) => r.id === interrupted).status,
        "interrupted",
      );
      assert.equal(state.runs.find((r: any) => r.id === queued).status, "done");
      const firstId = state.runtime.instanceId;
      const competing = launch();
      const [exit] = await once(competing, "exit");
      assert.notEqual(exit, 0);
      assert.equal(
        ((await (await fetch(base + "/api/state")).json()) as any).runtime
          .instanceId,
        firstId,
      );
      const killed = once(first, "exit");
      first.kill("SIGKILL");
      await killed;
      const second = launch();
      await waitReady();
      state = (await (await fetch(base + "/api/state")).json()) as any;
      assert.notEqual(state.runtime.instanceId, firstId);
      assert.equal(state.runs.find((r: any) => r.id === queued).status, "done");
      const stopped = once(second, "exit");
      second.kill("SIGTERM");
      assert.equal((await stopped)[0], 0);
      assert.equal(existsSync(join(dir, "service.lock")), false);
    } finally {
      await Promise.all(
        children
          .filter((c) => c.exitCode === null && c.signalCode === null)
          .map(async (c) => {
            const exited = once(c, "exit");
            c.kill("SIGKILL");
            await exited;
          }),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
