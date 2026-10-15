---
section: Changed
---

- **Create in one step (UXA-2):** the New agent and New skill dialogs that stay where no
  building agent is offered, New agent on the Agents page, Copy to edit, and the New connection
  dialog ask for the name first; the New agent dialog also asks "What should it do?", which
  becomes the agent's description. The address (the id) is made from the name under
  "Advanced" ("Erweitert"), or under "Technical details" for a Connection, and follows the name
  until it is edited. It is checked while typing: a taken address, or one the kind's rule for
  names refuses, is named at the field, the fold opens, and Continue or Connect waits. The
  Namespace choice moved under the same fold. The UI library gains `NameWithAddress`.
- **`assets.check_name`:** `POST /api/v1/assets/{kind}/check-name` with `name` and an optional
  `workspaceId` answers `{ available: true }`, or `{ available: false, reason, message }` with
  `reason` `name_invalid` (the kind's own rule, the sentence a refused put gives) or
  `name_taken` ("The <kind> id '<name>' is taken on this instance"). It writes nothing and asks
  the kind's write right on the name, as a create does. A put still refuses a bad or taken name
  as before. Rollback: the dialogs of an older UI do not call it; nothing is stored.
