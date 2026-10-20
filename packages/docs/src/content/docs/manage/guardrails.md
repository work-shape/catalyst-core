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
| **Needs approval** ("Braucht Freigabe") | A change waits in the **Inbox** ("Eingang") until someone who may decide approves it. A read can't wait, so it is refused; so is a change that can't wait, such as an agent saving into an App draft. |
| **Blocks** ("Blockiert") | Nothing happens. The person or the agent is told the guardrail's reason. |

When a guardrail blocks something an agent tried in a chat, the agent's step shows as failed, such as "Could not change …", "Could not read …" or "The save failed", followed by the guardrail's reason, or "A guardrail blocked the call" when it gives none.

Every guardrail that applies runs, and the strictest answer wins. A guardrail can only make things stricter: it never allows what a right or the policy refuses.

A guardrail checks either for a **text pattern** ("Muster"), such as the shape of an IBAN, or with a **model** that reads the content against a written rule. A model check is a model call of the instance and counts toward its usage.

## Read them in Studio

Open **Studio** and choose **Guardrails** ("Leitplanken"). Each row has the sentence that says when it runs, and what it does on a hit. Open one to see:

- **Check** ("Prüfung"): when it runs, what it applies to ("Gilt für"), how it checks ("Wie sie prüft") and what it does on a hit;
- **Recent hits** ("Letzte Treffer"): how often it warned, held or blocked in the last 7 and 30 days, and the newest hits.

Hits never name a person. They say which rule, when, and what kind of thing was checked, not who did it. A list of who tripped which rule would make the instance a tool for watching employees.

The page in Studio only reads. You write a guardrail with the CLI, as below.

## Publishing needs an instance admin's approval

Every instance carries one guardrail of the platform, **Publishing needs an instance admin's approval** ("Veröffentlichen braucht die Freigabe eines Instanz-Admins"). It stands above the list in Studio, under **Shipped with the platform** ("Mit der Plattform geliefert"), and is on.

- A holder of `app.approve` or `workflow.approve` at instance scope clicks **Publish** in the app: the new version is live at once, and the record names them as publisher and approver. A workspace-scoped approve right does not count. A CLI publish always waits when approval is required, even for an admin: the server cannot tell a person at a terminal from an agent driving it, and keys never carry approve rights. The CLI names the request; an instance approver can approve it in the **Inbox**.
- Anyone else who may publish waits: their publish lands in the **Inbox** ("Eingang") of the instance admins as **App to publish** ("App zur Veröffentlichung") or **Workflow to publish** ("Workflow zur Veröffentlichung"). The item shows the version and the one it replaces, the files that differ, the changing actions or steps that are new or changed, the outside hosts it adds, the Connections, the Data Stores and the account a Workflow runs as. **Approve and publish** makes exactly that version live; if the draft or the live version changed meanwhile, the item says so and can no longer be approved. Publishing again replaces the waiting request.
- An instance admin can switch it off on that card, after a question. Then whoever may publish makes a new version live with their own click. Switching it off and on is recorded in the audit log, and an update of the platform never switches it back on.

Whatever the switch says, a new version goes live only on a person's click. `--yes` on the CLI publishes nothing by itself: the publish waits in your own Inbox, which nobody else sees, and your **Allow** there is your click on Publish. An instance approver's Allow makes it live at once; anyone else's files the item above for the instance admins. A publish from an agent or another program publishes nothing.

## Where guardrails come from

- **The operator's floor.** The operator sets guardrails in the release config. They always run, nobody can change or stop them in the product, and Studio marks them "set by the operator".
- **Guardrails written as assets.** An administrator writes further guardrails for the whole instance or for one shared workspace. They add checks to the floor and never remove one. A workspace's guardrail checks only what happens in that workspace.

Only the operator's guardrails check changes to guardrails, so a guardrail can never stop you from fixing one.

## Write, try and publish a guardrail

You write a guardrail as a file and save it with [the CLI](/configure/cli/): `catalyst guardrail put <name> --from <folder> --if-revision new`, or `catalyst config push` from a working copy. [Guardrails as assets](/configure/config-assets/#guardrails-as-assets) shows the file. A new guardrail is a **draft**: it checks nothing until it is published.

1. **Try it on an example.** `catalyst guardrail test <name> --text "<sample>"` says what the draft would answer. `--asset skill:<name>` tries it on an existing skill. A test keeps no hit.
2. **See what it would have done.** `catalyst guardrail dry-run <name>` counts what the draft would have warned on, held or blocked in the last 14 days, without names.
3. **Publish it.** `catalyst guardrail publish <name> --revision <n>` shows the dry run first. If the guardrail would have stopped actions, it asks you to confirm with the number it counted (`--confirm <n>`). Tip: publish it with the outcome "warn" first and watch its hits for a while.
4. **Stop it** with `catalyst guardrail unpublish <name>`. The draft stays.

Publishing is a right of its own. Administrators hold it for the instance. To let someone set the rules of one shared workspace, an administrator opens **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff"), clicks **New right** ("Neues Recht") and chooses **Guardrails** with the level **Publish** for that workspace: "Make a guardrail of this workspace enforce, or stop it. A guardrail stops other people's work in the workspace."

## More detail

- [Guardrails as assets](/configure/config-assets/#guardrails-as-assets): the file format and the rules for workspace guardrails.
- [Release config, Guardrails](/configure/release-config/#guardrails): the floor, every field, and how content and files are read.
- [How rights work](/operate/how-rights-work/#guardrails): where guardrails sit among rights and policy.
