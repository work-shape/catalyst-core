---
section: Added
---

- Workflow dataset producers, streaming storage, dataset loops and child contracts, with access checks and retention.

- Refuse foreign dataset references in free-form Workflow outputs and operation dataset replays; a child hands its parent only datasets it can read. Changed pending retries fail with `dataset_retry_changed`. Dataset cleanup removes reader holds and empty per-run byte counters.
