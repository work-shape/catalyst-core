---
section: Fixed
---

- **Workspace > Members:** a member who already holds every right of Builder or Publisher in the
  workspace, through an instance role, a group or a grant, is shown with the switch on and
  "already covered by" the role that gives it, and is offered no request. A request for such a
  bundle is refused with `CONFLICT` (`already_held`) instead of reaching an instance admin's
  Inbox.
