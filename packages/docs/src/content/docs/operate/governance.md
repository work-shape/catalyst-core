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
- conversation id
- agent run id
- correlation id
- persisted customer billable cost and completeness state

Use provider-side billing alerts or budgets as an external backstop.

## Admin Access

Admin and superadmin access should be explicit, permissioned, and audited.

Default views should show metadata, retention status, usage summaries, audit events, and deletion workflows.

Full message access should require:

- explicit release-config enablement
- stronger permission
- reason capture
- audit event

## Deletion

Support deletion as a product workflow, not a manual database habit.

Deletion should cover:

- one conversation
- all conversations for a user where policy allows
- related messages and tool outputs
- related document outputs and file references
- minimal retained audit records where legally or contractually required

The customer or legal owner decides the lawful basis and exact retention durations. Vivd Catalyst provides the mechanisms and evidence path.
