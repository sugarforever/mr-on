import { test } from "node:test";
import assert from "node:assert/strict";
import { readPublicUrl } from "../src/reader.js";
test("controlled reader rejects schemes, credentials, ports and private DNS targets", async () => {
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://example.com:8080",
    "http://127.0.0.1",
    "http://localhost",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
  ])
    await assert.rejects(readPublicUrl(url));
});
