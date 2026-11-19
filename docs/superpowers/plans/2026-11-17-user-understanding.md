# Proactive user understanding implementation plan

## Product decisions

The first proactive always-on behavior invites the user to establish a shared working context. Startup creates a persistent, actionable in-app invitation; unanswered invitations wait rather than repeating on each startup. Users can snooze, disable proactive conversation, or continue manually. After a round, invite an update every seven days; proactive invitations can be disabled.

The eight dimensions cover name/background, goals, interests, work/decisions, communication, rhythm, boundaries, and desired help. Questions and labels have a single definition in the product skill's questions.json; SKILL.md provides conversation strategy. The product loads only this trusted skill, and profile sessions have no URL, file, or shell tools.

The conversation page shows the current question, answer history, and pending-response state. Answers are stored under the current dimension as user statements. The model responds and clarifies without automatically treating inferences as facts. The all-at-once form uses the same dimensions. Individual entries can be edited or cleared; deleting the whole profile also clears its Pi history. Each reply has a persistent requestId for deduplication. Busy sessions reject concurrent writes; restart marks interrupted replies and allows explicit retries.

## File boundaries

- skills/understand-user/SKILL.md + questions.json: trusted skill and question bank.
- src/profile.ts: SQLite profile, conversation messages, proactive invitations, reply queue, cadence, and recovery.
- src/agent.ts: explicit skill loading; no tools in profile mode; user statements provide relevance context for subsequent research.
- src/server.ts: startup/tick invitations, SSE change notifications, profile API, and shutdown cleanup.
- public/profile.js + index/app/style: profile page, conversation/form switch, inbox invitation routing, and SSE refresh while preserving in-progress input.
- tests/profile.test.ts + UI: startup deduplication, snooze/disable/update cadence, session reuse, request deduplication, clearing, restart, and existing-monitoring regression coverage.

## Validation steps

- [x] Write and observe failing profile and skill-loading tests first.
- [x] Implement persistent profiles, invitations, and controlled Pi sessions.
- [x] Implement API/SSE and both UIs; run integration and browser checks.
- [x] Obtain independent review, fix significant issues, and record guarantees and limitations.

Implement directly in the original conversation without another design-approval step. The existing version was committed separately; deliver the feature as an independent change.
