---
title: Rights for one person or asset
description: Give one person rights on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage`, and opens on its first tab, **Rights**; **Check** follows. An instance that still has a Namespace from an earlier release shows a third tab, **Namespaces**, until NS-RETIRE removes them.

Every agent and skill belongs to the instance or to the one Collaboration Workspace it was made in, a Personal or a Shared Workspace. A right in a Shared Workspace covers everything that workspace owns. A right on one asset covers that asset alone.

## Grants

A grant gives one person one action in one place. A Service Principal's grants are written on **Settings > Instance > API access**, not here. The **New right** form takes a person, a kind, a level and the place, and writes one row per action of the level. Each level includes the ones below it: **Use**, **View**, **Edit**, **Publish** and **Delete**, as far as the kind has them. For Workflows and Connections, **View** comes before **Use**: starting a Workflow or calling a Connection acts with the asset's own rights, so a person can be given View without Use, and Use brings View with it. A right that is no level, such as adding rows to a Data Store or reading a Workflow's run data, is ticked on its own under **Further rights**. It offers only rights and places the giver holds. Giving a right or lifting a deny also checks that the giver holds what it would give; nobody changes their own grants.

For agents and skills, the actions are read, write and delete. **In a shared workspace** ("In einem geteilten Arbeitsbereich") covers every asset of that kind the workspace owns, including later ones, and gives no access to its conversations. **On one asset** ("An einem Asset") covers one existing asset. Instance-wide rights for agents and skills stay on the Users page.

Other kinds appear where their modules are on:

- **Connections:** read and use, separately. Reading shows configuration; using permits calls without showing configuration. Both support one Connection or the whole instance. The instance owns every Connection, so the server refuses new workspace grants with `invalid_scope`. Old workspace rows remain recorded until revoked, but cover no instance-owned Connection. Writing, deleting and approving stay with the administrator role. Removing or renaming a release-config Connection removes its allow rows at the next start; write the grants again for a renamed Connection.
- **Apps and Data Stores:** read, write, publish and delete, in one Shared Workspace, on one asset or for the whole instance. A workspace right covers what it owns. Using an App comes from workspace membership. These Data Store rights govern its definition, not access to its rows.
- **Knowledge Bases:** read, use, write, publish and delete, on one asset or for the whole instance.
- **Workflows:** read, use, write, publish and delete, on one asset or for the whole instance. Reading shows the Workflow and its runs; using starts it; writing edits its draft; publishing makes a revision live. Workflows are still instance-owned. Publishing also checks every right of the service principal the revision runs as. A Workflow whose principal holds `config_assets.release` cannot be published. **Read run data** supports one Workflow only and lets a person pass a complete dataset of that Workflow's runs to the inputs of a new Workflow run. Reading still shows only a dataset's row schema, row count and size, never its rows, and downloading a dataset is not available yet. Giving it or lifting a deny checks every right of the principals named by both the draft and published versions.
- **Guardrails:** publish, in one Shared Workspace or for the whole instance, separately from other kinds.

The dialog offers only places supported by every selected action; it hides the place step where only one is supported. Selecting run-data access limits a Workflow right to one asset. Without it, the other Workflow rights can also be given for the whole instance. See [How rights work](/operate/how-rights-work/#grants) for the scope table.

A row the person already has is left as it is, so the same form can be sent again after it stopped half way: it adds what is missing and says how many rows it added and how many were there already.

The list shows one line per person and scope, and says it as a sentence: "may view and edit agents in Kai Spezis", in German "darf in Kai Spezis Agenten ansehen und bearbeiten". A deny is a sentence of its own with the mark "Denied": "may not edit, publish, or delete the agent tax-helper". Each action is revoked from the menu of its line.

A deny is the exception, so the form keeps it behind **Refuse instead** ("Stattdessen verweigern"). A deny refuses the chosen level and every level above it.

- A deny wins over every grant and role that would allow the same action there.
- A deny is not a wall. A person with instance-wide rights can still export a denied agent or set it as the default, because those are decided for the instance.
- Whoever is denied reading or writing an asset cannot delete it.
- A deny on one asset belongs to its name. Deleting the asset removes the allow rows on it and keeps the deny rows. The list then shows the row as "Asset no longer exists". It applies again when an asset with that name is created, and stays until you revoke it.

**Revoke** removes one allow row at once, **Remove deny** one deny row. Rows held by a superadmin are shown to superadmins only. When the person who wrote a row is hidden from you, "Granted by" reads "Not available". A grant for a person whose account is being deleted is refused with "User account is being deleted".

A row on one asset names the asset only for a reader who may read that kind of asset (`config_assets.read`, or `agent.read` or `skill.read` for the instance). Any other reader sees the asset's id and whether the asset still exists. In the API, `scopeAsset.name` is absent for such a reader.

## Check

Choose a person, a kind and an asset, each from a list by its name. For each action the tab says whether it is allowed and what decided:

| Reason           | Meaning                                           |
| ---------------- | ------------------------------------------------- |
| Role             | A role the person holds, built in such as Admin or custom such as Buchhaltung, allows or denies it; the reason names the role and where it applies. |
| Individual right | A right set or revoked on the Users page decides. |
| Given right      | A row in a workspace or on the asset allows it.   |
| Deny             | A deny row refuses it.                            |
| No right         | Nothing covers it.                                |

An account that is not active has no rights, whatever its rows say.

The server decides the result, by the same rule that guards every request; the tab only shows it. A row in the workspace that owns the asset counts. So does an App's availability: an App available to the whole instance may be used by anyone (**Available to everyone**), and an App its publisher made available only to themselves is used by nobody else, whatever their rights say.

The result is the right alone. A save the tab calls allowed can still be refused for a reason outside rights:

- a changed model setting without `agent_models.manage`
- the first agent of an instance and the last one change the default agent, which needs the instance-wide right to write agents
- agent configuration in the interface is switched off for the instance

A read that is allowed through a grant opens that asset. The overview of all agents and skills and the export need the instance-wide right to read.

The tab gives a result only when it has everything it decides from: the person's rights, the grant rows and the agents and skills of the instance. While one of them loads, or when it could not be loaded, the tab says so and shows no result, because a result without them could miss a deny on one asset. A refusal there names an instance admin to ask, never a page the reader cannot open.

## Effective rights on the Users page

A person's detail on **Instance > Users** shows **Effective rights**: every right the person holds, grouped by kind of asset with the administration last. Each line says where it applies, whether it holds, and where it comes from: a role by its name ("Rolle Buchhaltung"), a right given directly, or a workspace membership. A refused line names the deny that refuses it and, when the deny applies elsewhere, where. Assets are named by their title, with the technical name where an asset has none.

A Knowledge Base or Connection made available to a workspace is usable only while the person works in that workspace. Such a line says **Holds only while working in:** and names those workspaces; a call from any other workspace, or from none, is refused it. A right given directly or by a role holds everywhere and needs no such note. An App available to everyone is not listed per person; **Check** answers for one App.

The view only reads; rights are changed where they are set.

## API

Every person may read their own effective rights through `permissions.effective`, `permissions.rights` (each right decided, with its origin) and `permissions.check` (one asset), without `users.manage`. Reading another person’s effective rights, origins, check or grant rows requires `users.manage`. A holder of `service_principals.manage` may read a technical account’s effective rights and grant rows; without `users.manage`, a grant-list request must explicitly select `holderKind=service_principal`. This gives no access to people’s rights. Credential scopes still apply.

The page uses the operations under `/api/v1/instance/access`. See the [API reference](/reference/api/).
