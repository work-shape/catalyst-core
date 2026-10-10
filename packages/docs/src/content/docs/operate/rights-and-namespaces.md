---
title: Rights and Namespaces
description: Give one person rights on agents and skills in a Namespace or on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage` and has three tabs.

## Namespaces

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

A grant gives one person one action on one scope. The form takes a person, a kind (agents or skills), the actions read, write and delete, the scope, and the effect. It writes one row per action. The scope is a Namespace or one existing asset.

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
| Grant | A row in a Namespace or on the asset allows it. |
| Deny | A deny row refuses it. |
| No grant | Nothing covers it. |

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
