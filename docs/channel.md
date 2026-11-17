# Shared local Channel

Web UI and CLI submit research questions and profile answers through the same admission service. Existing Pi Coding Agent 1.5.2 `AgentSession`/`SessionManager` still own model history, tool execution and compaction. No Pi Durable or additional chat engine is introduced.

## Start and authorize a CLI

Build and start Gateway as described in [Gateway service](gateway-service.md). It listens on loopback only. No service installation is required.

```sh
npm run build
npm start
# In another terminal, using the same MR_ON_DATA as the Gateway:
node dist/src/client.js credentials issue 'My terminal'
```

Issuance prints `{id, secret}` once. Save only the `secret` value to a private file (`chmod 600`), then set `MR_ON_CREDENTIAL_FILE` to its path. Do not use a webhook token. The server database stores only a SHA-256 hash of each high-entropy secret. Issuance, listing and revocation are local OS-authorized operations, opening SQLite directly without interrupting running jobs. Never paste secrets into URLs, issues or logs.

```sh
export MR_ON_CREDENTIAL_FILE=/absolute/private/cli-secret
export MR_ON_URL=http://127.0.0.1:4317
node dist/src/client.js list
node dist/src/client.js history research:ITEM_ID
node dist/src/client.js send research:ITEM_ID 'What should I verify?' --request-id my-question-001
node dist/src/client.js watch research:ITEM_ID
node dist/src/client.js send profile 'Build a useful prototype' --request-id profile-001 --dimension goals
node dist/src/client.js credentials list
node dist/src/client.js credentials revoke CREDENTIAL_ID
```

The credential has local-owner access to all Channel research/profile conversations, not administration, task mutation, model settings or webhook delivery. Revocation applies to new requests immediately and to open SSE subscriptions within the 250 ms authorization polling interval. Credential commands require filesystem access to the data directory. The browser remains a trusted same-origin local client; these credentials are for explicit CLI/API authentication, not a multi-user security boundary. Requests carrying invalid credentials cannot fall back to browser access.

## Protocol

All JSON endpoints are under `/api/channel/conversations`:

| Method and suffix                        | Result                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| `GET /`                                  | Available business conversation bindings             |
| `GET /:conversationId`                   | Committed history/state and an opaque cursor         |
| `POST /:conversationId/messages`         | Atomic queue admission and stable acceptance receipt |
| `GET /:conversationId/events?cursor=...` | Up to 256 durable ordered events after cursor        |
| `GET /:conversationId/stream?cursor=...` | SSE replay followed by live events                   |

Research conversation IDs are `research:<existing item ID>`; the profile conversation is `profile`. These are lightweight business routing references, not Pi session or execution IDs. History includes the current Pi session ID and existing item/job/run/message IDs. Each admitted execution has its own run ID. Clients never choose their authenticated identity or Pi session path. Profile continues to use its restricted skill and no research tools. There is no unrestricted main chat.

Submission requires `{requestId, text}` and, for profile, a valid `dimension`. Use a fresh stable requestId (1–100 ASCII letters, digits, period, underscore, colon or hyphen) for each logical submission. Repeating the same normalized content and conversation returns the exact original receipt, even across Web/CLI identities or Gateway restarts. Different content/conversation under the same requestId returns HTTP 409. User message, queue entry and receipt commit in one SQLite transaction. A failed transaction creates none of them. Missing/invalid input returns 400. After profile memory reset, an old receipt returns 410; use a new requestId. Legacy research HTTP endpoints remain compatible and generate an ID if omitted; clients needing safe network retry must provide one.

SSE frames have opaque `id` cursors and `change` events containing sequence, conversation, entity ID, type (`message`, `run`, `reset`) and status. Events deliberately contain no message body: read committed history to display finalized replies. `Last-Event-ID` takes precedence over the query cursor. Apply each sequence once; fetching/replacing history by stable IDs prevents duplicate visible messages. Cursorless, malformed, wrong-conversation, ahead-of-head or unavailable cursors return an explicit `snapshot` SSE event, or `{snapshotRequired:true,snapshot,cursor}` from the JSON endpoint. A snapshot replaces local state and establishes the next replay cursor. JSON clients must continue paging while batches contain 256 events. CLI watch outputs snapshots plus cursors and reconnects after clean disconnects; rerun with `--cursor` after a transport error or process exit.

## Persistence, migration and boundaries

The first startup adds Channel tables and SQLite triggers without moving, renaming or copying existing research/profile history or Pi sessions. Existing conversations become bindings automatically. The event journal starts at migration; older history is available through the explicit snapshot path. SQLite triggers record subsequent message and lifecycle changes in the same transactions as the existing queues, including startup interruption recovery. Disconnecting a client does not cancel admitted work. Research tasks still serialize per task with two independent workers. Profile admission remains serialized. Failed/interrupted runs still require explicit manual retry through the existing Web controls; submission retries never retry execution.

The database retains receipts and ordered metadata events without automatic expiry in this version. Profile reset deletes model memory and profile history as before; receipts retain only fingerprints and identifiers to prevent accidental resurrection. Events contain identifiers/status only. The application is single-owner, local-only and assumes trusted OS/filesystem access. Channel history APIs return complete committed research/profile conversation history; the general Web overview retains its bounded snapshot. Pi owns the full native model history. Text deltas and remote deployment are out of scope. Large histories may require pagination in a future version. Real external models are not required for offline acceptance tests.
