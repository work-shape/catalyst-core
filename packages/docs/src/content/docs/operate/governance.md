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

Conversation retention and audit retention may be different. Audit events should avoid raw sensitive payloads so they can safely outlive conversation content where policy requires it.

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

Admin-facing usage views should expose consumption volume and client-billed cost totals: model calls, token counts, configured non-financial safeguards, recent model usage metadata, and the already-multiplied cost that the client should expect to be charged. This includes per-day and per-calendar-month billed summaries so admins can review historical consumption for billing. They should not expose provider pricing tables, raw provider cost, monthly spend limits, or cost safety multipliers. Web-search costs should only be displayed when web search is enabled for the instance.

Record:

- provider id
- model id
- token counts when reported by the provider
- conversation id
- agent run id
- correlation id
- derived cost from release-config pricing where available

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
