---
title: Workflows
description: Let the platform do work by itself, step by step, on a schedule or when you start it; try it with a test run and publish it.
---

A Workflow is work the platform does by itself, step by step: every morning, or when someone starts it. It runs without a chat. Each step reads or changes something, for example in a connected system or a Data Store.

The German interface shows the labels in quotes.

## Find your Workflows

Click **Workflows** in the main rail. The row shows when the instance has Workflows switched on and you may see at least one, or may write Workflows. The list shows each Workflow with its last run.

Open one to see its page:

- The **Workflow** tab shows the steps as a canvas, from **Starts** ("Startet") at the top down to the last step. A step is marked **Reads data** ("Liest Daten") or **Changes data** ("Ändert Daten").
- The **Runs** tab ("Läufe") lists every run, with what each step did.
- The trigger says when it runs: **Started by hand only** ("Startet nur von Hand") or the schedule, such as "Every day, 07:00 AM" ("Jeden Tag, …").

## Make or change a Workflow

A new Workflow is created with the CLI (`catalyst workflow put <name> --from … --if-revision new`); see [the CLI](/configure/cli/). After that, change it with **Edit with the agent** ("Mit dem Agenten bearbeiten") on its page. A chat opens that is about this Workflow: describe what should change, and every change the agent saves becomes the next draft.

A change is always a **draft** first. The banner says **Draft, not published yet** ("Entwurf, noch nicht veröffentlicht") or **Draft differs from published** ("Entwurf weicht von der veröffentlichten Version ab"). Runs keep using the published version until the draft is published.

The line **Runs as** ("Läuft als") under the heading names the active account by its display label. An unpublished draft shows the account configured in that draft too. No line is shown when that account is disabled or missing.

## Try it with a test run

1. On the draft banner, click **Test run** ("Testlauf").
2. Read the dialog and click **Start test run** ("Testlauf starten").

A test run reads real data, but only what both you and the Workflow may see. Steps that would change something are only simulated: each says what it would have done, and nothing is changed. Each step shows where its call went: **Live**, **Test** or **Simulated** ("Simuliert"). A test run writes no new draft and changes nothing about the published version. A step that starts another Workflow runs that Workflow's draft too, in the same test mode, where you may edit it; otherwise it runs its published version.

To try one changing step for real:

1. On the page of the test run, select the step.
2. In its panel, click **Run live once** ("Einmal live ausführen").
3. Click **Test again** ("Erneut testen"). That step runs for real once, under the instance's usual rules. The others stay simulated.

A step marked "A published run asks for approval here" needs someone's approval under the instance's rules. A published run stops at this step, because a run cannot wait for an approval. Change the step before you publish.

## Publish it

Click **Publish** ("Veröffentlichen") on the draft banner. The revision becomes the version that runs, by hand and on its schedule. **Discard** ("Verwerfen") takes the draft back to the published version.

A Workflow runs with its own account, not with yours, so it can read and change what you cannot. That is why publishing is held tight: it takes a superadmin.

## Start it by hand

Click **Start now** ("Jetzt starten") on a published Workflow, fill in what it asks for, and click **Start** ("Starten"). The run appears under **Runs**. On a run's page, **Run again** ("Erneut starten") starts the published version once more.

## Start it from a tool outside the instance

A tool on your computer, such as Claude Code with an API key, starts a Workflow only when its **Settings** tab has **By outside clients (CLI, MCP)** ("Durch externe Clients (CLI, MCP)") turned on. It is off for every Workflow until someone who may publish it turns it on and publishes. A person, an agent in the chat and an App start it as before.

The Workflow runs with its own account, which may read what you cannot, and its result is copied to that computer. So a tool may start it only while every Connection the Workflow reads, through another Workflow too, allows outside clients on the Connection's page. Publishing with the switch on is refused while one does not, and names it; a start is refused if one stops allowing it later. A Workflow that reads a Knowledge Base, calls an App's action or calls the platform's own API is never started from outside; a Data Store and sending mail are allowed. A tool reads the result of a run only when a tool started that run, not of runs a person, a schedule or an App started.

## Who may do what

An administrator gives these rights under **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff"), for one Workflow:

| Right             | What the Access page says                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| View workflows    | See the Workflow, its steps and its runs.                                                                            |
| Use workflows     | Start the Workflow. It then runs with the Workflow's own rights, not with this person's.                             |
| Edit workflows    | Change the draft of the Workflow. A draft does not run until it is published.                                        |
| Publish workflows | Make a draft the version that runs. Publishing also needs every right of the service principal the Workflow runs as. |

Administrators hold every right. A test run needs the right to edit the Workflow.

## Process rows in batches

An operation marked `batch: true` takes a list or dataset and returns `{ done, failed, failures }`.
`failures` is a dataset of `{ item, code, message }` for retrying individual items. The operation
step completes when the call succeeds, even when some items failed. Messages name the field and
error code, without repeating item values or provider responses.

Use `batch: 500` on a dataset loop to hand each iteration a dataset view: 1,200 rows become
500, 500 and 200 rows. Reference the loop with an empty path to pass that view to an operation,
code step or child Workflow. The loop item limit counts batches; `onItemFailure` still decides
what to do when an iteration itself fails. A batch loop requires a dataset, rather than an
inline list. It shares the parent's objects, permissions and expiry; it does not copy rows.
A view adds `offset` to the dataset reference and reports its own `rowCount`. Its `bytes` is
the parent's upper bound; consumers enforce byte limits against the rows actually read.

## Continue a long run

A long loop can continue in a fresh run when it reaches its step or duration budget.
Set `continueAsNew: { position: offset }` on the loop and declare `offset` as an optional
integer in the Workflow's inputs. The next run receives the next row offset. You can
request a smaller history with `after`, for example `{ position: offset, after: 1000 }`.

For a paged source, add `cursor: id` to pass the last completed row’s `id` as the
position input instead. A nonempty page continues and an empty page finishes the
loop. Map that position input into the source operation’s paging parameter.

The runs list groups these histories into one expandable run. Each part has its own
status and a numbered key. Work and usage count once across the parts. Labels and the
failure policy stay with the original run. A change published between parts applies
to the next part, and the list marks the version change. If the new version refuses
the carried input, that part fails and names the field that needs attention.

Until resume positions and finished-step outputs are carried between histories, publishing
and draft test runs refuse these shapes, naming the step and rule in English and German:

- A write, send, notify, child Workflow start, or loop containing one before a
  `continueAsNew` loop at the same or any enclosing level. Reads, triggers and code
  steps may precede it; those steps run again in every history.
- A loop after a `continueAsNew` loop at the same or any enclosing level.
- A loop with `concurrency` above 1 enclosing a `continueAsNew` loop, at any depth.
  The refusal names both loops: a checkpoint cannot record unfinished sibling items.
  Concurrency on the continuing loop itself remains allowed.
- A `limits.stepRuns` budget smaller than the steps before the loop, the loop containers,
  one item and the tail together. The refusal states the minimum count and the limit.

A `continueAsNew` loop can be the last loop, with non-loop steps after it. These are
publish-time restrictions pending EW-CAN-RESUME, which will resume at step boundaries
without repeating finished work.

Loop outputs `total`, `done` and `failed` cover the whole continuation chain (one Lauf),
including items finished in earlier histories. Later steps reading `each_x.done` or
`each_x.failed`, and a parent reading its child's output, receive these cumulative totals.
The checkpoint carries only fixed-size counts per loop level; it does not keep item results.
