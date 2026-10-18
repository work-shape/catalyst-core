---
section: Added
---

- **Workflows:** Workflows can continue a long loop into a new history with `continueAsNew: { position: offset }`. A successor starts on the then-published revision with the next position as input; histories keep their key, labels and failure policy and appear as one expandable run with numbered parts. Input incompatible with a republished revision records a failed successor naming the field. Dataset views and waits transfer without copying rows or double-counting work.

- **Deployment:** Deploy migrations 0116 and 0117 before starting app or workers. 0116 adds nullable continuation/checkpoint/label columns and expands the run status check; 0117 rebuilds the key and parent-step indexes concurrently. Stable v0.6.3 predates Workflows; earlier release candidates cannot read `continued`. Rollback after a continuation requires a release that understands this status and the successor relationship; do not restart an older Workflow engine against active chains.
