---
section: Fixed
---

- Preserve all schema fields when canonicalizing agent and skill config, including subagents, Knowledge Bases, false values, empty collections and skill frontmatter. Map key order does not count as an edit. Pull again before editing a working copy made by an older CLI; previously omitted fields cannot be recovered from those local files. Downgrading the CLI restores the field-loss risk.
- Check changed guardrails before applying a config push batch. An invalid definition reports `Validation failed for guardrail:<name>: <count> issues (<paths>); nothing was applied.` Separate writes still enforce rights, revisions and approvals at execution time.
- Guard availability changes with the asset id and previously read availability, and default selections with the selected asset id.
