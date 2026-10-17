---
section: Added
---

- One conversation builds what an App needs (BUILD-ALL-1). The agent may create a draft with `platform.assets.put` also while the conversation is about an asset: the draft stays beside the subject, nobody's page moves, and the conversation shows "Workflow-Entwurf „<Name>“ erstellt · Öffnen" ("Workflow draft “<name>” created · Open"), whose link opens the draft's page with the conversation in the dock. The agent keeps checking and saving the drafts its conversation created by naming their `kind` and `name` with `expectedRevision`, and `workflows.test` reaches a Workflow draft the conversation created. An asset that existed before the conversation still changes only as its subject, after an open; any other save is refused with the reason `asset_not_of_conversation`. The tool descriptions ask the agent to say what it creates first. The first create of a conversation about no asset keeps making it the subject and moving the person there.
