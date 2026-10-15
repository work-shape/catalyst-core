---
section: Changed
---

- **Create in one step (UXA-2):** the New agent and New skill dialogs that stay where no
  building agent is offered, New agent on the Agents page, Copy to edit, and the New connection
  dialog ask for the name first; the New agent dialog also asks "What should it do?", which
  becomes the agent's description. The address (the id) is made from the name under
  "Advanced" ("Erweitert"), or under "Technical details" for a Connection, and follows the name
  until it is edited. It is checked while typing: a taken address, or one the kind's rule for
  names refuses, is named at the field, the fold opens, and Continue or Connect stays off
  until it is fixed. The Namespace choice moved under the same fold. The UI library gains `NameWithAddress`.
- **`assets.check_name`:** `POST /api/v1/assets/{kind}/check-name` with `name` and an optional
  `workspaceId` answers `{ available: true }`, or `{ available: false, reason, message }` with
  `reason` `name_invalid` (creation's shared name validation and its reason, including the
  agent schema's refusal of `.` and `..`) or `name_taken` (the generic revision-conflict
  sentence a non-reader's create gives). It writes nothing and requires the kind's write
  right on the requested name; without it the caller gets 403. A fresh create names
  `expectedRevision: null`: both active and deleted assets reserve their names. The check
  reveals only the submitted kind and name, with no title, owner, workspace, revision or
  deleted state. Reusing a deleted name still requires its deletion revision. A put is
  unchanged. Rollback: the dialogs of an older UI do not call it; nothing is stored.
