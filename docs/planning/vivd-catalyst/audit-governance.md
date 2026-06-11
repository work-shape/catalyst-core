# Audit And Governance

Governance is the small set of product controls needed to operate a sensitive client instance responsibly. In v1, that means permissions for sensitive actions, retention/deletion workflows, and a minimized audit event trail.

Audit is a product layer, not just application logging. It records security- and governance-relevant events so the client instance can explain what happened without retaining more sensitive content than necessary.

## What Governance Means Here

Governance does not mean a broad compliance suite in v1. It means the product has explicit behavior for:

- who can access normal chat, control-plane routes, and sensitive admin actions
- which data a normal user can see, delete, or request for deletion
- which metadata an admin/superadmin can inspect
- which actions require a stronger role, explicit reason, and audit event
- how retention policies delete conversations, messages, files, tool outputs, and derived document outputs
- how the instance can prove that a deletion, config change, or sensitive admin action happened

The v1 control plane should stay narrow: config visibility, retention status, audit event views, and deletion workflows. It should not become a full legal case-management system, SIEM, DSR portal, or enterprise admin suite.

## Why Audit Exists

Audit supports:

- accountability and compliance evidence
- security investigation
- data deletion and retention proof
- admin/superadmin governance actions
- tool execution traceability
- operational debugging without exposing full conversation content by default

GDPR does not say "this product must have an audit table" in those words. But GDPR Article 5 includes accountability, storage limitation, data minimization, and integrity/confidentiality principles; Article 30 requires records of processing activities in relevant cases; and Article 32 requires appropriate technical and organisational security measures for the risk. For sensitive AI workflows, an audit layer is a practical technical and organisational measure.

Sources:

- https://gdpr-info.eu/art-5-gdpr/
- https://gdpr-info.eu/art-30-gdpr/
- https://gdpr-text.com/read/article-32/

This is not legal advice. The customer/legal owner still needs to decide lawful basis, exact retention duration, data-subject request handling, and contractual processor obligations.

## What To Audit In V1

V1 should audit:

- auth events: successful/failed token exchange, dev auth use, role resolution
- conversation events: created, title-generated, title-generation-failed, renamed, deleted, retention-expired
- message events: message created and model response completed, without storing full text in the audit event
- tool events: tool requested, allowed/denied, started, completed, failed, timeout/cancelled
- document events: uploaded/acquired, converted, extracted, deleted
- governance events: admin/superadmin read/export/delete actions
- config events: config version activated, validation failed, retention policy changed
- deployment events where available: release deployed, migration run, health check result

## What To Build In V1

The implementation target should be small and concrete:

- product-owned `AuditEvent` schema and `AuditRecorder` interface
- Postgres-backed audit event storage
- audit writes at auth, conversation, tool, document, config, deletion, and admin-action boundaries
- audit writes for tool authorization checks, including denials and approval-required decisions
- correlation ids that connect API requests, model calls, tool calls, and audit events
- control-plane screens for audit event search/filtering, retention status, and deletion actions
- superadmin usage screen led by budgeted model cost summaries, with model-call counts, provider-reported token usage, configured pricing, spend budget, late safeguards, and recent usage events as supporting context
- a governance action layer that centralizes permission checks and read-audit events for admin/superadmin routes
- reason-required flow for sensitive admin/superadmin actions
- integration tests that prove sensitive actions create audit events

Do not build these in v1 unless a customer requirement forces them:

- immutable ledger or tamper-evident log storage
- external SIEM export
- legal request/case workflow
- full data processing register editor
- broad admin dashboard unrelated to chat operations
- default full-message inspection for admins

## What Not To Audit By Default

Audit events should avoid full sensitive payloads:

- no full payslip text
- no full prompt or completion text
- no raw file bytes
- no long-lived tokens or secrets
- no unnecessary personal data
- no prompt or completion payloads in usage events

Instead, audit records should use references and metadata:

- conversation id
- message id
- tool call id
- file id
- actor id
- role/permission used
- event type
- status/result
- timestamps
- request/correlation id
- reason code where applicable
- provider id, model id, and token counts for model usage events

## Usage Governance

Model usage is governance metadata. V1 should record one Model Usage Event per model provider call. The event should include:

- provider id
- model id
- input, output, and total token counts when the provider reports them
- source marker such as `provider_reported` or `not_reported`
- conversation id
- agent run id
- correlation id

Automatic conversation title generation is also a model provider call. It should be counted by usage governance, use a minimized prompt bounded to the first user/assistant exchange, and write only minimized audit metadata such as provider id, model id, correlation id, title lengths, and success/failure status. It must not store the prompt, completion, or generated title text in the audit event.

Provider-reported token usage is the source of truth where available. OpenAI-compatible chat responses expose prompt, completion, and total token usage for non-streaming calls. Other providers may omit usage; in that case the platform should record the call with `not_reported` instead of inventing billing-grade numbers.

Cost summaries are derived governance metadata, not provider billing records. They should use provider-reported input/output token counts plus explicit release-config pricing for the matching provider/model. If pricing is missing, the usage view should show the call as unpriced instead of inventing a cost.

The spend budget is the primary release-config governance control. It is enforced against budgeted cost, which is the local provider-cost estimate after applying the configured safety multiplier. It is still not an exact provider invoice; production deployments should also use provider-side project budgets or billing alerts as the external backstop.

Usage safeguards are late-catching release-config policies, not provider rate limits. Provider rate limits still apply separately and may be lower or higher than the client instance's configured governance safeguards.

Usage Governance should own spend-budget checks, safeguard checks, and summaries. In v1 it should serialize model-call accounting per client instance inside the running process so daily call safeguards cannot be raced by concurrent local agent runs. Multi-process or horizontally scaled deployments should deepen the Postgres adapter with atomic reservation semantics before relying on strict safeguards across processes.

Viewing usage summaries is itself a governance action. The superadmin usage route should verify the superadmin role and write a minimized `governance.usage_viewed` audit event before returning usage metadata.

Viewing audit events is also a governance action. The audit-events route should verify an admin/superadmin role and write a minimized `governance.audit_events_viewed` audit event before returning audit metadata.

## Audit Retention

Audit retention should be configured separately from conversation retention. Some minimal audit metadata may need to live longer than conversation content to prove deletion, investigate incidents, or satisfy contractual requirements.

Audit retention still falls under data minimization. Do not keep sensitive content in audit logs to avoid deleting it elsewhere.

## Admin Access

V1 should default admin/superadmin views to metadata, deletion, and export/request-handling tools. Full conversation message access should require an explicit client-instance config flag, a permission check, and a recorded audit event with reason.

Recommended v1 default: admins can inspect metadata and operational state; superadmins can perform deletion/export/governance actions; neither role gets invisible full-message browsing by default.
