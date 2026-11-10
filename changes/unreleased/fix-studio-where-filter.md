---
section: Fixed
---

- **Studio:** Every list of a kind a workspace can own (Agents, Skills, Guardrails, and the other
  kinds with "Where") starts on "Everywhere": what each owner offered to the reader holds, each
  row with its owner. "Where" narrows it to one owner and names the instance's own "For everyone"
  ("Für alle"), so no one reads it as every owner. Before, the list opened on the instance's
  assets alone under "Everyone", and an asset a workspace owned seemed missing.
- **API:** `assets.list` takes `owners`, `instance` and workspace ids separated by commas, in
  place of `workspaceId`: one page across those owners, each asset listed by the same right as
  in its owner's own list.
