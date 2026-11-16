---
section: Fixed
---

- **Config CLI:** `catalyst agent show <name> --revision published` and `--revision <n>` no
  longer refuse with "has no published revision": an agent's live revision is the one it
  publishes, so `published` answers it and a number answers that revision of its history, as
  for a skill. `--revision draft` answers the agent's pending draft to whoever may read it, and
  the live revision where there is none.
