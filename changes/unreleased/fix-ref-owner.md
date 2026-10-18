---
section: Fixed
---

- Enforce asset reference ownership on draft save and publish for agents, Knowledge Bases,
  Apps, Workflows and guardrails. A refusal names the reference and its workspace in English
  or German, with `invalid_scope`: "An asset may reference only assets of its own workspace
  or the instance; an instance-owned asset cannot reference workspace assets."
- Resolve new references against exactly the rights used by asset choosers: configuration
  read, or use of an active asset / a published revision. Skills and Data Stores still require read. Existing
  invalid owner pairs keep running until their source is next saved or published; no data is
  rewritten. `scripts/preflight-reference-owners.sql` reports current draft/live violations
  without changing data. Rolling back removes enforcement and leaves stored assets unchanged.
