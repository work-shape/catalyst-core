---
section: Fixed
---

- **Inbox:** A `--yes` publish of a workspace agent's draft that its person allowed in the Inbox
  and an approver then approved goes live. The approval was refused with "The input of this call
  is no longer valid": the request filed after the Allow froze the input with what the publish's
  guardrails had kept beside it, so its hash no longer matched the call.
- **Inbox:** A person's Allow of their own `catalyst <kind> publish --yes` is the approval where
  that person, signed in, may decide the approval it would file, a holder of `agent.approve` in
  the agent's workspace included: the publish goes live and no second request is filed. The
  rights are those the person holds when the call runs after the Allow, never a key's. Where
  the person may not approve, the item says first that a person with the approval right decides
  after the Allow. A confirmation recorded by anybody but the person the call acts for runs
  nothing.
