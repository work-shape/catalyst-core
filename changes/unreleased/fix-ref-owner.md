---
section: Fixed
---

- Enforce asset reference ownership when saving or publishing a source and when writing its
  target. A workspace asset may name its own workspace or the instance. Refusals carry
  `invalid_scope` and name both owners by workspace name, with English and German kind labels:
  "An asset may reference only assets of its own workspace or the instance; an instance-owned
  asset cannot reference workspace assets."
- Preserve two exceptions: instance-owned Workflows may name workspace Apps and App actions,
  Data Stores and Knowledge Bases, and link notices into workspaces; every run call still
  requires its principal's current rights. Guardrail filters govern events and consume no
  referenced asset; their separate workspace reach rule remains enforced.
- Align agent Knowledge Base and App action choosers with ownership and reference access.
  The unnamed App action catalog also accepts use of a published App; named action details
  still require read. Use-held Connections list safe summary fields, including title and connector type, while
  configuration, history and secrets remain hidden. Reference refusals also use English or German.
- Existing invalid pairs keep running; a save or publish of their source, or a write to their
  target, checks them. Unrelated edits remain possible. The read-only preflight reports draft
  and live violations with the same exceptions. No stored data is rewritten. Rolling back
  removes enforcement and leaves stored assets unchanged.
