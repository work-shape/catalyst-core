---
section: Fixed
---

- Enforce asset reference ownership when saving or publishing a source and when creating its
  target. A workspace asset may name its own workspace or the instance. Refusals carry
  `invalid_scope`; forward references name both owners with English and German kind labels.
  The owner rule reads: "An asset may reference only assets of its own workspace or the instance; an instance-owned
  asset cannot reference workspace assets." Target-creation refusals disclose no source names
  or owners: "This asset cannot be created because an asset of another owner references it."
- Preserve two exceptions: instance-owned Workflows may name workspace Apps and App actions,
  Data Stores and Knowledge Bases, and link notices into workspaces; every run call still
  requires its principal's current rights. Guardrail filters govern events and consume no
  referenced asset; their separate workspace reach rule remains enforced.
- Align agent Knowledge Base and App action choosers with ownership and reference access.
  The unnamed App action catalog also accepts use of a published App; named action details
  still require read. Use-only holders see only action name, description and effect, without
  configuration or a call preview. Readers retain the full action view. Use-held Connections
  list safe summary fields, including title and connector type, while
  configuration, history and secrets remain hidden. Reference refusals also use English or German.
- Existing invalid pairs keep running; a save or publish of their source, or creation of a
  previously missing target, checks them. Editing an existing target remains allowed because
  owners never change. Unrelated edits remain possible. The read-only preflight reports draft
  and live violations with the same exceptions. No stored data is rewritten. Rolling back
  removes enforcement and leaves stored assets unchanged.
