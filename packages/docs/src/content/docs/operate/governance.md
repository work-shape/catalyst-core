---
title: Governance
description: Run sensitive chat workflows with retention, audit, usage, and deletion controls.
---

Governance is the minimum set of controls needed to run a sensitive client instance responsibly.

It is not a broad compliance suite. It is explicit behavior for access, audit, retention, deletion, and usage visibility.

## Retention

Define retention for:

- conversations
- messages
- tool call records
- document outputs
- managed file references
- model usage events
- audit events
- backups

A Conversation is deleted `retention.conversationDays` after the last message a user sent in it. Set `retention.extendOnActivity: false` to count from its creation instead, as a fixed maximum age. In its last seven days, or the last half of a shorter period, the conversation list marks it with a clock, and the open Conversation says when it will be deleted. See [release config](/configure/release-config/#retention).

Conversation retention and audit retention may be different. Audit events should avoid raw sensitive payloads so they can safely outlive conversation content where policy requires it.

Audit retention is enforced. Once a day the API process deletes the audit events of its instance that are older than `retention.auditDays` (default 365) and records one `audit.pruned` event with the number of rows it removed. There is no switch: an instance that has to keep audit events longer sets a higher `auditDays`, up to 3650, before it upgrades.

## Audit

Audit events should record governance metadata:

- actor id
- event type
- conversation id
- message id
- tool call id
- file id
- status
- reason code where required
- correlation id
- timestamps

Audit events should not store:

- full prompts or completions
- full document text
- raw file bytes
- secrets or tokens
- unnecessary personal data

## Usage Governance

Model usage is governance metadata, not provider billing truth.

Admin-facing usage views expose consumption volume and customer billable totals: model calls, total and cached input tokens, configured non-financial safeguards, recent model usage metadata, and the persisted rate-card amount the customer should expect to be invoiced. Per-day and per-calendar-month summaries use “Billable” until an invoice is issued. They do not expose applied rates or internal pricing provenance. Web-search costs are displayed only when web search is enabled for the instance.

Record:

- provider id
- model id
- token counts when reported by the provider
- conversation id, where a conversation caused the call
- agent run id, or for a call the product made for itself what it was for: `conversation_title` or `guardrail_judge`
- correlation id
- persisted customer billable cost and completeness state

Every model call leaves one record, including conversation titles and approval checks, and including a call that failed, timed out or was stopped: such a call is recorded with zero tokens and counts toward the daily call limit. Titles and approval checks count toward the limits of the instance like every other call. A record names no user yet; usage per user comes with a later release.

Use provider-side billing alerts or budgets as an external backstop.

## Background Jobs

Settings > Instance > Jobs shows what the instance works on in the background: per job kind the
queued, running, failed and dead jobs, and below that the jobs themselves under Failed and dead,
Running and Queued. Everyone with `audit.view` can read it. A job is shown with its kind,
status, attempts, the class of its last error and the id of the record it works on. The page
and its API never show a job's payload or an error message, because either can quote a
provider or a record.

A job is `dead` when its attempts are used up, and `failed` when another attempt could not
help or when a schedule tick failed. A superadmin can retry a failed or dead job. The retry
queues the job again and puts the record it works on back into the state the job starts from,
so a preview that failed is rendered again and a draft attachment that failed is preprocessed
again. There is no retry for a schedule tick, since the next tick does its work, none for a
workspace command, since a command is never run a second time, and none for a kind whose
capability names no way to retry it. Every retry is written to the audit log as
`job.retried`.

## Admin Access

Admin and superadmin access should be explicit, permissioned, and audited.

Default views should show metadata, retention status, usage summaries, audit events, and deletion workflows.

Full message access should require:

- explicit release-config enablement
- stronger permission
- reason capture
- audit event

## Inbox

The Inbox is where a person finds what waits for a decision. It is a section of the sidebar, below Chat, at `/inbox`. The older address `/approvals` leads there.

The sidebar shows the Inbox to a person who may decide a kind of Approval Request, and to a person who has made a request. The number beside it counts the pending requests that person can decide. It does not count unread items.

The Inbox has three lists:

- **To decide**: the pending requests the person can decide, oldest first.
- **My requests**: the requests the person made, in every state, with who decided and the comment.
- **Decided**: the requests of the kinds the person may decide that were decided in the last 30 days. An accepted change is undone from here.

To decide and Decided need a right to decide, such as `agent_skills.approve` for skill changes. A person without one sees their own requests as a single list. Every signed-in person can read their own requests through `approval_requests.list_mine`; `approval_requests.list` stays with the people who may decide.

Opening a row shows the request beside the list at `/inbox/<id>`. A decision is made there or on the card in the conversation; both read and change the same Approval Request. Who may decide is answered by the server for each request.

The lists and the open request ask for their state every 60 seconds. When two people decide the same request, the first decision stands. The second person is told who decided, and a comment they had written stays on the page.

## Deletion

Support deletion as a product workflow, not a manual database habit.

Deletion should cover:

- one conversation
- all conversations for a user where policy allows
- related messages and tool outputs
- related document outputs and file references
- minimal retained audit records where legally or contractually required

The customer or legal owner decides the lawful basis and exact retention durations. Workshape Catalyst provides the mechanisms and evidence path.
