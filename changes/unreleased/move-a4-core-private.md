---
section: Changed
---

- Prepare the core transfer to `work-shape/catalyst-core`: build Postgres under
  `ghcr.io/work-shape/catalyst-postgres` on Blacksmith, update the image source and demo
  references, and move the docs and mirror workflow guards and mirror destination to
  Workshape. Remove the registry-canary workflow before the transfer.
- **A4 follow-up:** `docker/postgres/pinned-image` deliberately keeps the existing image.
  After the transferred repository builds Postgres, pin the reported digest there and in
  both demo Compose files. The Postgres pin test requires the new registry and matching
  pins, so it stays red until that follow-up is committed. The new-owner guard skips the
  Postgres job on preparation pushes to the old repository.
