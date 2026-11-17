# Shared Channel implementation plan

**Goal:** Complete GitHub issue #2 with shared Web/CLI access to existing research and profile Pi sessions.
**Architecture:** A thin Channel service admits requests into existing queues. SQLite metadata, idempotency receipts and trigger-backed lifecycle events share existing transactions. Pi 1.5.2 remains the only agent engine.
**Spec:** https://github.com/sugarforever/mr-on/issues/2

## Constraints and review focus

- Loopback only; separate hashed CLI credentials; no machine service installation.
- Preserve research concurrency and profile permissions, interrupted jobs and manual retry.
- Invalid/revoked credentials cannot fall back to browser identity; revoke open streams.
- Crash between admission and execution must preserve exactly one message and run.
- Cursor belongs to one conversation; invalid/expired cursor explicitly returns snapshot.
- Profile forgetting must erase retained Channel content and prevent request replay.
- Existing session IDs and histories survive migration; no copied model history.

## Tasks

- [x] Test atomic admission, cross-client duplicate/conflict and restart persistence; implement `Channel.submit(conversationId, input, identity)` and metadata in `src/channel.ts`.
- [x] Test ordered durable events and snapshots, history and profile isolation; implement SQLite event triggers and Channel history/replay APIs.
- [x] Test credential hashing/revocation, authenticated reads/actions and SSE revocation; implement `src/credentials.ts` and HTTP routes.
- [x] Test CLI/Web interoperability; implement minimal `src/client.ts`, shared Web submission and replay subscriptions.
- [x] Document migration/protocol/security; run build, full tests, demo, UI, formatting/browser checks; independent review and fix.

Execution is authorized in the current checkout; continue directly through validation and PR creation.

Delivery: commit Channel separately from Gateway, push `codex/shared-channel` and open a PR to `main` with `Closes #2`. No deployment or merge.
