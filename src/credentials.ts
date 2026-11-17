import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export function credentialSchema(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS channel_credentials(id TEXT PRIMARY KEY,label TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,createdAt INTEGER NOT NULL,revokedAt INTEGER);`,
  );
}
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function issueCredential(db: DatabaseSync, label: string) {
  if (!label.trim() || label.length > 100)
    throw Error("Label must be 1–100 characters");
  const id = randomUUID(),
    secret = "mr_cli_" + randomBytes(32).toString("hex");
  db.prepare("INSERT INTO channel_credentials VALUES(?,?,?,?,NULL)").run(
    id,
    label.trim(),
    hash(secret),
    Date.now(),
  );
  return { id, secret };
}
export function credentialIdentity(db: DatabaseSync, secret: string) {
  if (!secret.startsWith("mr_cli_") || secret.length !== 71) return null;
  return (
    (db
      .prepare(
        "SELECT id FROM channel_credentials WHERE hash=? AND revokedAt IS NULL",
      )
      .get(hash(secret))?.id as string | undefined) ?? null
  );
}
export function listCredentials(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id,label,createdAt,revokedAt FROM channel_credentials ORDER BY createdAt,id",
    )
    .all();
}
export function revokeCredential(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "UPDATE channel_credentials SET revokedAt=? WHERE id=? AND revokedAt IS NULL",
    )
    .run(Date.now(), id);
}
