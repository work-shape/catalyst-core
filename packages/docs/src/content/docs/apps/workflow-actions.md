---
title: Actions that start a Workflow
description: How an App starts a run of a published Workflow with a workflow action file, and how its code follows the run.
---

Part of [Build an App](/apps/build/). What every action shares, its input, drafts and publishing: [App actions](/apps/actions/).

## A `workflow` action

```yaml
workflow: monthly-check
description: Checks the bookings of one client.
input:
  schema:
    type: object
    properties:
      client: { type: string }
    required: [client]
  mapping:
    client: "{{client}}"
```

`workflow` is the Workflow's name. The mapping makes the input the Workflow declares. The call starts a run of the Workflow's published revision as the viewer, who needs the right to use that Workflow. The answer's `result` is the Workflow Run; follow it with `useWorkflowRun(result.id)` from the kit, or `workflowRuns.get(result.id)` in a plain HTML App. A `workflow` action has no `effect` key and no `connection`; it needs kit `1.3.0` or later.
