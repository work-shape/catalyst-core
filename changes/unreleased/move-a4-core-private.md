---
section: Changed
---

- Move the core to `work-shape/catalyst-core`: build Postgres under
  `ghcr.io/work-shape/catalyst-postgres` on Blacksmith, pin the checked image in CI and the
  demo, and update its source label. Move the docs and mirror workflow guards and mirror
  destination to Workshape; remove the registry-canary workflow.
