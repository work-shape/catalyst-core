---
section: Changed
---

- **Workflows (WF-AUTO-1):** a run of a published Workflow revision performs its changing
  operations. Where the policy of an operation is `confirm`, a step of a run from a schedule,
  or of a manual or parent start of what is published, runs the call: publishing the Workflow
  was the confirmation. Before, that `confirm` became an approval nobody could give, so every
  `data_store.<id>.insert` of a published run failed under the instance's default policy. The
  call's Operation Run records the decision reason `workflow_publish` ("Approved by publishing
  the Workflow" on its detail), and its `operation.completed` audit row carries
  `decisionReason: "workflow_publish"`. A `deny`, an `approval`, a floor of the operation, a
  guardrail and the grants of the Workflow's service principal still stop the call. A test run
  of a draft acts as its tester, as before, and an agent's call still asks its person.
- **Workflows:** a step refused because a guardrail asks for an approval names the guardrail:
  "The guardrail '…' asks for another person's approval of '…'", with `details.guardrailId`
  beside `details.reason: approval_unavailable`.
- **Workflows:** a test run no longer marks a step "A published run asks for approval here" for
  a plain `confirm`, since a published run now runs it; the mark stays where the operation's
  floor asks for a confirmation.
