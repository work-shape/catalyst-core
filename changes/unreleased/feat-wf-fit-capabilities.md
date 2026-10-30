---
section: Added
---

- **Workflows:** The reading operation `workflows.capabilities` (`GET /api/v1/workflow-capabilities`) lists what a Workflow can do on this instance: whether code steps run, the runner's languages and pinned packages, every ceiling and source bound with the release config key that raises it, the Connections the asker may use with the operations they expose to Workflows, and what this release does not offer. Anyone who may write some Workflow may read it; it is also an agent tool of the Workflows module (WF-FIT).
- **Docs:** The page "What a Workflow can do" (Automate). Its tables are generated from the same list with the release defaults; the platform documentation skill of an instance carries the instance's own values.
- **Workflow authoring skill:** Before the first write, the Build Agent reads `workflows.capabilities` and answers with one of four: it fits; it fits once someone switches something on (naming the switch); it belongs in another kind; or it is not a fit yet, with the reason.
