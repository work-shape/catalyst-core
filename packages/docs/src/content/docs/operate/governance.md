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

- provider id, and the region of the provider entry: `eu`, `global`, or none for a provider that runs inside the instance
- model id, and the model binding the call named
- token counts when reported by the provider
- conversation id, where a conversation caused the call
- agent run id and agent name, or for a call the product made for itself what it was for: `conversation_title`, `guardrail_judge` or `document_extraction`
- the user who caused the call and the workspace it happened in, where there is one
- correlation id
- persisted customer billable cost and completeness state

Every model call leaves one record, including conversation titles and approval checks, and including a call that failed, timed out or was stopped. Titles and approval checks count toward the limits of the instance like every other call.

A record has a status:

- `pending`: the call was admitted and has not ended. The Usage page shows it as "Running".
- `settled`: the call ended with usage. The Usage page says where the amounts come from: "Reported by provider", "No usage reported" when the provider answered and reported none, or "Estimated".
- `failed`: the call failed, was stopped or timed out before any of its answer arrived. It counts as one call toward the daily call limit and uses no tokens. The Usage page shows it as "Failed".
- `abandoned`: the process that made the call went away before the call ended. The job `usage.recover_abandoned_calls` runs every 10 minutes and takes a call that is still `pending` six hours after its admission as abandoned. The Usage page shows it as "Abandoned".

A streamed call that is stopped or breaks off after its answer began has cost something, and its provider reports no usage for it. Such a call is settled with an estimate: every three characters that were sent and every three that arrived count as one token, the input counts as not cached, and a web search that had started counts as one search. Its record is marked `estimated`.

### How a call is admitted

A call is admitted against the limits in the database, in one statement on two counter rows: the day's and the month's. Several API and worker processes together admit no more than the limits allow, for calls, tokens and spend. Admission reads no usage record and no process waits for a lock per instance.

At admission a call reserves the most it can use: its input by the size of the request, 16,000 output tokens, and both at the highest price the rate card has for the model. When the call ends, the reservation is replaced by what the call used. A failed or abandoned call releases its reservation.

This has three consequences for how you set limits:

- A call is refused when its reservation no longer fits, so a token or spend limit is reached slightly before it is used up.
- A token limit at or below the 16,000 reserved output tokens would admit no call. The config is refused with a message that names the limit and the reservation.
- With a spend budget, a model without a price on the customer rate card is refused. A `deterministic` provider needs no price: it bills nothing, and its calls reserve no cost.

The limits are protective safeguards, not exact caps. A call reserves a fixed amount at admission and settles its real usage when it ends, and the request sets no maximum for the answer, so a call can use more than it reserved. The most a limit can be passed by is the sum, over the calls in flight when it is reached, of what each used minus what it reserved. The reserved output is the constant `MODEL_CALL_RESERVED_OUTPUT_TOKENS` (16,000) in `@vivd-catalyst/core`. Set a limit with that margin in mind, and keep a provider-side budget as the hard stop.

A cost that cannot be settled, such as one whose provider reported no cached tokens, counts toward a spend budget at the highest price of the model. It does not stop later calls.

The Usage page lists the caller and the provider with its region for the recent calls. Its sums are read from daily sums that are kept as each call ends. The summary of the API also answers `attributedUsage`: the last 30 days by day, model, provider, region and purpose or agent.

### What stays after a deletion

Usage records are the accounting of the instance and are kept. When an account is deleted, the user is removed from its usage records together with the conversation id, the agent run id, the operation id and the correlation id. A call that ends or is recorded after the account is gone is written without them. The amounts, the model, the provider and the agent or purpose stay. When a workspace is deleted, the workspace is removed from its usage records and the amounts stay.

### After an upgrade

Records written before provider region, purpose, user and workspace were recorded are filled by a background job, `usage.backfill_attribution`. It needs no action. Until it ends, older records show no region. A record whose provider and model are no longer in `infrastructure.models` keeps no region, because nothing says where it was processed.

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

The job `usage.reconcile` builds the daily sums of the days before the upgrade from the usage records. Until it ends, the Usage page shows no sums for those days. It takes about 3 seconds per million records and needs no action. Afterwards it runs once a day and at every start, compares the counters and the sums with the usage records from the month of its previous run on, and corrects what differs. After a rollback it therefore reads the months in which the previous release wrote. One comparison of an instance runs at a time; admission and settlement do not wait for it.

During a rolling upgrade a process of the previous release writes usage records that are in no counter and no sum. A limit can be passed by what those processes admit until the next run of `usage.reconcile`. To avoid that, stop the previous release before the new one takes calls.
