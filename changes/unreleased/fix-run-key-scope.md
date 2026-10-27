---
section: Database
---

- A Workflow run key is held per starter: the person, each of their API keys, or the Service Principal that started the run; a child run holds its key for its root's starter. A start with a key another starter holds is a new run, answered exactly as a key no run holds, so a key no longer tells whether someone else uses it. A repeat by the same starter still answers its run. Migration `0160_workflow_run_keys_per_starter` replaces the run key's unique index with one per starter, built concurrently.
