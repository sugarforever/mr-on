# mr-on

An always-on agent prototype that runs locally. Configure a public source URL and research goal, and it checks the source on a schedule or in response to external events. When it finds a new body version, it explains the impact in the in-app inbox. You can ask follow-up questions about the change or schedule further analysis.

The interface defaults to Chinese, supports one user, and listens only locally. A persistent Node service waits for events, the Pi Coding Agent SDK handles model execution and persistent sessions, and SQLite stores business progress.

![Workspace overview](docs/screenshots/overview.png)

## Installation and startup

After a global installation, run `mron onboard` for guided setup; use `mron configure` to change model settings later. See [npm releases](docs/npm-release.md) for installation/release status and [terminal onboarding](docs/onboarding.md) for configuration details.

Running from source requires Node.js **22.19+** (development verification used Node 26.8.1) and npm.

```bash
npm ci
npm run build
npm start
```

Open the [local workspace](http://127.0.0.1:4317). The default is **offline demo mode**, with no model credentials required.

To keep running after closing the terminal, build first and preview background installation with `npm run service -- install --dry-run`. Then run `npm run service -- install` to use a macOS launchd or Linux systemd user service. See [Gateway background service](docs/gateway-service.md). Installation does not open public network ports.

Web and CLI clients share research-item and profile conversations. The CLI uses separate, revocable credentials and supports history and persistent-event subscriptions. See [shared Channel access](docs/channel.md) for usage and protocol details.

For development, run `npm run dev`. Press Ctrl+C to exit; the service stops accepting requests, waits for current runs, then releases the database and process lock. Public deployment is unnecessary.

Optional environment variables:

| Variable     | Default | Purpose                                                        |
| ------------ | ------- | -------------------------------------------------------------- |
| `PORT`       | `4317`  | Local listening port                                           |
| `MR_ON_DATA` | `.data` | Data directory, resolved against the current working directory |

```bash
MR_ON_DATA=/absolute/path/to/data PORT=4317 npm start
```

The data directory contains `state.sqlite`, SQLite WAL files, `pi/sessions/`, `webhook-token`, and `service.lock`. Directory permissions are `0700`; database and token files are `0600`. API keys are saved in server-side SQLite settings **without application-layer encryption**; they are not returned to the browser or written to application logs. Pi uses an isolated configuration directory and in-memory credentials, without reading global Pi extensions, skills, project instructions, or shell configuration. Profile sessions explicitly load only the bundled understand-user skill. Keep the data directory out of version control.

## Proactively getting to know the user

After startup, the home page and inbox show an invitation to share some background. Open it to enter the profile page, where you can chat one question at a time or switch to an all-at-once form. Eight dimensions cover background, goals, interests, working style, communication preferences, daily rhythm, boundaries, and desired help. Skip anything you do not wish to share. UI labels are currently in Chinese.

The profile stores the user's explicitly supplied original words and supports editing and deletion. Manual access remains available after disabling proactive invitations. Unanswered invitations do not repeat; snoozing waits 24 hours, and normal update invitations follow a seven-day cadence. SSE pushes changes to connected clients, with polling as a disconnection fallback.

The product explicitly loads `skills/understand-user`; profile sessions have no tools. Editing clears the old profile session; deletion disables invitations and removes dedicated conversation history. Research sessions and existing results remain. Real-model mode sends relevant statements to the configured service as explained in the UI.

[Detailed design and data boundaries](docs/user-understanding.md)

## Five-minute offline demo

1. Use the offline-demo button to establish the demo source's initial baseline. The first read sends no notification.
2. Run an immediate check. With no source change, it still sends no notification.
3. Simulate a source change. The app updates the demo body in SQLite and uses the real Pi SDK with a fixed provider fixture to generate a clearly labeled demo result.
4. Open the change in the inbox and ask “What should I verify before upgrading?” The reply reuses that item's original Pi session. Expand session/routing information to inspect IDs.
5. Schedule follow-up analysis in the same detail view for the next minute. Stop the service, wait until it is due, and restart. The plan executes once, delivers a result to the inbox, and reuses the same session.
6. Pausing a task stops recurring wakeups and follow-ups that have not yet been queued. Manual execution and accepted events can still trigger work; current runs are not canceled. Resuming starts a fresh check interval.

Only the reserved URL `https://demo.mr-on.invalid/releases` uses a local source fixture. Other public URLs still read real network content even in offline demo mode; model explanations remain fixed demo replies. **The offline demo verifies SDK execution, persistent sessions, compaction, and business routing, but does not establish real online-model compatibility or analysis quality.**

You can also run a command-line demo without public-network access:

```bash
npm run demo
```

It uses a temporary data directory to demonstrate baselines, changes, notifications, questions, event deduplication, and schedule recovery after database closure. It removes the temporary directory afterward without changing your workspace data.

## Connect a real model

Open model settings, select real-model mode, and supply an HTTPS service endpoint, model ID, and API key. For example:

- Endpoint: `https://api.openai.com/v1`
- Model ID: `gpt-4o-mini`
- API key: your server-side credential

The adapter uses Pi's `openai-completions` API: an OpenAI-compatible Chat Completions service, not the Responses API. Models must support tool calls and streamed replies. New runs use saved configuration; existing runs retain their startup configuration. Leaving the API-key field empty preserves the existing credential.

Create a task for a real public source and check immediately to establish its baseline. The model runs only on the next body change. Each new item session can read only the task's configured URL. It cannot execute shell commands, browse arbitrary files, publish content, or send external messages. Notifications stay in the app.

Online-model validation has not been performed with a real API key. When changing providers, first test tool calls, streaming, output length, and error handling on a small source.

## Webhooks and event deduplication

The events/webhook page generates copyable examples containing the actual taskId. With default configuration, run this from the repository directory:

```bash
TOKEN="$(cat .data/webhook-token)"
curl -X POST http://127.0.0.1:4317/api/webhook \
  -u "events:$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"release-2026-001","taskId":"REPLACE_WITH_TASK_ID","payload":{"source":"release-hook"}}'
```

The Basic username is always `events`. A random token is generated on first startup and retained across restarts. Event receipt and check enqueueing commit in one SQLite transaction before HTTP 202 is returned. Repeating a global `eventId` returns `duplicate: true` without executing again; an ID belonging to a different task is rejected. `payload` is stored as a receipt record, not executed as model instructions.

The interface binds only `127.0.0.1` and does not receive public webhooks directly. If needed, configure an authenticated proxy or tunnel yourself; the project does not automatically open ports. The UI API restricts cross-site requests using Host, Origin, Fetch Metadata, and JSON Content-Type; webhooks additionally require Basic authentication. There is no multi-user login system, and direct public exposure is unsuitable.

## Persistence and recovery guarantees

| State or event                                             | Recovery behavior                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring task misses multiple checks                      | Coalesces into one catch-up on next startup, then calculates the next check from the current time                                     |
| Due one-shot follow-up                                     | Queues once if the task is not paused, preserving itemId and session links                                                            |
| Committed queued run                                       | Continues after restart                                                                                                               |
| Run was running when the process stopped                   | Becomes interrupted; no claim of exact tool-state recovery. Run history offers manual retry                                           |
| Accepted event arrives again                               | Permanent database eventId deduplication survives restart                                                                             |
| Source unchanged or returns to an already reported version | Code compares body SHA-256; no model call or duplicate notification                                                                   |
| Explanation fails                                          | Source cursor does not advance; a later periodic check or manual retry can process it again                                           |
| Crash while writing a notification                         | Item, notification, cursor, and successful run state commit in one transaction                                                        |
| Model replies, then crash before business commit           | May leave an unlinked Pi session. The run retains its path; manual retry may call the model again, but no partial notification exists |

Checks and item questions for the same task run serially. Each item belongs to one task, so its Pi session never receives concurrent writes. At most two independent tasks run concurrently. A data-directory process lock permits only one service process. Retrying marks the original run retried and links its replacement runId in the same transaction; the same failed run cannot be replayed repeatedly. If the replacement also fails, that new run can be retried manually.

Recurring checks do not continuously append to the user's main conversation. Baseline and unchanged checks create no Pi session; each new body version creates a separate item session. Subsequent questions, notification clicks, and explicit follow-ups link through database IDs, **without relying on the model to guess which item is being discussed**. At 65% of the model context window, the code calls SDK `session.compact()`; SDK automatic compaction is also enabled. Task cursors and schedules remain outside the session.

## Reading and execution boundaries

- Public HTTP/HTTPS standard ports, text and HTML only; no authenticated pages, PDFs, JavaScript-rendered pages, compressed responses, or full browser.
- Every resolved IP must be public unicast, including IPv4-mapped IPv6. Connections pin the validated IP while TLS still verifies the original hostname. Up to four redirects are revalidated at every hop; local, private, link-local, and special addresses are rejected.
- Each read allows at most 15 seconds including DNS, 512,000 response bytes, and 60,000 body characters. Exceeding a limit fails rather than establishing a baseline from truncated content. Whitespace is normalized and HTML navigation, scripts, and similar elements removed before comparison.
- Each run has a 90-second total budget, at most four model turns, and at most two model tool reads. The declared model output cap is 2,048 tokens. Source reading attempts at most twice, SDK automatic retry at most once, and provider-level retries are disabled.
- Web pages and tool results are explicitly marked as untrusted quotations. Model prompts cannot eliminate every injection risk; tool allowlists and URL restrictions enforce permissions.
- There are no external-write tools. Manual retry only rereads and analyzes; it does not publish or send messages. Before adding tools with side effects, implement persistent approval-wait state, actionId with an argument summary, explicit authorization, idempotency keys, and human reconciliation. The current read-only retry policy is insufficient for those tools.
- Every new body change creates a research item, without relevance scoring or page-section selectors; frequently changing sites may generate many notifications. Records remain local. Lists show the latest 100 runs/notifications and 300 messages; older items referenced by those records remain accessible. Archiving, deletion, and disk-retention policies are not yet provided.
- “Always-on” depends on the Node process and host remaining active; nothing executes while the process is stopped or the host sleeps. Recovery follows the rules above. Use the built-in `service` command to install system service-manager configuration; the host must still stay running with network access.

## Validation

```bash
npm run build
npm test
npm run demo
npx playwright install chromium
npm run test:ui
npm run format:check
```

Unit and integration tests cover silence on unchanged sources, body-version deduplication, duplicate events, restart schedules, interrupted states, session creation/reuse/compaction, same-task serialization and independent-task concurrency, URL-edit races, private-address rejection, API authentication, and credential redaction. Playwright covers the Chinese workspace's demo, questions, follow-ups, task creation/editing/pause/resume, model settings, and mobile layouts. Browser tests use isolated `.data/ui-test-*` directories without touching the default workspace.

[Architecture decisions and SDK version evidence](docs/architecture.md) · [Research-item conversation](docs/screenshots/research-thread.png)

[PR checks and review process](docs/ci.md)

Telegram private-chat access is available as an opt-in external Channel. See [Telegram setup, commands and delivery guarantees](docs/telegram.md).

## npm installation and releases

Packaged commands and repository scripts use different default data directories. See [npm installation and releases](docs/npm-release.md) for installation, existing-data paths, and manual publication.
