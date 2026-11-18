# Telegram Channel

Telegram is the first external Channel. Native Bot API `getUpdates` long polling needs only outbound HTTPS and works with the loopback Gateway. Feishu also offers persistent connections, but its application permissions and event setup add initial configuration. No Telegram framework, public listener, webhook registration or new model execution loop is introduced.

## Enable locally

Create a bot with Telegram's BotFather. Use a dedicated token, with no other polling client or webhook. The adapter checks `getMe` and `getWebhookInfo`, refuses an existing webhook, and never deletes it. A per-bot SQLite OS lock prevents another mr-on poller under the same OS user on this host, even with a different data directory or rotated token. Telegram 409 conflicts stop the adapter and log `telegram.poller_conflict`; inspect other hosts/processes before restarting. A bot must have exactly one polling owner across hosts.

By default there is no adapter and no Telegram network traffic. Put this in `$MR_ON_DATA/telegram.json` (default `.data/telegram.json`), owned by the Gateway user with mode `0600`:

```json
{
  "enabled": true,
  "grants": [
    {
      "userId": 123456789,
      "chatId": 123456789,
      "conversations": ["profile", "research:EXISTING-ITEM-ID"]
    }
  ]
}
```

Replace IDs locally. For this version `userId` and `chatId` must be the same positive integer: an explicit private user/bot chat. Obtain your own numeric Telegram user ID through a trusted Telegram client; do not put a token into third-party ID lookup services. Existing conversation IDs are available from the local Channel (`npm run client -- list`) or `GET /api/channel/conversations`. Remove the research placeholder or replace it with a real item ID. Grants do not create research items.

Store the token in `$MR_ON_DATA/telegram-token`, mode `0600`, owned by the service user. Alternatively pass `MR_ON_TELEGRAM_TOKEN` through the Gateway process environment. Set `MR_ON_TELEGRAM_CONFIG` to an absolute path for a different private config file. Do not put a token in command arguments, URLs, source control, screenshots or browser settings. The adapter never exposes it in `/api/state` or logs; transport errors omit remote descriptions, URLs and original error causes.

Restart the Gateway after first enabling, changing the token, or recovering a stopped adapter. After startup, the config file is reread before each update and delivery and at least every worker cycle (250ms while enabled). Write replacements atomically with private permissions. Removing a grant immediately prevents new admission and new delivery after the next check. Pending output/watches for revoked scopes are discarded when observed; regranting does not restore discarded notifications. A request already accepted by Telegram cannot be recalled, and a send already in flight may complete during revocation. Missing, malformed or non-private configuration fails closed and logs `telegram.configuration_disabled`. `enabled: false` pauses polling and delivery; accepted work continues and pending results resume when reenabled. If disabled at Gateway startup, restart to activate it.

### Service environments

The private files are the simplest way to provide configuration to both interactive and managed Gateway processes. Use the same `MR_ON_DATA` and service user as the installed service. In systemd, a private `EnvironmentFile=` may supply `MR_ON_TELEGRAM_TOKEN` and `MR_ON_TELEGRAM_CONFIG`; in launchd, configure `EnvironmentVariables` in a private plist, or prefer the private token file so the token is not embedded in the plist. Shell exports alone are not inherited by an already installed service. See [Gateway service](gateway-service.md). This feature does not install, enable or modify either service manager.

## Commands

Only new text `message` updates from authorized private sender/chat pairs are accepted. Group/channel posts, edited messages, media, callback updates, bots, sender-chat messages and unlisted identities are silently ignored. They do not receive error replies or reveal conversation IDs. No inbound HTTP identity assertions are trusted.

- `/start` or `/help`: show usage.
- `/list`: list existing conversation IDs within your local grants.
- `/bind profile` or `/bind research:<itemId>`: select an existing authorized business conversation. No history is automatically sent on bind.
- `/questions`: when bound to profile, show its current dimension IDs and questions.
- `/answer goals <your answer>`: submit a profile answer (up to 4000 UTF-16 units), using a dimension from `/questions`. Only one profile job runs at a time; busy submissions are rejected and must be sent again after completion.
- Send ordinary text while bound to research: submit a research follow-up (Channel limit 8000 UTF-16 units; Telegram may impose a smaller inbound limit).
- `/status`: last five run IDs and states in the selected conversation.
- `/history`: last ten messages in that conversation; the local app/Channel retains full history. Large messages are split into ordered plain-text chunks; links do not generate previews.
- `/unbind`: clear the current selection. Already submitted results still return to their original authorized chat, labelled with conversation and run ID.

Commands are exact and case sensitive; `/command@bot` forms are unsupported. There is no unrestricted main chat, task management, settings mutation, tools authorization or automatic retry of failed model runs. Use the local app for manual retry and failure details. Profile answers use the existing profile tool restrictions; research uses the existing research session and permissions.

## Identity, persistence and delivery

The authenticated Telegram bot API supplies sender/chat IDs. The local grant binds that pair to allowed business conversations. Audit identity is `telegram:<botId>:<userId>:<chatId>`, client identity is `telegram:<botId>:<chatId>`. Neither is a Pi session ID or run ID. Selecting a conversation does not create a Pi session; Channel admission reuses the same research item session or shared profile session as Web/CLI.

SQLite stores bot-scoped update offset, selected bindings, submitted-run watches, output chunks and retry deadlines. Update offset, Channel receipt, queue entry, run watch and acceptance reply commit in one transaction (Channel uses a nested savepoint). An update replay after crash cannot admit another run. Storage errors roll back the offset and are retried. Offsets and receipts must be retained together; do not copy only part of the database or run simultaneous Gateways against it.

Completion collection watches only the runs admitted through this bot, not every event/history entry. A terminal run is converted to outbox chunks and its watch removed in one transaction. The existing Channel history and run states are the durable completion evidence, so no live subscription is needed. Disconnecting polling does not cancel work. Queued jobs survive restart; in-flight Pi jobs retain the existing `interrupted` state and require manual retry. Profile reset deletes profile watches and pending profile output through a database trigger, avoiding delivery of deleted profile history.

Polling and output delivery are independent. Sends are conservative (one per bot per 1.1 seconds, also below the per-chat default guidance); failures retry with bounded exponential backoff and Telegram's `retry_after` as a minimum. Failed output stays durable, including permanent send failures such as a blocked bot; the ordered queue pauses behind that row until permission is revoked or the bot can send again. This deliberately favors retaining results over silently dropping them. 401/409 stop the adapter, leaving the local Gateway operational. Event-only logs distinguish startup failure, configuration disablement, polling retry, delivery retry, webhook conflict (`telegram.webhook_conflict`), local poller conflict (`telegram.local_poller_conflict`) and remote poller conflict without logging external content.

**Delivery is at least once, not exactly once.** Telegram may accept `sendMessage` before the response is lost or before SQLite records success. Retrying that chunk can duplicate it; successful chunks before it are not replayed. A crash between a failed send and saving its retry deadline can also retry early. Already delivered Telegram messages remain on Telegram after local deletion/revocation. Outbox/history data has the same private local database storage boundary as other app conversations; there is no automatic retention cleanup. Telegram retains unconsumed incoming updates for at most 24 hours, so long outages can lose inputs before local admission.

## Validation and limits

Tests use an injectable transport and a local fake Telegram HTTP service, exercising real Channel admission, offline Pi SDK sessions and durable SQLite state. They cover authentication, duplicate updates, restart recovery, rollback, grant isolation/revocation, profile reset, send failure/429, long output, webhook/local poller conflicts, abort and token redaction. No real Telegram token or external model key is required. Real Telegram end-to-end delivery has not been verified in this change.

Official references: [Bot API](https://core.telegram.org/bots/api#getupdates), [sendMessage](https://core.telegram.org/bots/api#sendmessage), [response parameters](https://core.telegram.org/bots/api#responseparameters), [Bot FAQ and rate guidance](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
