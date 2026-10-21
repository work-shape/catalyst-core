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

## The run's output

A run that ended `done` carries the Workflow's result as `output`. When that result, as JSON, is larger than the platform hands an App, the run comes with `outputTruncated: true` and without `output`. Check `outputTruncated` before reading `output`, and when it is set, show a clear message: the run finished, its result is too large to show here, and it is on the run's page, under **Workflows**, the Workflow, **Runs** ("Läufe"), with the run's `id`. Never show a generic error for it. The App's frame opens no other page, so a link inside the App does not work: name the place instead. Where an App must show a large result, let the Workflow write it into a Data Store and read it with an [`sql` action](/apps/data-store-actions/).

## Let the Workflow answer in fields

An App shows a Workflow's answer best when it gets fields, not prose. Where an `agent` step makes the result, its `outputSchema` names each thing the App shows, such as priorities, decisions, changes and sources, and the App lays them out itself: a list, a badge for a level, a link per source.

```yaml
outputSchema:
  type: object
  properties:
    priorities:
      type: array
      description: At most five, the most urgent first.
      items:
        type: object
        properties:
          title: { type: string }
          level: { type: string, enum: [high, medium, low] }
        required: [title, level]
        additionalProperties: false
    decisions: { type: array, items: { type: string } }
    sources:
      type: array
      items:
        type: object
        properties:
          title: { type: string }
          url: { type: string, description: "The full address of the source." }
        required: [title]
  required: [priorities, decisions, sources]
  additionalProperties: false
```

An agent step's `outputSchema` takes only `type`, `properties`, `required`, `items`, `enum`, `additionalProperties`, `description`, `title` and `$schema`. `minItems`, `maxItems`, `minLength`, `format`, `pattern`, `anyOf`, `oneOf`, `const`, `default` and `$ref` are refused when the Workflow is saved: say a bound or a format in `description` instead. The skill `workflow-authoring` has the whole Workflow.

```tsx
import { useWorkflowRun } from "@work-shape/catalyst-app-kit";

function Briefing({ runId }: { runId: string }) {
  const { run } = useWorkflowRun(runId);
  if (!run || run.status !== "done") return <p>{run ? `Status: ${run.status}` : "Starting…"}</p>;
  if (run.outputTruncated) {
    return (
      <p role="status">
        The briefing is ready but too large to show here. Open Workflows, the Workflow, Runs, and
        the run {run.id}.
      </p>
    );
  }
  const output = run.output as { priorities?: { title: string; level: string }[] } | undefined;
  return (
    <ul>
      {(output?.priorities ?? []).map((priority) => (
        <li key={priority.title}>
          {priority.level}: {priority.title}
        </li>
      ))}
    </ul>
  );
}
```
