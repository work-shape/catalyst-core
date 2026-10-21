---
title: How rights work
description: Who may do what in Workshape Catalyst, explained from the start. Roles, single rights, grants, what a workspace owns, the checks an action passes, and which screen sets which of them.
---

## The short version

[Rights at a glance](/how-it-works/rights/) explains the same in three pictures.

1. An action is checked before it runs, in a fixed order, whether you click a button, a script calls the API or an agent uses a tool for you.
2. The instance first finds out who is calling, and for an API key what that key may be used for.
3. Then it asks whether the caller holds the right for this action in this place. A right comes from your role, from a single right on the Users page, or from a grant on the Access page.
4. For most changes, a policy decides whether the action runs at once, waits for a person's approval, or is refused. [Which actions take the whole path](#which-actions-take-the-whole-path) lists them.
5. For those actions the instance records each change, each refusal by a right or by the policy, and who decided.

<figure class="docs-diagram">
<svg viewBox="0 0 420 398" role="img" aria-labelledby="rights-fig-1-title rights-fig-1-desc">
<title id="rights-fig-1-title">The five layers an action passes</title>
<desc id="rights-fig-1-desc">Five boxes from top to bottom: identity, key scope, right, policy and guardrails, run and record. A call passes them in this order.</desc>
<defs><marker id="rights-arrow-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="box" x="10" y="8" width="400" height="62" rx="8"/>
<text x="28" y="35" class="strong">1  Identity</text>
<text x="28" y="55" class="small">Who is calling? A sign-in or an API key.</text>
<path class="line" d="M210.0 70 L210.0 86" marker-end="url(#rights-arrow-1)"/>
<rect class="box" x="10" y="88" width="400" height="62" rx="8"/>
<text x="28" y="115" class="strong">2  Key scope</text>
<text x="28" y="135" class="small">What may this key be used for?</text>
<path class="line" d="M210.0 150 L210.0 166" marker-end="url(#rights-arrow-1)"/>
<rect class="box-accent" x="10" y="168" width="400" height="62" rx="8"/>
<text x="28" y="195" class="strong">3  Right</text>
<text x="28" y="215" class="small">Does the caller hold the right here?</text>
<path class="line" d="M210.0 230 L210.0 246" marker-end="url(#rights-arrow-1)"/>
<rect class="box" x="10" y="248" width="400" height="62" rx="8"/>
<text x="28" y="275" class="strong">4  Policy and guardrails</text>
<text x="28" y="295" class="small">Run now, wait for a person, or refuse?</text>
<path class="line" d="M210.0 310 L210.0 326" marker-end="url(#rights-arrow-1)"/>
<rect class="box-ok" x="10" y="328" width="400" height="62" rx="8"/>
<text x="28" y="355" class="strong">5  Run and record</text>
<text x="28" y="375" class="small">The action runs. A change leaves a record.</text>
</svg>
<figcaption>An action passes these layers from top to bottom, and any layer can stop it. Layers 4 and 5 exist for the actions on the full path, which the section on the path lists.</figcaption>
</figure>

This page explains the rights system to a reader who has never seen it. For the exact rules of the Access page, see [Rights for one person or asset](/operate/rights-for-one-person/).

Three words come up on every screen, so here they are once.

- A **right** is the permission to do one kind of thing, such as "write agents". In the API a right has a short name like `agent.write`.
- A **grant** is one row that gives or refuses one person one right in one place. A Service Principal can hold a grant too, see [API keys and Service Principals](#api-keys-and-service-principals). You write grants on the Access page.
- The **owner** of an agent or a skill is the instance or the one Collaboration Workspace it was made in, a Personal or a Shared Workspace. It is set when the asset is made. A right in a Shared Workspace covers every asset of the chosen kind that workspace owns, including assets made later. See [What a workspace owns](#what-a-workspace-owns).

## What a workspace owns

An asset belongs to the instance or to one Collaboration Workspace, a Personal or a Shared Workspace. The owner is set when the asset is made; its name does not decide the owner. Agents, skills, Data Stores and Knowledge Bases accept either owner. Apps belong to a workspace. Connections and Workflows are still instance-owned.

- An agent made in Studio or by the Build Agent while you work in a workspace belongs to that workspace, your Personal Workspace included.
- An agent pushed with `catalyst config push` from a working copy bound to a workspace with `catalyst config pull --workspace <workspace-id>` belongs to that workspace. See [the CLI](/configure/cli/).
- An agent pushed from a working copy bound to no workspace, or written through the API without a workspace, belongs to the instance.

A grant can name a Shared Workspace, not a Personal one. A grant "write agents in Tax team" covers every agent Tax team owns, also the ones somebody makes next month. You never have to list them.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 430" role="img" aria-labelledby="rights-fig-3-title rights-fig-3-desc">
<title id="rights-fig-3-title">Where a right can sit</title>
<desc id="rights-fig-3-desc">The Client Instance contains the agents and skills the instance owns and the Shared Workspaces. The workspace Tax team owns three assets, and one agent right covers both agents, including later ones. Among the assets of the instance, a grant sits on the single asset hr-onboarding. The asset helpdesk is covered by no grant. Access to the conversations of a workspace comes from membership.</desc>
<rect class="frame" x="8" y="8" width="644" height="414" rx="12"/>
<text x="24" y="34" class="strong">Client Instance</text>
<text x="24" y="54" class="small">Roles and the single rights of the Users page apply to everything in here.</text>
<rect class="box" x="24" y="72" width="250" height="330" rx="10"/>
<text x="40" y="98" class="strong">Owned by the instance</text>
<rect class="box-accent" x="40" y="114" width="218" height="110" rx="8"/>
<text x="149" y="160" class="small" text-anchor="middle">hr-onboarding</text>
<text x="149" y="180" class="small" text-anchor="middle">a grant on this one asset</text>
<rect class="box" x="40" y="240" width="218" height="110" rx="8"/>
<text x="149" y="298" class="small" text-anchor="middle">helpdesk</text>
<rect class="box-accent" x="290" y="72" width="346" height="330" rx="10"/>
<text x="306" y="98" class="strong">Shared Workspace Tax team</text>
<text x="306" y="118" class="small">Covers its assets of the chosen kind.</text>
<rect class="box" x="306" y="134" width="96" height="56" rx="6"/>
<text x="354" y="167" class="small" text-anchor="middle">tax-vat-helper</text>
<rect class="box" x="410" y="134" width="104" height="56" rx="6"/>
<text x="462" y="167" class="small" text-anchor="middle">tax-year-end</text>
<rect class="box" x="522" y="134" width="98" height="56" rx="6"/>
<text x="571" y="167" class="small" text-anchor="middle">later ones too</text>
<text x="306" y="240" class="small">Its conversations and their files.</text>
<text x="306" y="260" class="small">Access to them comes from</text>
<text x="306" y="280" class="small">Workspace Membership, not from a grant.</text>
</svg>
<figcaption>The tinted boxes show a right on one asset and a right covering the assets of one kind a Shared Workspace owns. Some actions also support whole-instance grants; see the table under Grants. Workspace membership separately gives access to conversations.</figcaption>
</figure>

### An example

A company has a tax team with the Shared Workspace Tax team. Its agents `tax-vat-helper` and `tax-year-end` and its skill `tax-audit-notes` were made there, so Tax team owns them.

1. Mara holds read and write on agents in Tax team.
2. Mara opens **Studio**. She sees the two tax agents and can change them. She does not see `hr-onboarding` or `helpdesk`, which the instance owns.
3. Mara creates `tax-travel-costs` while she works in Tax team. Tax team owns it, so her grant covers it at once.
4. Jonas from the same team gets a grant on one asset instead, read on `tax-year-end`. He sees **Studio** with a list of agents that holds this one agent and nothing else. It opens read-only.

### Offering is not owning

An agent can be offered in further workspaces with **Available in**. Their members can then choose it in the chat. That gives them no right to read or change its definition: those stay with the workspace that owns it. A grant in a workspace also gives no access to any conversation.

## Building and using

A **workspace** is where people work and what they see: its conversations, their files and the agents they can choose there. It also owns the agents and skills made in it. Two things follow from that, and they are often mixed up. Who may **build** an agent is a right in the workspace, given on the Access page. Who may **use** an agent is where it is available, and membership of a workspace. Membership makes nobody a builder, and a right to build gives no access to conversations.

### An example: the tax team

Take the tax team of a company.

- The Shared Workspace **Tax team** is where its twelve people chat. Its owner added them as members, and members reach the shared conversations in it. A private conversation stays with the person who created it. A Superadmin can enter every Shared Workspace without being a member.
- The workspace owns the agents the team uses, such as `tax-vat-helper`, because they were made in it. Mara and one colleague hold rights to write agents in Tax team. They are the two people of the team who build those agents. An Admin or a Superadmin of the instance can change them too.

<figure class="docs-diagram">
<svg viewBox="0 0 420 372" role="img" aria-labelledby="rights-fig-6-title rights-fig-6-desc">
<title id="rights-fig-6-title">The tax team builds and uses its agents</title>
<desc id="rights-fig-6-desc">Two boxes, one above the other. On top, the agents and skills the workspace Tax team owns: three assets, and two people hold rights to build them. Below, the members of Tax team and their conversations. One arrow goes down from the top box to the bottom one. It stands for the setting Available in, which is set for each agent.</desc>
<defs><marker id="rights-arrow-6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="box-accent" x="10" y="8" width="400" height="150" rx="10"/>
<text x="28" y="36" class="strong">What Tax team owns</text>
<text x="28" y="62" class="small">The agents and skills made in the workspace.</text>
<text x="28" y="90" class="small">tax-vat-helper, tax-year-end, tax-audit-notes</text>
<text x="28" y="110" class="small">Rights to build: Mara and one colleague</text>
<text x="28" y="138" class="small-strong">Decides who builds.</text>
<path class="line" d="M120 158 L120 212" marker-end="url(#rights-arrow-6)"/>
<text x="136" y="190" class="small">Available in, per agent</text>
<rect class="box" x="10" y="214" width="400" height="150" rx="10"/>
<text x="28" y="242" class="strong">Members of Tax team</text>
<text x="28" y="268" class="small">Where people work and what they see.</text>
<text x="28" y="296" class="small">12 members, their conversations and files</text>
<text x="28" y="316" class="small">The agents they can choose</text>
<text x="28" y="344" class="small-strong">Decides who uses.</text>
</svg>
<figcaption>One team, two questions. A right in the workspace decides who builds. The setting <strong>Available in</strong>, set on each agent, decides where people can choose it.</figcaption>
</figure>

So ten people of the team use the agents and two build them. Membership in the workspace makes nobody a builder, and a right to build in it gives no access to the team's conversations.

### How an agent reaches a workspace

Each agent has a setting named **Available in**. It lists the workspaces whose members can choose the agent in the chat.

- **All workspaces**: every workspace of the instance, personal ones and future ones included.
- **Selected workspaces**: the Personal Workspaces, chosen Shared Workspaces, or both. With nothing ticked the agent is hidden everywhere.

A new agent starts in the workspace it was made in. Mara opens Studio while she works in Tax team, or asks the Build Agent in a conversation there, and her new `tax-travel-costs` can be chosen in Tax team and nowhere else. An agent made in a personal workspace, pushed with the CLI, or written through the API without a workspace starts hidden everywhere, and the answer says so. A person with the instance-wide right may choose **All workspaces** in the dialog that starts the agent.

To offer an agent in more workspaces, or to show a hidden one, somebody opens it in Studio, goes to **Available in** and chooses **All workspaces**, or **Selected workspaces** with the workspaces ticked. That somebody needs "Edit agent configuration" for the whole instance. Mara's right in Tax team does not show her this section, so she cannot do it herself.

Two exceptions. The default agent of the instance is always available everywhere, so the first agent of an instance starts there. And an agent that arrives through a release push starts in all workspaces, and hidden when the same push deletes an agent that was limited to selected workspaces, because that is a rename and the new name must not reach more people than the old one did.

Offering an agent in further workspaces lets their members use it. It never lets them edit it: the agent still belongs to the workspace it was made in, and only a right there, or on the instance, lets somebody change it. Only a person with the instance-wide right sets **Available in**.

### What an agent uses

Knowledge Bases and Connections have the same setting, **Available in** ("Verfügbar in"), on their page in Studio. Members of a workspace where one is available may use it through agents there, and nothing more: they cannot open its settings, read its definition or change it, and they never see a Connection's key. That use holds only in a conversation of a workspace where it is available: membership in workspace A, where a Knowledge Base is available, gives no use of it in a conversation of workspace B, where it is not. Availability is checked only for the workspace the call is made in. A CLI or API call made without a workspace is in none, so availability gives it nothing: it needs a use right given explicitly. Rights given on the Access page work as before. A Knowledge Base or Connection without the setting is available in no workspace, and an upgrade makes none available on its own. Only a person with the right to edit that kind on the whole instance sets it.

When an agent is published, or its **Available in** is saved, the dialog or the section lists the Knowledge Bases and Connections the agent uses that are not available in all of the agent's workspaces. Members there cannot use them through the agent.

- A person who may make every one of them available sees one choice, **Make them available there too** ("Dort auch verfügbar machen"), unticked. Ticked, the publish or the save also makes each of them available in the agent's workspaces, adding to where it already is. It does all of it or nothing.
- Anybody else reads the names of the instance admins to ask, and no link to the settings of what is missing.

Publishing or saving without the choice is allowed.

A workspace right follows ownership. It does not cover an instance-owned agent offered in that workspace, or an asset another workspace owns. Connections belong to the instance, so new Connection rights name one Connection or the whole instance; the server refuses workspace scope.

## The four questions

The instance asks four questions about an action. A "no" to any of them stops the action, and the answer says which question stopped it.

### Who are you

A caller is one of two things.

- A **User** is a person. You sign in to the interface, or the application of your company signs you in to the embedded chat.
- A **Service Principal** is an identity for a script or the Catalyst CLI. It has no password. It has an API key, which the script or the CLI exchanges for a short-lived access token before it calls.

A call without a valid sign-in or key gets `401 UNAUTHENTICATED` and nothing else happens. An account that is not active has no rights, whatever its role and its grants say.

Example: Mara signs in with her email and password. The nightly release job uses the API key of the Service Principal `release-ci`. Both are known callers now. Neither may do anything yet.

### What may your key do

This question matters for keys. A key carries **scopes**. A scope is a limit on the key itself, such as `config_assets:read`. The key can never do more than its scopes, even when the Service Principal behind it holds more rights. That lets you hand out a weak key for a task that only reads.

A person who signs in to the interface has no such limit. A session of the embedded chat is limited to the chat.

A call outside the scopes of its key gets `403 FORBIDDEN` with the text `Missing auth scope` and the name of the scope.

Example: `release-ci` holds the right to release agents and skills. Its key for the comparison job has the scope "Read configuration assets" only. That key can pull and compare. It cannot push.

### Do you hold the right here

This is the main question. It has two parts: which right, and where.

The instance collects everything that speaks about you:

1. Your **role** gives you a fixed set of rights on the whole instance.
2. A **single right** on the Users page adds one right to that set or takes one away, also for the whole instance.
3. A **grant** on the Access page allows or denies one action in one place. A new grant names one asset, a supported Shared Workspace scope, or the whole instance where that action allows it.

Then it decides:

- If any entry that covers this action in this place says **deny**, the answer is no.
- Otherwise, if any entry that covers it says **allow**, the answer is yes.
- Otherwise the answer is no. Nothing is allowed by default.

A "no" gets `403 FORBIDDEN`. The message names the missing right, for example `Missing the right 'agent.write'`.

Example: Mara has the role User, which carries no administrative right. A grant allows her to write agents in the workspace Tax team. She can save `tax-vat-helper`, which Tax team owns. She cannot save `hr-onboarding`, which the instance owns, because nothing she holds covers it.

### Does it need a second pair of eyes

A caller who holds the right can still be held back. This question is asked for the actions on the [full path](#which-actions-take-the-whole-path). Each of them is either **reading** or **changing**, and a **policy** gives it one of four values:

| Value      | What happens                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`    | The action runs.                                                                                                                            |
| `confirm`  | The caller has to confirm. When you click a button or call the API or the CLI yourself, that call is the confirmation, and the action runs. |
| `approval` | The action waits. A person with the right to approve decides it in the [Inbox](/operate/governance/#inbox).                                 |
| `deny`     | The action is refused with `403 POLICY_DENIED`.                                                                                             |

A reading action only knows `allow` and `deny`. Nobody approves a read.

The instance ships with `allow` for reading and `confirm` for changing. The operator of the instance changes that in [release config](/configure/release-config/#operation-policy).

Example: an instance sets changing actions to `approval`. Mara saves `tax-vat-helper`. Studio says "This change waits for an approval. Nothing was changed yet and your text is still here." An administrator approves it in the Inbox. The instance then checks the call once more and saves the agent as Mara.

## Roles and single rights

Catalyst has three roles. You set the **Role** of a person on **Settings > Instance > Users**.

| Role       | What it carries                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| User       | Chat, and nothing administrative.                                                                                                                  |
| Admin      | Read and change agents and skills, approve changes, manage users, see usage and the audit log. Every right on Connections, where the module is on. |
| Superadmin | Everything an Admin has, plus managing API access and the model settings of agents.                                                                |

The table shows what the roles carry as delivered. **Settings > Instance > Access, Roles** lists User, Admin and Superadmin, then the roles of your own. A role's page shows its rights by area, in the same sentences as the Rights tab.

- **A role of your own** starts as a copy of another role, and you change its rights, its name and its description, or delete it once nobody holds it. You need "Manage users", and you add only rights you hold.
- **User and Admin** are changed, and reset to their default, by a holder of "Edit the built-in roles User and Admin" (`roles.edit_built_in`). Superadmins carry it; they can give it to a person, or to a role, like any other right. A change reaches everybody who holds the role at once. Its holder still adds only rights they hold, and only a Superadmin adds or removes "Manage API access" and "Manage agent model settings".
- **Superadmin** is read-only: it carries every right of the release, so the instance can always be repaired from inside.

When a release adds a right to the default of User or Admin, or takes one out, and you changed that role, the role keeps its rights and the page asks you to decide: **Add** or **Leave out** a new right, **Remove** or **Keep** one the default lost. The Access page shows a notice while a decision is open.

Below the Role, the same page has a card named **Rights** with one switch per right. A switch adds a right the role does not carry, or takes away one it does. The card shows where each right comes from: "by role", "granted individually" or "revoked individually". A revoked right stays revoked even though the role carries it.

A switch is stored as grants for the whole instance, one per action the right stands for, and each records who set it and when. These grants are changed on the Users page and on the API access page for a Service Principal, not in the Grants list of the Access page, which leaves them out.

| Switch on the Users page    | Name in the API        | Carried by        |
| --------------------------- | ---------------------- | ----------------- |
| View agent configuration    | `config_assets.read`   | Admin, Superadmin |
| Edit agent configuration    | `config_assets.write`  | Admin, Superadmin |
| Approve skill changes       | `agent_skills.approve` | Admin, Superadmin |
| Manage users                | `users.manage`         | Admin, Superadmin |
| View usage                  | `usage.view`           | Admin, Superadmin |
| View audit log              | `audit.view`           | Admin, Superadmin |
| Manage API access           | `api_access.manage`    | Superadmin        |
| Manage agent model settings | `agent_models.manage`  | Superadmin        |

Some things are reserved for a Superadmin. Only a Superadmin gives somebody the Superadmin role, changes another Superadmin, deletes a user, or switches "Manage API access" and "Manage agent model settings" on or off.

"Manage users" does not let you hand out more than you hold. Giving a person a role, a switch or a grant asks whether you hold every right it carries, at the place it is given. Writing a deny, and taking one away, ask the same of the right the deny names. Nobody gives a right to themselves, and nobody writes or lifts a grant of their own, even one they already hold.

A deny of yours counts wherever it lies. If you are denied a right on one agent, you cannot give that right for a whole workspace or the instance that contains the agent, and you cannot give a role that carries it: the person would hold what you are refused. Give it on single assets outside the deny instead, or ask someone without the deny. The refusal names the asset only if you may read it.

Changing a person's account asks whether you hold every right the person holds: their role, their switches, their grants and the Shared Workspaces they are a member of. Their own Personal Workspace does not count. This covers the name and email, the password, a sign-in, the status, the role, the switches and the tool rights, and it holds for a person who is switched off as well, since switching them on is a change too. The check runs again as the change is written, so a role or a grant the person was given in the meantime counts. So a person with "Manage users" and nothing else can change only people who hold nothing beyond their Personal Workspace. Where a personal API key makes the call, its scopes count too. A refusal names the first right that is missing.

"Approve skill changes" also lets a person decide an action that waits for an approval.

One right is on no switch. Pushing a release with `catalyst config push` needs `config_assets.release`, and only a Service Principal can hold it. See [API keys and Service Principals](#api-keys-and-service-principals).

Managing Service Principals, `service_principals.manage`, is on no switch either. Admins and Superadmins carry it with their level. It creates a Service Principal, gives and takes its rights, and switches it on and off. Its keys stay with "Manage API access".

Chatting is not on this list. Which conversations you see depends on the Collaboration Workspaces you are a member of and on whether a conversation is private, and not on one of these rights. The one exception is a Superadmin, who can enter every Shared Workspace.

The Users page has one more field, **Tool rights**. A tool written for one customer can ask for a reference such as `support-ticket-reader`. An agent can use that tool only for a person who has the same reference in this field. A reference follows the same rule as a right: you give it only if you hold it yourself, never to yourself, and the references a person holds count when you change their account.

## Grants

A role and a single right always apply to the whole instance. A grant is for everything narrower, and for a right no switch carries it can be the whole instance too. It says five things:

| Part   | Choices                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who    | One person. A Service Principal gets its grants on the API access page.                                                                                                                                                                                              |
| Kind   | Agents, or skills. Connections, Apps, Data Stores, Knowledge Bases and Workflows too, where their modules are on.                                                                                                                                                    |
| Action | Read, write, delete for agents and skills. Read and use for Connections. Read, write, publish and delete for Apps and Data Stores. Read, use, write, publish and delete for Knowledge Bases and Workflows. Workflow run-data access is separate, as explained below. |
| Where  | One Shared Workspace, one existing asset, or the whole instance, only where the action supports it. The table below lists the choices.                                                                                                                               |
| Effect | Allow, or deny.                                                                                                                                                                                                                                                      |

The places supported for new rights are:

| Kind and actions                                   | Where the right can be given                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agents and skills: read, write, delete             | One Shared Workspace or one asset. Instance-wide rights stay on the Users page.                                                                                                      |
| Apps and Data Stores: read, write, publish, delete | One Shared Workspace, one asset or the whole instance. Using an App comes from workspace membership. These Data Store rights concern its definition; access to its rows is separate. |
| Connections: read, use                             | One asset or the whole instance. Writing, deleting and approving stay with the administrator role.                                                                                   |
| Knowledge Bases: read, use, write, publish, delete | One asset or the whole instance.                                                                                                                                                     |
| Workflows: read, use, write, publish, delete       | One asset or the whole instance. Workflows are still instance-owned.                                                                                                                 |
| Workflows: read run data                           | One Workflow only. Lets a person pass a complete dataset of this Workflow's runs to the inputs of a new Workflow run.                                                                |
| Guardrails: publish                                | One Shared Workspace or the whole instance, separately from other kinds.                                                                                                             |

The New right dialog offers only rights and places the giver holds. Its places narrow to those supported by every selected action. Selecting run-data access therefore limits a Workflow right to one asset; without it, the other Workflow rights can also be given for the whole instance.

Giving the run-data right, or lifting a deny of it, needs every right held by the service principals named in the Workflow's draft and published versions. The right is checked on the Workflow whose run wrote the dataset. A person who holds it may pass a complete dataset of that Workflow's runs to the inputs of a new Workflow run, and the engine checks it again whenever a person's request reads dataset rows. View shows only a dataset's row schema, row count and size, never its rows. A run reads only the datasets it wrote, received as input or got from a child run, and no dataset of an unrelated run. Downloading a dataset is not available yet.

So the answer to "can rights only be given to single people" is yes. A grant names one person or one Service Principal. There are no groups, and a role cannot hold a grant.

A giver who holds a right on one asset cannot give it for the whole workspace or instance.

**Deny wins.** A deny on an asset beats every allow, including the one from the Admin role. Use it for the one agent that even administrators should not change by accident. A deny has limits of its own, which [Rights for one person or asset](/operate/rights-for-one-person/#grants) lists.

**Read and write are separate.** A person who should edit agents needs both. With write alone they cannot open the agent they are meant to change.

**Check before you guess.** The tab **Check** on the Access page takes a person and a name and says for each action whether it is allowed and what decided. The name does not have to exist yet. The tab covers agents and skills. To get a result you need "View agent configuration" beside "Manage users", because the tab looks up the assets.

## The path of one action

Here is the whole way, in order. The table below the chart says who sets each step and where.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 862" role="img" aria-labelledby="rights-fig-2-title rights-fig-2-desc">
<title id="rights-fig-2-title">The path of one action with its refusal exits</title>
<desc id="rights-fig-2-desc">A flow chart with twelve steps from top to bottom. Each step has an exit to the right that names what the caller receives when the step refuses.</desc>
<defs><marker id="rights-arrow-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="box" x="10" y="10" width="300" height="50" rx="8"/>
<text x="26" y="40">1  Signed in, or a valid key?</text>
<path class="line" d="M310 35.0 L390 35.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="29.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="10" width="260" height="50" rx="8"/>
<text x="404" y="40" class="small-strong">401 UNAUTHENTICATED</text>
<path class="line" d="M160.0 60 L160.0 82" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="82" width="300" height="50" rx="8"/>
<text x="26" y="112">2  Is the module switched on?</text>
<path class="line" d="M310 107.0 L390 107.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="101.0" class="small" text-anchor="middle">off</text>
<rect class="box-stop" x="390" y="82" width="260" height="50" rx="8"/>
<text x="404" y="112" class="small-strong">404 NOT_FOUND, reason module_off</text>
<path class="line" d="M160.0 132 L160.0 154" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="154" width="300" height="50" rx="8"/>
<text x="26" y="184">3  Under the rate limit?</text>
<path class="line" d="M310 179.0 L390 179.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="173.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="154" width="260" height="50" rx="8"/>
<text x="404" y="184" class="small-strong">429 RATE_LIMITED</text>
<path class="line" d="M160.0 204 L160.0 226" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="226" width="300" height="50" rx="8"/>
<text x="26" y="256">4  Does the key's scope cover it?</text>
<path class="line" d="M310 251.0 L390 251.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="245.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="226" width="260" height="50" rx="8"/>
<text x="404" y="256" class="small-strong">403 FORBIDDEN, missing auth scope</text>
<path class="line" d="M160.0 276 L160.0 298" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="298" width="300" height="50" rx="8"/>
<text x="26" y="328">5  Agent only: is the tool on its list?</text>
<path class="line" d="M310 323.0 L390 323.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="317.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="298" width="260" height="50" rx="8"/>
<text x="404" y="328" class="small-strong">403 FORBIDDEN, agent_tool:&lt;name&gt;</text>
<path class="line" d="M160.0 348 L160.0 370" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="370" width="300" height="50" rx="8"/>
<text x="26" y="400">6  Is the input valid?</text>
<path class="line" d="M310 395.0 L390 395.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="389.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="370" width="260" height="50" rx="8"/>
<text x="404" y="400" class="small-strong">422 VALIDATION_FAILED</text>
<path class="line" d="M160.0 420 L160.0 442" marker-end="url(#rights-arrow-2)"/>
<rect class="box-accent" x="10" y="442" width="300" height="50" rx="8"/>
<text x="26" y="472" class="strong">7  Does the caller hold the right here?</text>
<path class="line" d="M310 467.0 L390 467.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="461.0" class="small" text-anchor="middle">no</text>
<rect class="box-stop" x="390" y="442" width="260" height="50" rx="8"/>
<text x="404" y="472" class="small-strong">403 FORBIDDEN, names the right</text>
<path class="line" d="M160.0 492 L160.0 514" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="514" width="300" height="50" rx="8"/>
<text x="26" y="544">8  Policy: may this run from here?</text>
<path class="line" d="M310 539.0 L390 539.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="533.0" class="small" text-anchor="middle">deny</text>
<rect class="box-stop" x="390" y="514" width="260" height="50" rx="8"/>
<text x="404" y="544" class="small-strong">403 POLICY_DENIED</text>
<path class="line" d="M160.0 564 L160.0 586" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="586" width="300" height="50" rx="8"/>
<text x="26" y="616">9  Guardrails: any objection?</text>
<path class="line" d="M310 611.0 L390 611.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="605.0" class="small" text-anchor="middle">block</text>
<rect class="box-stop" x="390" y="586" width="260" height="50" rx="8"/>
<text x="404" y="616" class="small-strong">403 GUARDRAIL_BLOCKED</text>
<path class="line" d="M160.0 636 L160.0 658" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="658" width="300" height="50" rx="8"/>
<text x="26" y="688">10  Policy: is an approval needed?</text>
<path class="line" d="M310 683.0 L390 683.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="677.0" class="small" text-anchor="middle">yes</text>
<rect class="box-wait" x="390" y="658" width="260" height="50" rx="8"/>
<text x="404" y="688" class="small-strong">202, waits in the Inbox</text>
<path class="line" d="M160.0 708 L160.0 730" marker-end="url(#rights-arrow-2)"/>
<rect class="box" x="10" y="730" width="300" height="50" rx="8"/>
<text x="26" y="760">11  The action runs</text>
<path class="line" d="M310 755.0 L390 755.0" marker-end="url(#rights-arrow-2)"/>
<text x="350.0" y="749.0" class="small" text-anchor="middle">fails</text>
<rect class="box-stop" x="390" y="730" width="260" height="50" rx="8"/>
<text x="404" y="760" class="small-strong">The action's own error</text>
<path class="line" d="M160.0 780 L160.0 802" marker-end="url(#rights-arrow-2)"/>
<rect class="box-ok" x="10" y="802" width="300" height="50" rx="8"/>
<text x="26" y="832" class="strong">12  Operation Run and audit rows</text>
</svg>
<figcaption>The left column is the way through. Each exit on the right is what the caller receives when that step stops the action. The Operation Run of step 12 is opened once the input is valid, so a refusal from the right onwards is on record too.</figcaption>
</figure>

| Step                     | Set by                                                    | Where                                                                              |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 Sign-in or key         | Administrator, Superadmin                                 | Users for people, API access for keys                                              |
| 2 Module                 | Operator                                                  | `modules` in [release config](/configure/modules/)                                 |
| 3 Rate limit             | Operator                                                  | `rateLimits` in release config                                                     |
| 4 Key scope              | Superadmin                                                | API access, when the key is created                                                |
| 5 Tool list of the agent | Whoever may write the agent                               | The list of tools in the agent's definition                                        |
| 6 Input                  | Nobody. The action defines its input.                     |                                                                                    |
| 7 Right                  | Administrator                                             | Users for role and single rights, Access for grants                                |
| 8 and 10 Policy          | Operator, and the author of a tool                        | `policy.defaults` in release config, `permission.mode` on a tool                   |
| 9 Guardrails             | Operator (the floor), and whoever may publish a guardrail | `guardrails` in release config; Studio > Guardrails. See [Guardrails](#guardrails) |
| 11 and 12 Run and record | Nobody. It is part of every action on the full path.      | Read it on Operations and Audit                                                    |

The chart shows the common exits. A few rarer ones exist.

- At step 1, a Service Principal that calls a route meant for people gets `403 FORBIDDEN`, and so does a browser request from an address the instance does not trust.
- At step 10, a call that needs an approval and cannot be held gets `403 POLICY_DENIED`. That is every call of a Service Principal and every call that carries a secret. A call whose input is too large to be held gets `422 VALIDATION_FAILED`.
- A call that repeats an `Idempotency-Key` gets the answer of the first call again, without new checks. The same key with different input is refused with `IDEMPOTENCY_KEY_REUSED`.

Three things about the order are worth knowing.

- **The module comes before the right.** A feature that is switched off does not exist for anybody, an administrator included. One switch is narrower. With `assetManagement` off, nobody changes agents and skills in the interface, but they can still be read and a release push still writes them.
- **The right comes before the policy.** A caller without the right never learns what the policy says, and never puts anything into somebody's Inbox.
- **An approved action is checked again.** An approval queues the call. Just before the call runs, the instance asks for the module, the right, the policy and the guardrails once more for the person who made the call, as that person is at that moment. If they lost the right while the call waited, the call does not run.

### Which actions take the whole path

- **All 12 steps:** every tool call of an agent. Reading, saving, deleting and reverting agents and skills in Studio and through the asset API, and the release push. Writing or revoking a grant. Creating, changing and deleting a user, and changing a user's sign-in identities, password or invitation. Creating and changing a Service Principal, and creating and revoking an API key. The retry of a background job.
- **Steps 1 to 4, a simpler input check and step 7:** everything else, for example conversations, workspaces, the list of grants, the default agent, the **Available in** setting, usage and the audit log. These calls are refused the same way for a missing sign-in, module, scope or right. They have no policy step, cannot wait for an approval and leave no Operation Run.

### Approvals

When the policy says `approval`, the action stops before it changes anything.

- The caller receives `202` and a reference to the waiting call. In Studio the page says that the change waits and keeps your text.
- The call appears in the **Inbox** of everybody who may decide it, as an "Operation call". That is every person with "Approve skill changes".
- **Approve** queues the call. The instance checks it again and then runs it once, as the person who made it. If that check fails, the call is refused although it was approved. The record names the approver.
- **Decline** ends it. The caller's record shows `DECLINED` and the approver's comment. The caller can also withdraw a waiting call.
- A call that nobody decides expires after 7 days.

A person who holds the approval right can approve their own call. The instance does not force a second person.

Only a person's call can wait. A call made with an API key is refused with `POLICY_DENIED` where the policy asks for an approval, and that includes a release push.

A call that carries a secret never waits. These are creating an API key, resetting a user's password, and creating a user with a first password. A held call would keep the secret and show it to whoever decides, and a key shown later reaches nobody. Under an instance default of `approval` such a call runs on the caller's own word. See [operation policy](/configure/release-config/#operation-policy).

There is an older, separate approval that works without the policy. An agent can propose a change to one of its skills. That proposal is an Approval Request of the kind "Skill change", and the same people decide it. [Guardrails](#guardrails) can check it before it is filed and warn the approver or block the proposal. See [config assets](/configure/config-assets/#agent-skill-changes).

A [guardrail](#guardrails) can also send a call to the Inbox: a call it answers with "needs approval" waits there like a call the policy holds.

A run cannot pause for a person and continue later. So the instance refuses to start with a tool of the release whose calls would need an approval or a confirmation. Such a tool states `allow` or `deny`, unless the instance default for its kind of action already is one of the two.

### Guardrails

A guardrail is a rule that looks at an action just before it happens and answers: let it through, warn, ask for an approval, or block. It sits at step 9, after the right and the first look at the policy, and it can only make the answer stricter.

Guardrails run at six points:

- before an asset is saved: a save in Studio, a push, a revert, an App written from a Page, an agent's save and the skill change it proposes;
- before any operation is called, at step 9 of every action on the full path;
- before an App, a Workflow or a Data Store is published;
- before a request for approval is filed.

Every guardrail that applies runs, and the strictest answer wins.

- **Block**: the action does not happen. The caller gets `403 GUARDRAIL_BLOCKED` with the guardrail's reason.
- **Ask for an approval** (`require_approval`): a changing call waits in the Inbox, as when the policy holds it. A reading call cannot wait and is refused. Where a changing action cannot wait either, such as the App draft an agent's save writes, it is blocked, and the hit says so.
- **Warn**: the action goes on, and the reason is kept beside it.

There are two sources of guardrails. The operator's floor is set in [release config](/configure/release-config/#guardrails), always runs and cannot be changed in the product. Further guardrails are written as assets, for the whole instance or for one Shared Workspace, tried on sample content and in a dry run, and made live by a person who may publish guardrails (`guardrail.publish`). Administrators hold that right for the instance, and an administrator can grant it for one Shared Workspace. A workspace's guardrail checks only what happens in that workspace. No published guardrail runs when guardrails themselves are changed; only the floor does. See [Guardrails](/manage/guardrails/) for the steps, and [Guardrails as assets](/configure/config-assets/#guardrails-as-assets) for the format.

**Studio > Guardrails** (German: **Studio › Leitplanken**) lists every guardrail with one sentence saying when it runs, such as "Runs before an agent saves a skill, in workspace Finance. Checks the content for a text pattern. Blocks if the check fails." A guardrail's page counts its hits for the last 7 and 30 days. Hits are counted by rule and never listed by person.

Beside guardrails, fixed limits protect an instance:

| Limit                       | What it stops                                         | Set in                                                                              |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Module switches             | A whole feature, for everybody                        | [release config](/configure/modules/)                                               |
| Editable fields of an agent | A change in the interface to a field the release owns | [release config](/configure/config-assets/#interactive-editing-and-field-ownership) |
| Usage limits and budgets    | Model calls beyond a daily or monthly amount          | [Capacity and limits](/operate/capacity-and-limits/)                                |
| Rate limits                 | Too many requests in a short time                     | release config                                                                      |

### What the record shows

Every changing action on the full path leaves an **Operation Run**. That is one record of one call: which action, who called, from where, and how it ended. A reading action leaves one only when it was refused or failed. Every tool call of an agent leaves one, a reading one too. A call that is stopped at steps 1 to 4, or for invalid input, leaves none, and neither does an action off the full path.

**Settings > Instance > Operations** lists them. The origin says where a call came from: User, CLI or Agent. A call that was refused has the status "Denied" and names what refused it. You need "View audit log" to open the page.

Beside the run, the instance writes Audit Events, for example `permission.granted` when somebody writes a grant. The events the product writes hold names, ids and codes, and no content of an agent or a conversation. A tool written for one customer adds its own details to its events and has to keep to the same rule. See [Retention, audit and deletion](/operate/governance/#audit).

## A worked example

Mara has the role User and two grants: read and write on agents in Tax team. The instance runs with the default policy.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 424" role="img" aria-labelledby="rights-fig-4-title rights-fig-4-desc">
<title id="rights-fig-4-title">Mara saves an agent of the tax team</title>
<desc id="rights-fig-4-desc">A sequence between Mara, the Studio area, the instance and its records. Mara saves the agent tax-vat-helper. The instance checks the sign-in, the module, the right through her grant in Tax team, the policy and the guardrails, then records the Operation Run and answers that the agent was saved.</desc>
<defs><marker id="rights-arrow-4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<path class="lifeline" d="M62 48 L62 416"/>
<path class="lifeline" d="M196 48 L196 416"/>
<path class="lifeline" d="M336 48 L336 416"/>
<path class="lifeline" d="M598 48 L598 416"/>
<rect class="box" x="6" y="14" width="112" height="34" rx="6"/>
<text x="62" y="36" class="strong" text-anchor="middle">Mara</text>
<rect class="box" x="140" y="14" width="112" height="34" rx="6"/>
<text x="196" y="36" class="strong" text-anchor="middle">Studio</text>
<rect class="box" x="280" y="14" width="112" height="34" rx="6"/>
<text x="336" y="36" class="strong" text-anchor="middle">Instance</text>
<rect class="box" x="542" y="14" width="112" height="34" rx="6"/>
<text x="598" y="36" class="strong" text-anchor="middle">Records</text>
<text x="129.0" y="71" class="small" text-anchor="middle">saves the agent</text>
<path class="line" d="M62 78 L196 78" marker-end="url(#rights-arrow-4)"/>
<text x="266.0" y="101" class="small" text-anchor="middle">assets.put</text>
<path class="line" d="M196 108 L336 108" marker-end="url(#rights-arrow-4)"/>
<text x="346" y="142" class="small">signed in: yes</text>
<text x="346" y="172" class="small">module assetManagement: on</text>
<text x="346" y="202" class="small">right agent.write on tax-vat-helper:</text>
<text x="346" y="232" class="small">allowed by her grant in Tax team</text>
<text x="346" y="262" class="small">policy confirm: her own call confirms</text>
<text x="346" y="292" class="small">guardrails: none stops it</text>
<text x="467.0" y="321" class="small" text-anchor="middle">Operation Run: done, audit rows</text>
<path class="line" d="M336 328 L598 328" marker-end="url(#rights-arrow-4)"/>
<text x="266.0" y="351" class="small" text-anchor="middle">200, new revision</text>
<path class="line" d="M336 358 L196 358" marker-end="url(#rights-arrow-4)"/>
<text x="129.0" y="376" class="small" text-anchor="middle">shows the saved agent</text>
<path class="line" d="M196 388 L62 388" marker-end="url(#rights-arrow-4)"/>
</svg>
<figcaption>One save, step by step. Each line inside the Instance column is a check from the flow chart above.</figcaption>
</figure>

Now she tries the same on `hr-onboarding`, which a colleague sent her as a link.

1. Sign-in: yes. Module: on.
2. Right `agent.read` on `hr-onboarding`: her grant covers what Tax team owns. The instance owns this one. Nothing else covers it.
3. The instance answers `403 FORBIDDEN`. Studio says "You may not read this asset."
4. The refused call is on the Operations page with the status "Denied".

## Give a colleague the right to edit an agent

You need "Manage users" yourself. Open **Settings > Instance > Access**, the tab **Rights**, and choose **New right**. In the German interface the button is "Neues Recht". The dialog has five fields.

| Field           | What you choose                                         | What it means                                                                                                                                                                       |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person          | One person from the list                                | The right is for this person alone. To give it to three colleagues, send the dialog three times.                                                                                    |
| Kind            | Agents                                                  | One kind per dialog. A colleague who edits skills too needs another right for Skills. Other kinds appear where their modules are on; see the table under Grants.                    |
| Actions         | Read, Write, Delete                                     | Tick Read and Write for somebody who should edit. Tick Delete only if they should remove the agent too. The dialog writes one row per tick.                                         |
| Where and asset | **On one asset** ("An einem Asset"), then the one agent | The right covers this agent, which exists now. **In a shared workspace** ("In einem geteilten Arbeitsbereich") would cover every agent the workspace owns instead, also later ones. |
| Effect          | Allow or Deny                                           | Allow gives the ticked actions there. Deny refuses them there and beats every allow and every role. For this task choose Allow.                                                     |

Press **Create right**. Under the default policy the right works at once. On an instance that sends changes to an approval, it works once the approval is given. Your colleague sees **Studio** in the main rail the next time the interface loads, with the agent. If these rights are all they hold, they see nothing else. For a team with several agents, choose the Shared Workspace instead of repeating this for each agent.

Three things to know afterwards.

- You can send the same dialog again. Rows the person already has are left alone, and the dialog says how many it added.
- **Check** on the same page confirms the result. Choose the person, enter the agent's name and read the answer for each action. You need "View agent configuration" for that.
- A save can still be refused for a reason that is not a right. An example is a model setting that needs "Manage agent model settings". The Check tab lists such reasons under its result.

To take the right away, open the menu of the line in the list and choose **Revoke** for the action. Once the revocation has run, the next call of your colleague is refused.

## API keys and Service Principals

The Catalyst CLI does not sign in as a person. It works as a Service Principal, and so should a script. Whoever manages Service Principals, an Admin for example, creates a **Service Principal** on **Settings > Instance > API access** and gives it one or both of two rights:

- "Read configuration assets", to pull and compare agents and skills.
- "Release configuration assets", to push them with `catalyst config push`. Only a Superadmin gives this one.

Then a person with "Manage API access" creates an **API key** for it and picks the key's scopes from the rights the Service Principal holds. The key is shown once.

Nobody gives a Service Principal more than they hold themselves. Giving it a right, switching it back on and issuing it a key each ask whether the person holds every right the Service Principal would act with. Where a personal API key makes the call, its scopes count too. A refusal names the first right that is missing, and the asset only where the person may read it. Taking a right away and switching a Service Principal off ask nothing of it.

A Service Principal has no role. Whoever manages Service Principals can allow one to use a single named resource they may use themselves, such as one Connection: a grant with the holder kind `service_principal`, a use right, and that one asset as scope. The use rights are `connection.use`, `workflow.use`, and `data_store.read`, `data_store.insert` and `data_store.execute` for the rows of a Data Store, each where its module is on. No other grant can be written for one: no right that writes, publishes, deletes or manages, no workspace or instance scope, and no deny. A Service Principal never writes a grant, also not for itself. Disabling a Service Principal leaves its grants recorded and without effect. The interface does not offer these grants; they are written through `POST /api/v1/instance/access/grants`.

A release push reaches every agent and skill of the instance and is not held back by the editing limits of the interface. It is still bound by a deny on an asset. See [config assets](/configure/config-assets/#permissions).

## Which screen for what

| You want to                                        | Screen                                         | You need                                                    |
| -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| Make somebody an Admin or a Superadmin             | Settings > Instance > Users, Role              | Manage users. Superadmin for the Superadmin role.           |
| Give or take one right for the whole instance      | Settings > Instance > Users, Rights            | Manage users                                                |
| Create a role, or change what a role carries      | Settings > Instance > Access, Roles            | Manage users; for User and Admin `roles.edit_built_in`      |
| Let somebody edit an agent                         | Settings > Instance > Access, Rights           | Manage users                                                |
| Find out why somebody can or cannot do something   | Settings > Instance > Access, Check            | Manage users and View agent configuration                   |
| Create a key of your own for the CLI               | Settings > You > API keys, or `catalyst login` | The module `personalApiKeys` on                             |
| Create a Service Principal or give it a right      | Settings > Instance > API access               | Manage Service Principals, and the right you give           |
| Create a key for a script or CI                    | Settings > Instance > API access               | Manage API access, and every right of the Service Principal |
| Decide a call or a skill change that waits         | Inbox                                          | Approve skill changes                                       |
| See what was called, by whom, and what was refused | Settings > Instance > Operations               | View audit log                                              |
| See who changed which right                        | Settings > Instance > Audit                    | View audit log                                              |
| Switch a feature on or off, set the policy         | Release config, then a deploy                  | The operator                                                |
