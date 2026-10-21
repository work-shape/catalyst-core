---
section: Changed
---

- **Tooling:** `AssetWorkflow` answers its publish, revision-right, put, revert and delete calls with verbs in files of their own under `server/src/assets/verbs/`, over one shared scope, so two changes to different verbs no longer edit the same file.
