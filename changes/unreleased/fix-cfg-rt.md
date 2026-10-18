---
section: Fixed
---

- Preserve all authored schema fields when canonicalizing agent and skill config, including subagents, Knowledge Bases, false values, empty collections and skill frontmatter. Map key order and server-carried skill metadata (`files`, `icon`, `origin`) do not count as edits. Removing all extra skill frontmatter sends an empty map to clear it. Each asset baseline records its canonical-form version. Push refuses older baselines before any write, including unchanged files: `<kind>:<name>: baseline uses an older canonical form. Run 'catalyst config pull' first, then push again.` Preserve local edits before pulling: pull refetches older baselines even at the same revision, restoring previously omitted fields from the instance. A scoped pull upgrades only its selected assets. Downgrading the CLI restores the field-loss risk.
- Check changed guardrails before applying a config push batch. An invalid definition reports `Validation failed for guardrail:<name>: <count> issue(s) (<paths>); nothing was applied.` Separate writes still enforce rights, revisions and approvals at execution time.
- Guard availability changes with the asset id and previously read availability, and default selections with the selected asset id.
