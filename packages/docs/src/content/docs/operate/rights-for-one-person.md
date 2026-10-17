---
title: Rights for one person or asset
description: Give one person rights on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage`.

Every agent and skill belongs to the instance or to the one Collaboration Workspace it was made in, a Personal or a Shared Workspace. A right in a Shared Workspace covers everything that workspace owns. A right on one asset covers that asset alone.

## Grants

A grant gives one person one action in one place. A Service Principal's grants are written on **Settings > Instance > API access**, not here. The **New right** form takes a person, a kind, the actions, the place and the effect, and writes one row per action. It offers only rights and places the giver holds. Giving a right or lifting a deny also checks that the giver holds what it would give; nobody changes their own grants.

For agents and skills, the actions are read, write and delete. **In a shared workspace** ("In einem geteilten Arbeitsbereich") covers every asset of that kind the workspace owns, including later ones, and gives no access to its conversations. **On one asset** ("An einem Asset") covers one existing asset. Instance-wide rights for agents and skills stay on the Users page.

Other kinds appear where their modules are on:

- **Connections:** read and use, separately. Reading shows configuration; using permits calls without showing configuration. Both support one Connection or the whole instance. The instance owns every Connection, so the server refuses new workspace grants with `invalid_scope`. Old workspace rows remain recorded until revoked, but cover no instance-owned Connection. Writing, deleting and approving stay with the administrator role. Removing or renaming a release-config Connection removes its allow rows at the next start; write the grants again for a renamed Connection.
- **Apps and Data Stores:** read, write, publish and delete, in one Shared Workspace, on one asset or for the whole instance. A workspace right covers what it owns. Using an App comes from workspace membership. These Data Store rights govern its definition, not access to its rows.
- **Knowledge Bases:** read, use, write, publish and delete, on one asset or for the whole instance.
- **Workflows:** read, use, write, publish and delete, on one asset or for the whole instance. Reading shows the Workflow and its runs; using starts it; writing edits its draft; publishing makes a revision live. Workflows are still instance-owned. Publishing also checks every right of the service principal the revision runs as. A Workflow whose principal holds `config_assets.release` cannot be published. **Read run data** supports one Workflow only and lets a person pass a complete dataset of that Workflow's runs to the inputs of a new Workflow run. Reading still shows only a dataset's row schema, row count and size, never its rows, and downloading a dataset is not available yet. Giving it or lifting a deny checks every right of the principals named by both the draft and published versions.
- **Guardrails:** publish, in one Shared Workspace or for the whole instance, separately from other kinds.

The dialog offers only places supported by every selected action; it hides the place step where only one is supported. Selecting run-data access limits a Workflow right to one asset. Without it, the other Workflow rights can also be given for the whole instance. See [How rights work](/operate/how-rights-work/#grants) for the scope table.

A row the person already has is left as it is, so the same form can be sent again after it stopped half way: it adds what is missing and says how many rows it added and how many were there already.

The list shows one line per person and scope, with the actions as chips. A deny chip carries its own mark and the word "Denied". Each chip is revoked from the menu of its line.

The effect is **Allow** or **Deny**:

- A deny wins over every grant and role that would allow the same action there.
- A deny is not a wall. A person with instance-wide rights can still export a denied agent or set it as the default, because those are decided for the instance.
- Whoever is denied reading or writing an asset cannot delete it.
- A deny on one asset belongs to its name. Deleting the asset removes the allow rows on it and keeps the deny rows. The list then shows the row as "Asset no longer exists". It applies again when an asset with that name is created, and stays until you revoke it.

**Revoke** removes one allow row at once, **Remove deny** one deny row. Rows held by a superadmin are shown to superadmins only. When the person who wrote a row is hidden from you, "Granted by" reads "Not available". A grant for a person whose account is being deleted is refused with "User account is being deleted".

A row on one asset names the asset only for a reader who may read that kind of asset (`config_assets.read`, or `agent.read` or `skill.read` for the instance). Any other reader sees the asset's id and whether the asset still exists. In the API, `scopeAsset.name` is absent for such a reader.

## Check

Choose a person and enter the name of an agent or a skill. The name does not have to exist yet, which answers "could this person create `sales-helper`?". For each action the tab says whether it is allowed and what decided:

| Reason           | Meaning                                           |
| ---------------- | ------------------------------------------------- |
| Role             | The person's instance role allows it everywhere.  |
| Individual right | A right set or revoked on the Users page decides. |
| Given right      | A row in a workspace or on the asset allows it.   |
| Deny             | A deny row refuses it.                            |
| No right         | Nothing covers it.                                |

An account that is not active has no rights, whatever its rows say.

The result is the right alone. A save the tab calls allowed can still be refused for a reason outside rights:

- a changed model setting without `agent_models.manage`
- the first agent of an instance and the last one change the default agent, which needs the instance-wide right to write agents
- agent configuration in the interface is switched off for the instance

A read that is allowed through a grant opens that asset. The overview of all agents and skills and the export need the instance-wide right to read.

The tab gives a result only when it has everything it decides from: the person's rights, the grant rows and the agents and skills of the instance. While one of them loads, or when it could not be loaded, the tab says so and shows no result, because a result without them could miss a deny on one asset. It also gives no result for a name no asset can have.

## Namespaces registered earlier

Rights were once scoped by a Namespace, a registered name prefix such as `sales-`. Namespaces are retired. The page still has a tab **Namespaces**, and a later release removes it. Until then:

- The server refuses new Namespace grant rows for every right. Existing allow and deny rows still apply to matching instance-owned assets and are listed and revoked like other rows. They never cover workspace-owned assets.
- A Namespace's tool and model lists still bind every save of an agent whose name starts with the prefix, a release push included. The Check tab names these lists under its result.
- A Namespace is deleted only when no row names it. Deleting it leaves the agents and skills as they are.

Give new rights in a workspace, on one asset or for the whole instance where the action supports it.

## API

Every person may read their own effective rights through `permissions.effective`, without `users.manage`. Reading another person’s effective rights or grant rows requires `users.manage`. A holder of `service_principals.manage` may read a technical account’s effective rights and grant rows; without `users.manage`, a grant-list request must explicitly select `holderKind=service_principal`. This gives no access to people’s rights. Credential scopes still apply.

The page uses the eight operations under `/api/v1/instance/access`. See the [API reference](/reference/api/).
