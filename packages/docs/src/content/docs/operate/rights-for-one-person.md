---
title: Rights for one person or asset
description: Give one person rights on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage`.

Every agent and skill belongs to the instance or to the one Collaboration Workspace it was made in, a Personal or a Shared Workspace. A right in a Shared Workspace covers everything that workspace owns. A right on one asset covers that asset alone.

## Grants

A grant gives one person one action in one place. A Service Principal's grants are written on **Settings > Instance > API access**, not here. The **New right** form takes a person, a kind, the actions, the place and the effect, and writes one row per action. For agents and skills the actions are read, write and delete. The places are a shared workspace, one existing asset and the whole instance, in this order, and the form offers only the places where every action of the kind can be written. Today, for agents and skills, that is **In a shared workspace** ("In einem geteilten Arbeitsbereich"), which covers everything of the kind the workspace owns, also what is made later, and gives no access to its conversations; and **On one asset** ("An einem Asset"). For Connections and Workflows it is one existing item, so the form asks for no place and goes straight to the item. No action is offered for the whole instance.

On an instance with the module `connections` on, the form also offers the kind Connections, with the actions read and use. Using a Connection is a right of its own: a person who may read a Connection may not use it, and a person who may use it is shown nothing of it. The place is one existing Connection. The instance owns every Connection, so a right on a workspace would cover nothing: a grant of `connection.read` or `connection.use` on a workspace is refused with `422` and the reason `invalid_scope`. Rows written on a workspace before keep applying until they are revoked. Writing, deleting and approving a Connection belong to the administrator role and are not granted. A Connection that release config no longer names, or names differently, is removed at the next start together with the allow rows written on it; grants on a renamed Connection have to be written again.

On an instance with the module `workflows` on, a grant can also name a Workflow, with the actions read, use, write and publish. Reading shows the Workflow in the list and its runs, using starts it, writing edits its draft, and publishing makes a revision live. The place is one existing Workflow; the instance owns every Workflow, so no grant on a workspace covers one. Publishing a Workflow that runs as a service principal also needs every right that service principal holds: nobody makes a Workflow lend more than they hold themselves. A Workflow that runs as a service principal holding `config_assets.release` is published by nobody. Deleting a Workflow and reading the rows of a run's datasets belong to the administrator role and are not granted.

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

| Reason | Meaning |
| --- | --- |
| Role | The person's instance role allows it everywhere. |
| Individual right | A right set or revoked on the Users page decides. |
| Given right | A row in a workspace or on the asset allows it. |
| Deny | A deny row refuses it. |
| No right | Nothing covers it. |

An account that is not active has no rights, whatever its rows say.

The result is the right alone. A save the tab calls allowed can still be refused for a reason outside rights:

- a changed model setting without `agent_models.manage`
- the first agent of an instance and the last one change the default agent, which needs the instance-wide right to write agents
- agent configuration in the interface is switched off for the instance

A read that is allowed through a grant opens that asset. The overview of all agents and skills and the export need the instance-wide right to read.

The tab gives a result only when it has everything it decides from: the person's rights, the grant rows and the agents and skills of the instance. While one of them loads, or when it could not be loaded, the tab says so and shows no result, because a result without them could miss a deny on one asset. It also gives no result for a name no asset can have.

## Namespaces registered earlier

Rights were once scoped by a Namespace, a registered name prefix such as `sales-`. Namespaces are retired. The page still has a tab **Namespaces**, and a later release removes it. Until then:

- A row written in a Namespace keeps applying and is revoked like any other row.
- A Namespace's tool and model lists still bind every save of an agent whose name starts with the prefix, a release push included. The Check tab names these lists under its result.
- A Namespace is deleted only when no row names it. Deleting it leaves the agents and skills as they are.

Give new rights in a workspace or on one asset.

## API

Every person may read their own effective rights through `permissions.effective`, without `users.manage`. Reading another person’s effective rights or grant rows requires `users.manage`. A holder of `service_principals.manage` may read a technical account’s effective rights and grant rows; without `users.manage`, a grant-list request must explicitly select `holderKind=service_principal`. This gives no access to people’s rights. Credential scopes still apply.

The page uses the eight operations under `/api/v1/instance/access`. See the [API reference](/reference/api/).
