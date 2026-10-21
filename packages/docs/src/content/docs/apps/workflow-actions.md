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

`workflow` is the Workflow's name. The mapping makes the input the Workflow declares. The call starts a run of the Workflow's published revision as the viewer. The viewer needs only the right to use the App: publishing the App needs the right to use the Workflow, and the person who publishes answers for it. The answer's `result` is the Workflow Run; follow it with `useWorkflowRun(result.id)` from the kit, or `workflowRuns.get(result.id)` in a plain HTML App. In the App's draft it starts a [test run](#in-the-apps-draft) instead. A `workflow` action has no `effect` key and no `connection`; it needs kit `1.3.0` or later.

## In the App's draft

In the App's draft a `workflow` action is not simulated: it starts a test run of the Workflow, so the App and the Workflow are tried together before either is published. A person who may write the Workflow gets a test run of its draft; one who may only use it gets a test run of its published revision. Either way the run's reading, model and code steps are real and its changing steps are simulated or go to a test target, and nothing of it is live. A Workflow that was never published answers a person who may not write it `workflow_unavailable`. "Run live once" is not offered on a `workflow` action: the switches belong to the Workflow's steps.

An agent tries the same click with `apps.try_action` on the draft of the App its conversation is about or created. The answer names the test run (`workflowRun`, with its `runId` and the revision that runs); the agent follows it with `workflows.get_run` and `workflows.list_step_runs` and says what each step did. Nobody publishes anything in order to try it.

## Publishing the App and its Workflow

The App's Publish publishes the Workflow drafts it reaches with it: those its `workflow` actions name and their child Workflows, where a draft has changes its published revision does not. The Publish question lists them under **Published with it** ("Wird zusammen veröffentlicht"), each new or changed, with who changed it last and how its last test run ended. One click publishes them first, children before the Workflows that start them, and then the App, in one step: a missing right, a check or a guardrail on any of them publishes none. Where the publish waits for an approver, it is one item in the Inbox that names every Workflow, and approving it publishes them all. Publishing needs the right to publish each Workflow as well as the App. Through the API, `assets.publish` of the App names each Workflow in `workflows` with the revision the person saw; `catalyst app publish` does that for the draft.

The run the App reads (kit `1.8.0` or later) then carries `mode: "test"`, `workflowRevision` (`{ kind: "draft" | "published", number }`, the number while that revision is still the draft or the published one) and `simulatedSteps`, the ids of the steps whose calls were simulated: their part of `output` is not real. The page around the App marks the result itself; an App may say so too, but needs no marker of its own. The published App never gets these fields.

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
