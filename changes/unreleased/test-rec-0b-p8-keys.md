---
section: Changed
---

- Cover records rules published while an earlier migration batch is queued or running, with a key-dropping file before the end of the batch. Assert that splitting a key swap across migrations is refused with `record_key_invalid`, and document how to replace the key inside one migration. Runtime behavior is unchanged.
