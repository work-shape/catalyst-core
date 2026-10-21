---
title: Workshaper, the default agent
description: The agent that comes with every instance, who sees it, and how an instance changes it.
---

**Workshaper** is the agent that ships with Catalyst. It helps people get their work done on the instance: it finds out what they need, shows them what the platform offers for it, sets it up with them and helps with everyday tasks. It holds the platform's tools, so it can find, read and draft agents, Apps, Workflows and Data Stores, and it reads this documentation to answer how something works. A person still publishes, enters keys and grants rights; Workshaper says which page and which button.

## Who sees it

Workshaper comes with an instance where the module `workshaper` is on (see [Modules](/configure/modules/)). It starts offered in no workspace, so at first no chat lists it. An instance administrator offers it where people should use it: on the agent page in Studio, under **Available in** ("Verfügbar in"), the same way as any other agent. Superadmins and anyone who may change agents find it in **Studio > Agents** from the start and can try it there.

To let only some people use it where it is offered, set **Who may use it** ("Wer ihn verwenden darf") on the same page to "Only people and roles with the right", and give those people, or a role they hold, the right **Use** on Workshaper under **Instance > Access**.

Where the instance names no default agent, Workshaper is the default in every workspace that offers it. An instance that names its own default agent keeps it.

## Changing it

Workshaper is changed like any agent of the instance: its name shown to people, its description, welcome, instructions, starters, tools, skills and model. Its tools and skills come from what the instance has: every tool an agent of the instance may use, other than the tools of one Connection, App, Knowledge Base or Workflow, and every skill a capability ships. The instance gives it such per-asset tools itself.

Each release brings Workshaper up to date. A field the instance left as the last release shipped it takes what the new release ships. A field the instance changed stays as the instance wrote it. Tools and skills merge one by one: what the release ships, without what the instance removed since, with what the instance added. The agent page marks a field that differs from what the release shipped and offers to reset it.

Workshaper cannot be deleted. To hide it, offer it in no workspace. Turning the module off stops the updates and leaves the stored agent as it is. Its id, `workshaper`, stays the platform's: no other agent can take it, also with the module off. `catalyst config pull` brings it into a working copy like any agent, and a push changes it as the agent page does. What the release shipped stays on the instance and is not part of the file; a push that would delete it is refused.
