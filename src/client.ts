import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  credentialSchema,
  issueCredential,
  listCredentials,
  revokeCredential,
} from "./credentials.js";

export async function main(args = process.argv.slice(2)) {
  const [command, conversation, ...rest] = args;
  const print = (value: unknown) => console.log(JSON.stringify(value));
  if (command === "credentials") {
    const path = join(
      resolve(process.env.MR_ON_DATA || ".data"),
      "state.sqlite",
    );
    if (!existsSync(path))
      throw Error("Start the Gateway once before managing credentials");
    // Open SQLite directly: credential management must never invoke job recovery.
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      credentialSchema(db);
      if (conversation === "issue") print(issueCredential(db, rest.join(" ")));
      else if (conversation === "list") print(listCredentials(db));
      else if (conversation === "revoke" && rest[0]) {
        revokeCredential(db, rest[0]);
        print({ revoked: rest[0] });
      } else
        throw Error("Usage: credentials issue <label> | list | revoke <id>");
    } finally {
      db.close();
    }
    return;
  }
  if (!["list", "history", "send", "watch"].includes(command))
    throw Error(
      "Usage: list | history <conversation> | send <conversation> <text> --request-id <id> [--dimension <id>] | watch <conversation> [--cursor <cursor>]",
    );
  const base = new URL(process.env.MR_ON_URL || "http://127.0.0.1:4317");
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw Error("MR_ON_URL must be a loopback HTTP origin");
  const credentialPath = process.env.MR_ON_CREDENTIAL_FILE;
  if (!credentialPath)
    throw Error(
      "Set MR_ON_CREDENTIAL_FILE to a private file containing the CLI secret",
    );
  const stat = statSync(credentialPath);
  if (!stat.isFile() || stat.mode & 0o077)
    throw Error("Credential file must be private (chmod 600)");
  const secret = readFileSync(credentialPath, "utf8").trim();
  const headers = {
    authorization: "Bearer " + secret,
    "content-type": "application/json",
    "x-mr-client": randomUUID(),
  };
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, base), {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Gateway rejected request (${response.status})`);
    }
    return response;
  };
  const path =
    "/api/channel/conversations" +
    (command === "list" ? "" : "/" + encodeURIComponent(conversation || ""));
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i < 0 ? undefined : rest[i + 1];
  };
  try {
    if (command === "list" || command === "history")
      print(await (await request(path)).json());
    if (command === "send") {
      const requestId = option("--request-id");
      if (!requestId || !rest[0] || rest[0].startsWith("--"))
        throw Error("send requires text and --request-id for safe retries");
      print(
        await (
          await request(path + "/messages", {
            requestId,
            text: rest[0],
            dimension: option("--dimension"),
          })
        ).json(),
      );
    }
    if (command === "watch") {
      let cursor = option("--cursor");
      while (!controller.signal.aborted) {
        const response = await request(
          path +
            "/stream" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        );
        const reader = response.body!.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const lines = frame.split("\n"),
                data = lines.find((l) => l.startsWith("data: "));
              if (!data) continue;
              const next = lines.find((l) => l.startsWith("id: "))?.slice(4);
              const snapshot = frame.includes("event: snapshot")
                ? JSON.parse(data.slice(6))
                : await (await request(path)).json();
              print({ cursor: next, snapshot });
              cursor = next;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        // A revoked connection is checked again before reconnecting; errors are redacted.
        await (await request(path)).body?.cancel();
        await new Promise<void>((r) => {
          const timer = setTimeout(r, 500);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              r();
            },
            { once: true },
          );
        });
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    // Never echo fetch exceptions, request headers, or model errors.
    console.error(
      error instanceof Error &&
        /^(Usage:|Set MR_ON_|MR_ON_URL|Credential file|Start the Gateway|send requires|Gateway rejected|Label must)/.test(
          error.message,
        )
        ? error.message
        : "CLI request failed; check Gateway and credential file",
    );
    process.exitCode = 1;
  });
}
