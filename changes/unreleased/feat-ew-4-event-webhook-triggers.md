---
section: Added
---

- **Workflows:** Webhook and platform event triggers (EW-4).
  - **`webhook` trigger.** An outside system posts to `POST /api/v1/workflows/:workflow/webhook`. The request's JSON body is the run's input. The Workflow's own account (LIVE-1) runs it.
    - **Secret.** Each Workflow's webhook has its own secret, kept in the Secret Store the way Connection secrets are. `workflows.rotate_webhook_secret` makes a new one, shows it once and needs `workflow.publish`. `workflows.webhook` shows only the secret's state.
    - **Signing.** A request is signed with `catalyst-webhook-timestamp`, `catalyst-webhook-nonce` and `catalyst-webhook-signature`: `v1=` followed by the hex HMAC-SHA256 of `timestamp.nonce.body`.
    - **Refusals.** A request is refused before any work if:
      - it is unsigned or the signature is wrong;
      - its timestamp is more than five minutes old;
      - its nonce was already used;
      - its body is over 256 KiB;
      - it goes over the trigger's `perMinute` (60 by default, at most 600).
    - **Audit.** A refusal is audited without the body, and so is the start.
  - **`platform_event` trigger.** Starts a run on an event from a fixed allow-list. The list holds only `knowledge_base.sync_finished`. The event carries ids, names and counts, never content, and appears at `event` on the trigger's output.
    - **Rights.** An optional `filter.knowledgeBase` needs `knowledge_base.read` for the Workflow's account at publish.
    - **Drops.** An event from a source the account cannot read is dropped and audited as `workflow.event_dropped`.
    - **Duplicates.** One event starts at most one run per Workflow.
  - **Settings page.** The Workflow's Settings page turns both triggers on. It shows the webhook's address and signing, and makes its secret.
