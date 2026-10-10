---
title: Rights and Namespaces
description: Give one person rights on agents and skills in a Namespace or on one asset, and check what a person may do.
---

Instance roles and the rights set on the Users page apply to the whole instance. The page **Instance > Access** is for everything narrower: one person, one kind of asset, one place. It is shown to users who hold `users.manage` and has three tabs.

## Namespaces

A Namespace is a registered name prefix such as `kai-`. Every agent and skill whose name starts with the prefix belongs to it. Two Namespaces never overlap: while `kai-` is registered, `kai-x-` is refused, and so is `ka-` for a registered `ka-team-`. The form checks this as you type. A prefix cannot be changed later.

A Namespace can carry two lists. Each is switched on with **Limit tools** or **Limit models**.

| Switch | Off | On with entries | On and empty |
| --- | --- | --- | --- |
| Limit tools | Agents may use every tool of the instance. | An agent is saved only with listed tools. | An agent cannot be saved with any tool. |
| Limit models | Only a person with `agent_models.manage` sets the model of an agent. | A person who may write agents here picks a listed model without `agent_models.manage`. A model off the list is refused for everyone. | Nobody without `agent_models.manage` can create or save an agent here. |

The lists bind every writer who writes through a grant, the release sync included. Saving an empty list over agents that already have the prefix locks those writers out, so the form warns before it saves and names how many agents are affected.

A Namespace is deleted only when no grant names it. Until then its row says how many grants do. Deleting it frees the prefix and leaves the agents and skills as they are.

## Grants

A grant gives one person one action on one scope. The form takes a person, a kind (agents or skills), the actions read, write and delete, the scope, and the effect. It writes one row per action. The scope is a Namespace or one existing asset.

The effect is **Allow** or **Deny**:

- A deny wins over every grant and role that would allow the same action there.
- A deny is not a wall. A person with instance-wide rights can still export a denied agent or set it as the default, because those are decided for the instance.
- Whoever is denied reading or writing an asset cannot delete it.
- A deny on one asset belongs to its name. Deleting the asset removes the allow rows on it and keeps the deny rows. The list then shows the row as "Asset no longer exists". It applies again when an asset with that name is created, and stays until you revoke it.

**Revoke** removes one row at once. Rows held by a superadmin are shown to superadmins only. When the person who wrote a row is hidden from you, "Granted by" reads "Not available". A grant for a person whose account is being deleted is refused with "User account is being deleted".

## Check

Choose a person and enter the name of an agent or a skill. The name does not have to exist yet, which answers "could this person create `kai-helper`?". For each action the tab says whether it is allowed and what decided:

| Reason | Meaning |
| --- | --- |
| Role | The person's instance role allows it everywhere. |
| Individual right | A right set or revoked on the Users page decides. |
| Grant | A row in a Namespace or on the asset allows it. |
| Deny | A deny row refuses it. |
| No grant | Nothing covers it. |

An account that is not active holds nothing, whatever its rows say.

## API

The page uses the eight operations under `/api/v1/instance/access`. See the [API reference](/reference/api/).
