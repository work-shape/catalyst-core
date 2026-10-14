---
title: Rights and Namespaces
description: Give one person rights on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage` and has three tabs.

## Namespaces

Namespaces are being retired, and a new right is no longer given in one. The Namespaces already registered keep their lists, and the rights that name them keep applying, until a later release removes them. This section describes them for that time.

A Namespace is a registered name prefix such as `sales-`. Every agent and skill whose name starts with the prefix belongs to it. Two Namespaces never overlap: while `sales-` is registered, `sales-x-` is refused, and so is `sa-` for a registered `sa-team-`. The form checks this as you type. A prefix cannot be changed later.

A Namespace can carry two lists. Each is switched on with **Limit tools** or **Limit models**.

| Switch | Off | On with entries | On and empty |
| --- | --- | --- | --- |
| Limit tools | Agents may use every tool of the instance. | An agent is saved only with listed tools. | An agent that names a tool cannot be created or changed. |
| Limit models | Only a person with `agent_models.manage` sets the model of an agent. | A person who may write agents here picks a listed model without `agent_models.manage`. A model off the list is refused for everyone. An agent without a model is saved only by a person with `agent_models.manage`. | An agent that names a model cannot be created or changed by anyone. A person with `agent_models.manage` can still save an agent without a model. |

The lists bind every writer: a person who writes through a grant, an instance administrator and the release sync. The one exemption is the last cell of each model column, which belongs to `agent_models.manage`. A list is checked when an agent is created or changed; an agent that is saved unchanged is not checked.

Saving an empty list over agents that already have the prefix stops those saves, so the form names how many agents are affected and asks for a confirmation that names the Namespace before it saves. When the agents of the instance cannot be read, for example without `config_assets.read`, the form counts from the Namespace's own number of agents and skills instead.

A Namespace is deleted only when no grant names it. Until then its row says how many grants do. Deleting it frees the prefix and leaves the agents and skills as they are.

## Grants

A grant gives one person one action in one place. The **New right** form takes a person, a kind, the actions, the place and the effect, and writes one row per action. For agents and skills the actions are read, write and delete. The places are a shared workspace, one existing asset and the whole instance, in this order, and the form offers only the places where every action of the kind can be written. Today that is one existing asset for every kind, so the form asks for no place and goes straight to the asset.

The form offers no Namespace. Rows written in a Namespace before stay in the list, keep applying and are revoked like any other row until the Namespace is retired.

On an instance with the module `connections` on, the form also offers the kind Connections, with the actions read and use. Using a Connection is a right of its own: a person who may read a Connection may not use it, and a person who may use it is shown nothing of it. The place is one existing Connection. The instance owns every Connection, so a right on a workspace would cover nothing: a grant of `connection.read` or `connection.use` on a workspace is refused with `422` and the reason `invalid_scope`. Rows written on a workspace before keep applying until they are revoked. Writing, deleting and approving a Connection belong to the administrator role and are not granted. A Connection that release config no longer names, or names differently, is removed at the next start together with the allow rows written on it; grants on a renamed Connection have to be written again.

On an instance with the module `workflows` on, a grant can also name a Workflow, with the actions read, use, write and publish. Reading shows the Workflow in the list and its runs, using starts it, writing edits its draft, and publishing makes a revision live. The place is one existing Workflow; the instance owns every Workflow, so no grant on a workspace covers one. Publishing a Workflow that runs as a service principal needs the right to manage API access and the Superadmin role beside the publish right. Deleting a Workflow and reading the rows of a run's datasets belong to the administrator role and are not granted.

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
| Given right | A row in a Namespace or on the asset allows it. |
| Deny | A deny row refuses it. |
| No right | Nothing covers it. |

An account that is not active has no rights, whatever its rows say.

The result is the right alone. A save the tab calls allowed can still be refused for a reason outside rights:

- a tool or model list of the Namespace the name lies in. The tab names these lists under the result.
- a changed model setting without `agent_models.manage`
- the first agent of an instance and the last one change the default agent, which needs the instance-wide right to write agents
- agent configuration in the interface is switched off for the instance

A read that is allowed through a grant opens that asset. The overview of all agents and skills and the export need the instance-wide right to read.

The tab gives a result only when it has everything it decides from: the person's rights, the grant rows and the agents and skills of the instance. While one of them loads, or when it could not be loaded, the tab says so and shows no result, because a result without them could miss a deny on one asset. It also gives no result for a name no asset can have.

## API

The page uses the eight operations under `/api/v1/instance/access`. See the [API reference](/reference/api/).
