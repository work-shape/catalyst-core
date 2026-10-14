---
section: Added
---

- **Workflows:** Test run of a Workflow's draft, from Test run in the canvas's draft bar or
  `workflows.test` (`POST /api/v1/workflows/:workflow/test-runs`). It needs `workflow.write`, not
  `api_access.manage`, and only a person starts one. A test run acts as the person who starts it,
  bounded by the Workflow's service principal: a step runs only where both hold its right, and a
  refusal names the side that lacks it ("The principal '…' does not hold … publishing would fail
  at this step", or `tester_missing_right`, "You do not hold …"). Reading steps read live; a
  changing step is simulated and says in sentences what it would have done. Every step run shows
  where its call went: Live, Test or Simulated. A disabled principal is refused with
  `run_as_disabled`.
- **Workflows:** "Run live once" on a changing step belongs to the person who sets it and makes
  that step live for the whole of their next test run: every item of a loop, every retry. Another
  tester's run stays simulated. `assets.list_live_once` (`GET /api/v1/assets/:kind/:name/run-live-once`)
  answers the caller's own switches and the test run that used each, so the run page shows them
  after a reload. The audit events `live_once.switched_on` and `live_once.used` name the switch's
  owner.
- **Workflows:** A step whose `confirm` the tester's own start satisfied says "A published run asks
  for approval here", because a published run has nobody present to confirm. A changing step that
  the policy holds for an approval is refused in a test run, which cannot wait for one yet.
