---
section: Added
---

The CLI working copy pulls, diffs, validates and pushes whole skill folders, including scripts and binary assets. Folder writes preserve file bytes, check skill limits before sending, and use the pulled revision; text-resource edits stay in release batches. `skill put --from` now sends every file of a skill folder. Older working-copy baselines need one pull before pushing.
