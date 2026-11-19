# Proactively understand the user

While online, mr-on maintains a shared working context as well as checking sources. The first version limits this proactive behavior to conversation invitations that users can answer, snooze, or disable.

## Online behavior

Startup checks for an existing unanswered invitation. If there is no initial profile, it creates one and delivers it through the home card, inbox, and SSE to connected clients. Invitations remain in SQLite while users are offline, so they are visible on return. The service waits for a response instead of repeating the greeting after every restart.

Users can choose “Talk tomorrow” to bring back the same invitation after 24 hours, or disable proactive invitations. Once they start answering, the next update invitation is scheduled seven days later. If unanswered then, it waits rather than prompting daily. Manual access to “About me” remains available regardless of the invitation setting.

This provides basic online behavior: check persistent schedules, process due events, present something worth responding to, save the answer, and wait for the next useful interaction. It does not perform aimless background reasoning or continuous model calls.

## Eight dimensions

| Dimension                         | Basic question                                                                  | Use in collaboration                                                     |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Name and background               | What should I call you? What are you mainly working on?                         | Avoid repeated background questions and use the appropriate name         |
| Near-term goals                   | What do you most want to advance in the next one to three months?               | Organize research around concrete goals instead of listing changes       |
| Long-term interests               | Which areas deserve sustained attention?                                        | Assess the relevance of later information                                |
| Work and decisions                | How do you explore problems, choose options, and approach disagreement?         | Adapt analysis and recommendations                                       |
| Communication preferences         | What language, length, tone, and examples do you prefer?                        | Make replies easier to use                                               |
| Daily rhythm                      | When are you available, and when do you prefer quiet?                           | Understand reminder preferences without automatically changing schedules |
| Permission and privacy boundaries | What may happen proactively, what needs a question, and what is off limits?     | Respect preferences and define collaboration boundaries                  |
| Desired help                      | What burden would you most like to reduce, and what would count as useful help? | Give later actions observable value                                      |

Definitions live in `skills/understand-user/questions.json`. The skill explains how to respond, handle unknowns and skipped answers, and distinguish host responsibilities. This is not a personality test and does not automatically assign MBTI or other personality labels.

## Two interfaces

“Chat” displays one question at a time. Answers are stored verbatim under the current dimension with time and source; the model responds in one or two sentences, and the client shows the next question. Users may skip or return to any dimension. Skipping a previously answered dimension skips this update only and retains the earlier statement. Current saved statements appear beside the conversation.

“All at once” displays the same eight questions and allows partial completion. Saving an empty field clears it; saving a filled field updates the current statement. Editing clears the old profile conversation and starts a new session so superseded information does not remain in model context. The UI explains this before saving.

Deletion requires UI confirmation. It removes profile fields, invitations, conversation records, reply jobs, and dedicated Pi session files, and disables proactive invitations. Monitoring tasks, research results, and research sessions remain; background previously quoted there is not retroactively removed. Deletion removes application records and does not promise forensic erasure of SQLite free pages or system backups.

SSE updates and polling preserve drafts and input focus. Notifications are in-app messages; the client neither requests operating-system notification permissions nor sends external messages.

## Data and execution

`profile_state` stores the enabled setting, next invitation time, and Pi session link; `profile_facts` stores user statements by dimension; `profile_invitations` stores pending invitations; `profile_messages` and `profile_jobs` store messages and reply execution respectively.

The answer API deduplicates by requestId. The same ID and answer return the original job; different content under the same ID is rejected. The profile reply queue executes one job at a time and rejects new changes while busy, preventing edits, forgetting, and session writes from conflicting. Answers are persisted before model execution. Model failure does not lose the answer; restart marks running replies interrupted and allows explicit retries. A retry may resend context to the model but does not insert another user answer.

Profile sessions use the Pi SDK's native SessionManager. `ResourceLoader` registers only the bundled skill and explicitly includes its body in the system prompt; profile mode has an empty tool allowlist. It cannot read global skills, arbitrary files, or URLs, or execute shell commands. Model text does not automatically update profile facts.

Subsequent research uses explicitly supplied goals, interests, working style, communication preferences, and desired help. These statements are context and cannot expand tool permissions. In real-model mode, profile replies and the existing profile go to the configured model service; research conversations send the selected fields above, as explained by the UI. Offline mode still saves input but produces fixed demo replies.

## Verified behavior and remaining work

Tests cover first invitations, startup deduplication, snoozing, disabling invitations, profile session reuse, requestId deduplication, edit cleanup, forgetting, concurrency protection, interrupted retries, SSE, and both client answer modes. The skill was loaded by the SDK and validated separately. A comparison with and without it showed that loading delegates the next question and verbatim storage to the host, leaving the model to respond without guessing time zones or family background.

The current implementation uses eight fixed questions and a seven-day invitation cadence. It does not yet support adaptive question planning, automatic cross-dimension fact extraction from free conversation, profile-conflict merging, time-zone-aware quiet hours, or cross-device push. Natural conversation quality with real models still requires credential-based validation.
