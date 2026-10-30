---
title: What a Workflow can do
description: The runtime, packages, ceilings with their settings, source bounds, reach through Connections and what is not offered, as the Build Agent checks before it writes a Workflow.
---

<!-- workflow-capabilities:start -->
What a Workflow can do on this release, with the release's defaults. Each instance answers the same list with its own values as `workflows.capabilities`. Before it writes a Workflow, the Build Agent reads it and answers with one of four: it fits; it fits once an administrator or the operator switches something on, which it names; it belongs in another kind; or it is not a fit yet, with the reason.

## Runtime

Code steps run where the instance has a sandbox and a command worker.

- python: an entry ending in `.py`, run with `python3`
- javascript: an entry ending in `.js` or `.mjs`, run with `node`

The packages are the runner image's pinned Python distributions. Your instance lists them with their versions. A Workflow declares the ones its code steps need under `packages`; publish refuses any other.

## Ceilings

The operator raises a ceiling in release config under its setting. A step that needs more than a ceiling allows fails.

| Bound | Value | Setting |
| --- | --- | --- |
| Memory of one code step | 512 MiB | `workflows.codeSteps.memoryBytes` |
| CPUs of one code step | 0.5 CPU | `workflows.codeSteps.cpuCount` |
| Run time of one code step | 60 s | `workflows.codeSteps.timeoutSeconds` |
| Disk of one code step: its input datasets and what it writes | 2 GiB | `workflows.codeSteps.diskBytes` |
| Working directory of a script, part of its memory | 64 MiB | `workflows.codeSteps.scratchBytes` |
| Processes and threads of one code step | 64 | `workflows.codeSteps.pidsLimit` |
| Code steps one command worker runs at once | 4 | `workflows.codeSteps.slots` |
| Steps one process runs at once; the most `limits.concurrency` may set | 4 | `workflows.stepSlots` |
| The most a Workflow's `limits.duration` may set for one run | 7d | `workflows.limits.duration` |
| The most a Workflow's `limits.stepRuns` may set for one run | 1,000,000 | `workflows.limits.stepRuns` |
| The most a Workflow's `limits.loopItems` may set for one loop | 1,000,000 | `workflows.limits.loopItems` |
| The most a Workflow's `limits.datasetBytes` may set for one dataset | 2 GiB | `workflows.limits.datasetBytes` |
| The most a Workflow's `limits.pagedStepMinutes` may set for one paged step | 60 min | `workflows.limits.pagedStepMinutes` |
| One dataset | 2 GiB | `workflows.datasets.bytes` |
| Rows of one dataset | 5,000,000 | `workflows.datasets.rows` |
| Size of one row of a dataset | 256 KiB | `workflows.datasets.rowBytes` |
| Datasets of one run together | 10 GiB | `workflows.datasets.runBytes` |
| Datasets of the instance together | 50 GiB | `workflows.datasets.instanceBytes` |
| One value a step hands the next inline; more goes into a dataset | 256 KiB | fixed |

## Source

A Workflow's source is its folder: `workflow.yaml` and the files its code steps read.

| Bound | Value | Setting |
| --- | --- | --- |
| One file of a Workflow's tree | 2 MiB | `workflows.source.fileBytes` |
| Files of a Workflow's tree | 2,000 | `workflows.source.files` |
| A Workflow's tree together | 50 MiB | `workflows.source.treeBytes` |
| A Workflow's history | 100 MiB | `workflows.source.historyBytes` |
| workflow.yaml | 256 KiB | fixed |
| Steps of one definition, those of its loops and blocks among them | 200 | fixed |

## Reach

An `operation` step calls an operation of a Connection exposed to `workflow`. A changing operation runs only once an administrator switched it on. A code step reaches nothing outside its container.

`workflows.capabilities` names each Connection its reader may use, with the operations exposed to `workflow` and which changing ones an administrator switched on.

## Not offered

- A code step reaches no HTTP API, not even a Connection's: its container has no network. Call the Connection from an operation step and hand the result to the code step.
- A code step does not reach a postgres Connection's database. Read it through an operation step.
- No inbound network and no listening server: a step serves no requests. A Workflow starts by hand, on a schedule, from a webhook or from a platform event.
- No GPU.
- No host that only the customer's own network reaches: steps run on the platform's hosts and reach a system only through a Connection.
- No package is installed at publish or run time: a code step imports the runner image's packages, and another one needs a runner image release.
<!-- workflow-capabilities:end -->
