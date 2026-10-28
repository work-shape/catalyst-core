---
section: Added
---

- **Sharing an asset (SHARE-1):** `assets.move` shares a skill, agent, guardrail, Workflow, Data Store, Knowledge Base or App up the ladder, from a Personal Workspace to a Shared Workspace or the instance, and from a Shared Workspace to the instance, never down or sideways. What the asset uses from its owner moves with it, and edit rights follow the new owner. Each refusal names its reason in a plain sentence. With the write right at the target the move happens at once. Without it, the move files a `<kind>_move` approval request that someone holding that right accepts or declines in the Inbox. `assets.move_check` answers the dry run: what moves, what breaks and who reads and edits it afterwards. A move that breaks something needs `acceptBreaks`. The move records `asset.moved` with ids only, in one transaction with the owner change.
