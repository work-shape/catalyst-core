---
section: Changed
---

- A parent's test run runs a child Workflow's draft, in mode `test`, when the person testing may write the child by their own rights (DP-4); otherwise the child's published revision, as before. A live run never runs a draft. `WorkflowDefinitionSource` gains an optional `draft(id)`.
