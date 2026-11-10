---
section: Fixed
---

- **Inbox:** A `--yes` publish of a workspace agent's draft that its person allowed in the Inbox
  and an approver then approved goes live. The approval was refused with "The input of this call
  is no longer valid": the request filed after the Allow froze the input with what the publish's
  guardrails had kept beside it, so its hash no longer matched the call.
