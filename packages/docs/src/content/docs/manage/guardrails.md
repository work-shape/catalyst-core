---
title: Guardrails
description: Rules that check an action just before it happens and warn, ask for an approval or block; how to read them in Studio, and how to write, test and publish one.
---

A guardrail is a rule that checks an action just before it happens, for example "no bank account numbers in skills". When the rule matches, the guardrail warns, sends the action for approval, or blocks it.

The German interface shows the labels in quotes.

## When a guardrail runs

A guardrail is bound to one moment:

- before an asset is saved, such as an agent, a skill or an App draft, whether in Studio, by an agent or with the CLI;
- before any operation is called, by a person, an agent, an App or a Workflow;
- before an App, a Workflow or a Data Store is published;
- before a request for approval is filed, such as a skill change an agent proposes.

It can be narrowed further, for example to skills only, to one agent, or to one workspace.

Studio says this in one sentence for each guardrail, under **When it runs** ("Wann sie greift"). For example:

> Runs before an agent saves a skill, in workspace Finance. Checks the content for a text pattern. Blocks if the check fails.

> Läuft, bevor ein Agent einen Skill speichert, im Workspace Finance. Prüft den Inhalt auf ein Textmuster. Blockiert, wenn die Prüfung anschlägt.

## What happens when one matches

| On a hit ("Bei einem Treffer") | What the person sees |
| --- | --- |
| **Warns** ("Warnt") | The action goes ahead. The reason is shown and kept beside it. |
| **Needs approval** ("Braucht Freigabe") | A change waits in the **Inbox** ("Eingang") until someone who may decide approves it. A read cannot wait and is refused. Where a change cannot wait either, such as the App draft an agent saves, it is blocked. |
| **Blocks** ("Blockiert") | Nothing happens. The person or the agent is told the guardrail's reason. |

Every guardrail that applies runs, and the strictest answer wins. A guardrail can only make things stricter: it never allows what a right or the policy refuses.

A guardrail checks either for a **text pattern** ("Muster"), such as the shape of an IBAN, or with a **model** that reads the content against a written rule. A model check is a model call of the instance and counts toward its usage.

## Read them in Studio

Open **Studio** and choose **Guardrails** ("Leitplanken"). Each row has the sentence that says when it runs, and what it does on a hit. Open one to see:

- **Check** ("Prüfung"): when it runs, what it applies to ("Gilt für"), how it checks ("Wie sie prüft") and what it does on a hit;
- **Recent hits** ("Letzte Treffer"): how often it warned, held or blocked in the last 7 and 30 days, and the newest hits.

Hits never name a person. They say which rule, when, and what kind of thing was checked, not who did it. A list of who tripped which rule would make the instance a tool for watching employees.

The page in Studio only reads. You write a guardrail with an agent or with the CLI, as below.

## Where guardrails come from

- **The operator's floor.** The operator sets guardrails in the release config. They always run, nobody can change or stop them in the product, and Studio marks them "set by the operator".
- **Guardrails written as assets.** An administrator, or an agent working for one, writes further guardrails for the whole instance or for one shared workspace. They add checks to the floor and never remove one. A workspace's guardrail checks only what happens in that workspace.

Guardrails never check changes to guardrails, except the floor. So no guardrail can lock people out of fixing guardrails.

## Write, try and publish a guardrail

Ask an agent with the platform's building tools to write the guardrail, or write it with [the CLI](/configure/cli/). A new guardrail is a **draft**: it checks nothing until it is published.

1. **Try it on an example.** `catalyst guardrail test <name> --text "<sample>"` says what the draft would answer. `--asset skill:<name>` tries it on an existing skill. A test keeps no hit.
2. **See what it would have done.** `catalyst guardrail dry-run <name>` counts what the draft would have warned on, held or blocked in the last 14 days, without names.
3. **Publish it.** `catalyst guardrail publish <name> --revision <n>` shows the dry run first. If the guardrail would have stopped actions, it asks you to confirm with the number it counted (`--confirm <n>`). Tip: publish it with the outcome "warn" first and watch its hits for a while.
4. **Stop it** with `catalyst guardrail unpublish <name>`. The draft stays.

Publishing is a right of its own. Administrators hold it for the instance. To let someone set the rules of one shared workspace, an administrator opens **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff"), clicks **New right** ("Neues Recht") and chooses **Publish guardrails** for that workspace: "Make a guardrail of this workspace enforce, or stop it. A guardrail stops other people's work in the workspace."

## More detail

- [Guardrails as assets](/configure/config-assets/#guardrails-as-assets): the file format and the rules for workspace guardrails.
- [Release config, Guardrails](/configure/release-config/#guardrails): the floor, every field, and how content and files are read.
- [How rights work](/operate/how-rights-work/#guardrails): where guardrails sit among rights and policy.
