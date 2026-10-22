---
section: Added
---

A Workflow's builder adds, deletes and moves steps by hand on the canvas. A "+" on every edge, on every path of a condition and at the end of a loop's body opens the palette of the step types this release runs: callable operations under "Data and systems", the AI step and scripts, the loop and "Start another workflow", and under "People" a message and, where the person may send, an e-mail. The new step opens in its Settings, unsaved, with an id made from its name that stays when it is renamed. "Delete step" and "Move" are in the step panel's "…" menu: a delete asks once and names how many steps go with a block, and a step whose result another step reads is not deleted (the dialog names the readers). A move shows "Move here" targets; a move the instance refuses saves nothing and says which step would no longer see the result it reads. Each delete and move is one revision of the draft.

`WORKFLOW_EXECUTED_STEP_TYPES` moves to `asset-schemas` and is exported by `catalyst-core` instead of `catalyst-workflows`. A refusal whose issue names its place as one dotted path keeps that place. In the UI library, `FlowInsertPoints.around` wraps a "+" in what it opens, `SidePanel` takes `actions` for its head, and a zoomed-out node leaves its change to the frame instead of squeezing its title.
