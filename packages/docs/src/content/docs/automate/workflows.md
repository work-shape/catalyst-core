---
title: Workflows
description: Let the platform do work by itself, step by step, on a schedule or when you start it; try it with a test run and publish it.
---

A Workflow is work the platform does by itself, step by step: every morning, or when someone starts it. It runs without a chat. Each step reads or changes something, for example in a connected system or a Data Store.

The German interface shows the labels in quotes.

## Find your Workflows

Click **Workflows** in the main rail. The row shows when the instance has Workflows switched on and you may see at least one. The list shows each Workflow with its last run.

Open one to see its page:

- The **Workflow** tab shows the steps as a canvas, from **Starts** ("Startet") at the top down to the last step. A step is marked **Reads data** ("Liest Daten") or **Changes data** ("Ändert Daten").
- The **Runs** tab ("Läufe") lists every run, with what each step did.
- The trigger says when it runs: **Started by hand only** ("Startet nur von Hand") or **On a schedule** ("Nach Zeitplan"), such as "Every day, 07:00".

## Make or change a Workflow

You make a Workflow with an agent. Describe in a chat what should happen, when, and with which data, and ask the agent to build it as a Workflow. The agent needs the platform's building tools; ask your administrator which agent has them.

To change an existing one, open it and click **Edit with the agent** ("Mit dem Agenten bearbeiten"). A chat opens that is about this Workflow, and every change the agent saves becomes the next draft.

A change is always a **draft** first. The banner says **Draft, not published yet** ("Entwurf, noch nicht veröffentlicht") or **Draft differs from published** ("Entwurf weicht von der veröffentlichten Version ab"). Runs keep using the published version until the draft is published.

## Try it with a test run

1. On the Workflow's page, click **Test run** ("Testlauf").
2. Read the dialog and click **Start test run** ("Testlauf starten").

A test run reads real data as you, within what the Workflow's account may do. Steps that would change something are only simulated: each says what it would have done, and nothing is changed. Each step shows where its call went: **Live**, **Test** or **Simulated** ("Simuliert").

To try one changing step for real:

1. Select the step on the canvas.
2. Click **Run live once** ("Einmal live ausführen").
3. Start the next test run. That step runs for real once, under the instance's usual rules. The others stay simulated.

A step marked "A published run asks for approval here" would wait for someone's approval once the Workflow is published.

## Publish it

Click **Publish** ("Veröffentlichen") on the draft banner. The revision becomes the version that runs, by hand and on its schedule. **Discard** ("Verwerfen") takes the draft back to the published version.

A Workflow runs with its own account, not with yours, so it can read and change what you cannot. That is why publishing is held tight: today it takes a superadmin.

## Start it by hand

Click **Start now** ("Jetzt starten") on a published Workflow, fill in what it asks for, and click **Start** ("Starten"). The run appears under **Runs**. **Run again** ("Erneut starten") repeats a run.

## Who may do what

An administrator gives these rights under **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff"), for one Workflow:

| Right | What the Access page says |
| --- | --- |
| Read workflows | See the Workflow, its steps and its runs. |
| Use workflows | Start the Workflow. It then runs with the Workflow's own rights, not with this person's. |
| Write workflows | Change the draft of the Workflow. A draft does not run until it is published. |
| Publish workflows | Make a draft the version that runs. Today this also needs the superadmin role and the right to manage API access. |

Administrators hold every right but publishing. A test run needs the right to write the Workflow.
