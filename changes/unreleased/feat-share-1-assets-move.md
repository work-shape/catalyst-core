---
section: Added
---

- **Sharing an asset (SHARE-1):** `assets.move` shares a skill, agent, guardrail, Workflow, Data Store, Knowledge Base or App up the ladder, from a Personal Workspace to a Shared Workspace or the instance, and from a Shared Workspace to the instance, never down or sideways.
  - **Who may move it:** only the owner of a Personal Workspace moves what lies in it. From a team, the person must be allowed to change everything that goes along.
  - **What moves:** what the asset uses from its owner moves with it.
  - **Edit rights:** they follow the new place. The move drops grants to change the moved assets, and drops read or use grants that reach beyond the new place's readers. It also drops what a moved Workflow's run account held at the old place.
  - **Refusals:** each one names its reason in a plain sentence.
  - **Direct or by request:** with the write right at the target, the move happens at once. Without it, the move files a `<kind>_move` approval request. Someone who holds that right accepts or declines it in the Inbox. When the request is decided, the requester is checked again: they must still be active, a member of the target team and the owner of the Personal Workspace.
  - **Dry run:** `assets.move_check` answers what moves, what breaks, which grants go, whose data goes along, and who reads and edits it afterwards.
  - **Audit:** the move records `asset.moved` with ids only, in one transaction with the owner change, or with the decision of the request.
