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
- **Inbox:** When a revision of an App, a Workflow, a form page or a workspace agent goes live,
  by any path, every pending request to publish an earlier or the same revision of it is settled
  at once: the person's confirmation of a CLI publish and the approvers' publish item alike. It
  leaves "Zu entscheiden" with the reason, "Version N ist bereits live" or "Eine neuere Version
  ist live gegangen", and stays readable under "Entschieden" and "Meine Anfragen". Before, it
  stayed open with a working "Erlauben" that could only end in a conflict.
- **CLI:** `catalyst agent publish` of the live revision of an agent with no draft answers
  "already live. Nothing to do" and exits 0; the API answers `CONFLICT` with
  `reason: already_live`. No confirmation and no request is filed. A publish of a draft is never
  this answer. The line of a publish that waits, and `catalyst requests` for a superseded
  request, say that a superseded request can do nothing.
- **Inbox:** A request filed by a person who holds the right to decide it, such as a skill
  change by a holder of `skill.approve` or a workspace approver's own agent publish, is in
  "Zu entscheiden" and its count for that person alone. The other holders of the right get no
  entry and no badge, and still decide it: "Auch Anfragen zeigen, die andere selbst freigeben
  können" in "Zu entscheiden" lists them (`approval_requests.list` with `scope=others_own`;
  `count_pending` gives `othersOwn`). Who may decide is unchanged.
