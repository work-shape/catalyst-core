---
section: Added
---

- **Guardrails (GR-PUB-1): publishing needs an instance admin's approval.** Every instance
  carries the shipped guardrail "Publishing needs an instance admin's approval"
  (`publishing-needs-approval`) on `app.before_publish` and `workflow.before_publish`, with no
  check and the outcome `require_approval`, on by default, existing instances included. It is
  not part of the release floor: a holder of `guardrail.publish` at instance scope switches it
  off and on again on Build > Guardrails (`guardrails.list_shipped`,
  `guardrails.switch_shipped`); each switch is the audit event `guardrail.shipped_switched`,
  and a release never switches it back on.
- **New rights `app.approve` and `workflow.approve`,** held by the `admin` role. A holder's own
  Publish of an App or a Workflow satisfies a guardrail's `require_approval` on its publish:
  the revision is live at once, and its Operation Run records the caller as publisher and
  approver with the decision reason `approved_by_caller` ("Approved by the caller's own
  click"); `operation.completed` carries `decisionReason: "approved_by_caller"`.
- **Everyone else's publish waits** as an Approval Request of the kind `app_publish` or
  `workflow_publish`, answered `202 pending_approval`. Only holders of `app.approve` or
  `workflow.approve` see and decide it; the Inbox item shows the version, the live version it
  replaces, the files that differ, the changing actions or steps that are new or changed, the
  outside hosts it adds, the Connections, the Data Stores with their level and the account a
  Workflow runs as. A publish is checked against its caller's rights (RIGHTS-1a's rule over
  the principal a Workflow runs as) when it is filed, so a request that could never apply is
  not filed, and again when the approval applies it. Approving publishes exactly the frozen
  revision, as the requester. A
  request whose draft or live revision moved can no longer be approved: it ends `superseded`
  and its run is refused with `POLICY_DENIED`, `details.reason: approval_stale`. A newer
  request for the same asset replaces the open one.
- **`catalyst app publish` and `catalyst workflow publish` ask first** in the terminal; an
  answer other than yes publishes nothing. `--yes`, and a run without a terminal to ask, are
  refused with the reason ("needs your answer here or your click in the interface") until a
  publish can wait as a confirmation in the person's Inbox (OP-4). A held publish ends with
  exit code 3 and names the request id.
- **A publish of an App or a Workflow from an agent or an MCP client is refused** with the
  reason (`FORBIDDEN`, `reason: user_only`), until OP-3 and OP-4 let it wait for its person.
- `platform.context.get` names the `approve` right of a kind that has one.
