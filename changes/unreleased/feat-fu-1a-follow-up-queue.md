---
section: Database
---

- **Conversations:** Add the server follow-up queue with migrations `0089_follow_up_queue` and `0090_follow_up_attachment_index`: `conversations.runs.start` accepts `followUp: "queue"` and returns a queued follow-up when a conversation is busy. Pending messages retain the author's agent, model and effort, claim their attachments, appear in the thread snapshot and emit `follow_up_changed`. Successful completion dispatches one pending message with the author's current access; failure or Stop pauses the queue. Authors can withdraw pending messages or resume an idle queue through `conversations.follow_ups.dispatch`.

- **Compatibility:** Callers that omit `followUp` still receive `CONFLICT` with `Conversation already has an active agent run`. Withdrawing another author's message is refused with `Only the author may withdraw this follow-up`; Send now by another author is refused with `Only the author may send this follow-up now`. Withdrawing an item that already ran is refused with `Follow-up was already dispatched`. The two unaudited queue controls are explicitly named in the operation inventory; its legacy baseline is unchanged.

- **Deployment:** Apply both migrations before starting API and worker processes. The attachment column is nullable and the migration keeps the previous release compatible. Rollback leaves pending messages stored but undispatched; the previous release does not understand their attachment claims, so drain or withdraw the queue before rolling back. No queued text or attachment content enters audit; `message.created` records `delivery: "queued"` only at dispatch.

- **Authorization:** Queue rows retain the accepting run's principal, delegation and credential scopes as server-only metadata. Dispatch rechecks the author's current conversation and workspace access and preserves those scope bounds. This metadata contains no token material, follows conversation deletion/retention, never enters observations or audit, and introduces no provider or region route beyond the existing selected model gateway.
