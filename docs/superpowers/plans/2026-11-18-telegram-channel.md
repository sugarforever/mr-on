# Telegram Channel Implementation Plan

**Goal:** An opt-in Telegram private-chat adapter for existing research/profile conversations.

**Architecture:** Native Bot API long polling feeds the existing Channel admission transaction. SQLite stores bot-scoped offsets, chat selections, submitted-run watches and an ordered durable outbox. Polling and delivery run independently; permissions come only from a private local file and are rechecked before admission and delivery. Pi execution remains unchanged.

**Tech Stack:** TypeScript, Node fetch, SQLite, existing Pi Coding Agent SDK 1.5.2.

**Spec:** Authorized task in this chat; protocol details in `docs/telegram.md`.

## Constraints and review focus

- Default off; English copy; allowlisted private sender/chat pairs with explicit conversation grants.
- Never log token, Telegram URLs, raw transport errors or external API descriptions.
- Offset/admission/watch/ack share a transaction; terminal results enter outbox transactionally.
- No webhook deletion, no task management, no new model loop; local token lock plus fatal 409 conflict.
- Check permission revocation, reset history, output limits, ambiguous delivery and restart boundaries.

## Tasks

- [x] Write failing integration tests for authenticated updates, duplicate/restart admission, same Pi session, isolated delivery and revoked grants.
- [x] Implement `src/telegram.ts` adapter, configuration loader and sanitized injectable Bot API transport; extend Channel identity union only.
- [x] Add failing transport/runtime tests for retry_after, failures, webhook/poller conflicts, shutdown, secrets and multipart replies; implement worker lifecycle in `src/telegram-runtime.ts` and Gateway startup/shutdown.
- [x] Document commands, private configuration, service environment and delivery guarantees in `docs/telegram.md`; link README.
- [x] Run build, full tests, demo, UI tests, format/browser checks; independent code review and fixes; commit/push, check duplicate PRs, create PR and inspect CI.

Execution proceeds natively under the user's explicit authorization; independent review follows implementation.

Local validation: build, 48 backend tests, 5 browser tests, demo, formatting, browser syntax and dependency audit passed. Independent review findings fixed and re-reviewed. PR and CI outcomes are recorded in the PR.
