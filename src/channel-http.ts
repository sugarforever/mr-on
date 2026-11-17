import type express from "express";
import { Channel } from "./channel.js";
import { credentialIdentity } from "./credentials.js";
import type { Store } from "./store.js";
export function channelRoutes(
  app: express.Express,
  channel: Channel,
  store: Store,
  drain: () => void,
) {
  const streams = new Set<express.Response>();
  const identity = (req: express.Request) => ({
    principalId: (req as any).channelClient || "local-owner",
    clientId:
      typeof req.headers["x-mr-client"] === "string" &&
      /^[A-Za-z0-9._:-]{1,100}$/.test(req.headers["x-mr-client"])
        ? req.headers["x-mr-client"]
        : "unspecified",
    channel: ((req as any).channelClient ? "cli" : "web") as "cli" | "web",
  });
  app.use("/api", (req, res, next) => {
    if (!req.headers.authorization || req.path === "/webhook") return next();
    const value = req.headers.authorization;
    const id = value.startsWith("Bearer ")
      ? credentialIdentity(store.db, value.slice(7))
      : null;
    if (!id)
      return res
        .status(401)
        .json({ error: "Invalid or revoked Channel credential" });
    if (!req.path.startsWith("/channel/"))
      return res
        .status(403)
        .json({ error: "CLI credentials authorize Channel access only" });
    (req as any).channelClient = id;
    next();
  });
  app.get("/api/channel/conversations", (_req, res) =>
    res.json(channel.list()),
  );
  app.get("/api/channel/conversations/:id", (req, res) =>
    res.json(channel.history(req.params.id)),
  );
  app.post("/api/channel/conversations/:id/messages", (req, res) => {
    const receipt = channel.submit(req.params.id, req.body, identity(req));
    drain();
    res.status(202).json(receipt);
  });
  app.get("/api/channel/conversations/:id/events", (req, res) => {
    res.json(
      channel.replay(
        req.params.id,
        typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      ),
    );
  });
  app.get("/api/channel/conversations/:id/stream", (req, res) => {
    if (streams.size >= 16) return res.status(429).end();
    const id = req.params.id;
    let cursor =
      (typeof req.headers["last-event-id"] === "string"
        ? req.headers["last-event-id"]
        : undefined) ||
      (typeof req.query.cursor === "string" ? req.query.cursor : undefined);
    channel.bind(id);
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.flushHeaders();
    streams.add(res);
    let blockedAt = 0;
    const send = () => {
      if (res.destroyed || res.writableEnded) return;
      if (
        (req as any).channelClient &&
        credentialIdentity(store.db, req.headers.authorization!.slice(7)) !==
          (req as any).channelClient
      ) {
        res.end();
        return;
      }
      // Slow readers reconnect from their last applied event instead of accumulating memory.
      if (res.writableLength > 256 * 1024) {
        res.destroy();
        return;
      }
      if (res.writableNeedDrain) {
        if (++blockedAt > 40) res.destroy();
        return;
      }
      blockedAt = 0;
      const batch = channel.replay(id, cursor);
      if (batch.snapshotRequired) {
        res.write(
          `id: ${batch.cursor}\nevent: snapshot\ndata: ${JSON.stringify(batch.snapshot)}\n\n`,
        );
      } else
        for (const event of batch.events) {
          res.write(
            `id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
      cursor = batch.cursor;
      if (!batch.snapshotRequired && !batch.events.length)
        res.write(": heartbeat\n\n");
    };
    send();
    const timer = setInterval(() => {
      try {
        send();
      } catch {
        res.end();
      }
    }, 250);
    const cleanup = () => {
      clearInterval(timer);
      streams.delete(res);
    };
    res.once("close", cleanup);
    res.once("finish", cleanup);
  });
  return {
    submit: (req: express.Request, id: string) =>
      channel.submit(id, req.body, identity(req)),
    close: () => {
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}
