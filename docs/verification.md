# Prototype verification record

Verification date: 2026-11-17. Environment: macOS arm64, Node 26.8.1, Pi Coding Agent 1.5.2. The SDK package requires Node >=22.19.0; the project and README use this minimum.

## Executed checks

| Check                  | Result                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `npm run build`        | TypeScript compilation succeeded                                                    |
| `npm test`             | 25 unit and integration tests passed                                                |
| `npm run demo`         | Offline end-to-end demo passed using the real Pi SDK and a fixed provider fixture   |
| `npm run test:ui`      | Three Chromium tests passed, including full desktop flows and a 390px narrow layout |
| `npm run format:check` | Passed                                                                              |
| `npm audit --omit=dev` | No known vulnerabilities found                                                      |
| `git diff --check`     | Passed                                                                              |
| Public URL smoke check | `readPublicUrl('https://example.com')` successfully read and normalized the body    |

The browser run reported an unrelated warning that both NO_COLOR and FORCE_COLOR were set; there were no browser page-script errors. UI screenshots are in `docs/screenshots/`; the overview and research follow-up screens were visually inspected.

## Actual process restart demo

In addition to SQLite reopen integration tests, the default workspace underwent a real service stop and restart:

1. Create a demo task, establish its baseline, and update the source to generate one item and notification.
2. Send a follow-up question, confirm the same Pi sessionId, and produce two business messages.
3. Schedule a follow-up due in four seconds and send SIGTERM to the Node service before it is due.
4. Wait 4.5 seconds, then run `npm start` again.
5. Confirm through the API that the schedule is `done`, execution still uses the original item's Pi sessionId, and totals are two notifications and three business messages.

At the time of this verification, the default workspace retained these offline demo records and the local service ran on port 4317. No real model credentials were configured and no external notifications were sent.

## Independent code review

An independent code review and a follow-up review after fixes were completed. Review identified and fixed:

- A failed run could be retried repeatedly. Replacement enqueueing and marking the original `retried` now commit in one transaction, retaining `retryRunId` and rejecting duplicate requests.
- Independently truncating item lists removed details for new notifications about old items. Items referenced by returned records are now retained, with a regression test covering more than 100 items.

The follow-up review reported no remaining blockers.

## Unverified boundaries

No real API key was used to test an external model; provider-specific tool compatibility, real analysis quality, and billing were not verified. Public deployment, multiple users, distributed execution, and external side effects were not tested because the prototype does not provide them. Normal process restarts and SQLite transaction tests do not establish recovery from power loss, disk corruption, or exact tool execution checkpoints.

## Proactive user-understanding extension

Added startup profile invitations, turn-by-turn replies, an all-at-once form, editing, deletion, a seven-day update cadence, SSE notifications, busy protection, and interrupted-reply retry. Review findings involving bulk Chinese-text body limits and inconsistent memory when skipping an answered dimension were fixed with regression coverage; follow-up review reported no remaining significant blockers.

The understand-user skill passed explicit SDK loading, quick_validate.py format validation, and an independent agent's before/after behavior comparison. Once loaded, it followed the product contract: brief responses only, with verbatim persistence and next-question selection delegated to the host, and no inference about unknown background. Natural conversation quality with a real online model was not verified.

Browser coverage includes entering from the startup invitation, turn-by-turn answers, draft preservation, skipping, all-at-once answers, profile persistence after reload, the invitation setting, and confirmed deletion. Screenshots: `docs/screenshots/profile.png` and `profile-chat.png`.
