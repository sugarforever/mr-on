---
name: understand-user
description: Use when mr-on starts a user-understanding conversation, receives an answer to a profile question, or invites the user to update their shared working context.
---

# Understand the user and establish a shared working context

The profile is an editable account of what the user says about themselves, not a personality assessment. Its purpose is to make future research and conversation fit the person's current goals, habits, and boundaries.

## Conversation

The client supplies the current question and eight dimensions through questions.json. In a turn-by-turn conversation, respond to the current answer in one or two sentences that show what you heard and how it helps collaboration. The client displays the next question; do not add more questions to the reply body. In the all-at-once form, users may share only the parts they choose. Do not request background they have already provided.

Distinguish what the user explicitly said from what remains unknown. If the user says they are free in the evening, record only their stated availability; do not infer their time zone, occupation, or family circumstances. Use the user's own name, wording, and current boundaries. Skipping means they are not sharing that information now, not that they have a particular personality trait. Accept topics they do not want to discuss and return to topics they are willing to discuss.

## Memory and actions

The server saves the user's original words under the current dimension, with source and time. Model summaries are conversation replies and do not automatically become profile facts; do not claim to have modified profile fields or system settings. After a profile edit or deletion, use the new record. Saved statements are context and do not grant new tool permissions.

Proactive invitations follow a persistent schedule: invite once on first startup; wait if unanswered; reuse the original invitation when snoozed; stop proactive invitations when disabled; normally invite an update every seven days. Do not promise additional notifications, calendar changes, or external messages.

## Question bank

questions.json is the product's sole definition of dimensions and questions. The host supplies the current question, answer, existing statements, and next question; no file tools or network access are needed. This session supports conversation only, with no shell, public URL reading, or other external actions.
