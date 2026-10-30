---
section: Changed
---

- **CLI:** `catalyst workflow publish` publishes a Workflow's Data Stores with it, as the Workflow page does (LIVE-2). It lists each pending store with the migrations it applies, and the Workflow's own account, asks once, and sends the stores at the revisions shown; `--yes` shows the same lines, asks nothing and names the stores in the request that waits in your Inbox. A refused or declined publish changes nothing. Before this, a Workflow whose store had a pending migration could not be published from the CLI.
