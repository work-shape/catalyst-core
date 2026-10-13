---
title: How rights work
description: Who may do what in Workshape Catalyst, explained from the start. Roles, single rights, grants, Namespaces, the checks an action passes, and which screen sets which of them.
---

## The short version

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

This page explains the rights system to a reader who has never seen it. It says what exists today. The last section lists what does not exist yet. For the exact rules of the Access page, see [Rights and Namespaces](/operate/rights-and-namespaces/).

Three words come up on every screen, so here they are once.

- A **right** is the permission to do one kind of thing, such as "write agents". In the API a right has a short name like `agent.write`.
- A **grant** is one row that gives or refuses one person one right in one place. You write grants on the Access page.
- A **Namespace** is a registered beginning of a name, such as `tax-`. Every agent and skill whose name starts with it belongs to it, and so does every Connection where that module is on. See [Namespaces](#namespaces). It is not a workspace, as the next section shows.

## Namespace or workspace?

They are two different things. A **workspace** is where people work and what they see: its conversations, their files and the agents they can choose there. A **Namespace** is a name prefix, such as `tax-`, that says which agents and skills a right covers. Nothing links the two today. In practice they often come together, because a team tends to have a workspace and a prefix, and that is why they get mixed up.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 534" role="img" aria-labelledby="rights-fig-5-title rights-fig-5-desc">
<title id="rights-fig-5-title">Namespace and workspace side by side</title>
<desc id="rights-fig-5-desc">A table in two columns. A Namespace is a registered start of a name and groups agents and skills. A workspace is a place where people work together in conversations and has members. The only bridge between them is the setting Available in on each agent.</desc>
<defs><marker id="rights-arrow-5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="box-accent" x="150" y="8" width="245" height="40" rx="8"/>
<text x="272.5" y="33" class="strong" text-anchor="middle">Namespace</text>
<rect class="box-ok" x="405" y="8" width="245" height="40" rx="8"/>
<text x="527.5" y="33" class="strong" text-anchor="middle">Workspace</text>
<text x="8" y="84" class="small-strong">What it is</text>
<rect class="box" x="150" y="58" width="245" height="74" rx="8"/>
<rect class="box" x="405" y="58" width="245" height="74" rx="8"/>
<text x="164" y="82" class="small">A registered start of a name,</text>
<text x="164" y="100" class="small">such as tax-.</text>
<text x="419" y="82" class="small">A place where people work</text>
<text x="419" y="100" class="small">together in conversations.</text>
<text x="8" y="166" class="small-strong">What belongs to it</text>
<rect class="box" x="150" y="140" width="245" height="74" rx="8"/>
<rect class="box" x="405" y="140" width="245" height="74" rx="8"/>
<text x="164" y="164" class="small">Agents and skills whose names</text>
<text x="164" y="182" class="small">start with the prefix. Optional lists</text>
<text x="164" y="200" class="small">of allowed tools and models.</text>
<text x="419" y="164" class="small">Conversations with their files,</text>
<text x="419" y="182" class="small">and members with a role:</text>
<text x="419" y="200" class="small">owner, admin or member.</text>
<text x="8" y="248" class="small-strong">Who decides</text>
<rect class="box" x="150" y="222" width="245" height="74" rx="8"/>
<rect class="box" x="405" y="222" width="245" height="74" rx="8"/>
<text x="164" y="246" class="small">A person with Manage users</text>
<text x="164" y="264" class="small">registers it and writes its grants.</text>
<text x="419" y="246" class="small">Its owners and admins manage</text>
<text x="419" y="264" class="small">the members.</text>
<text x="8" y="330" class="small-strong">Where you see it</text>
<rect class="box" x="150" y="304" width="245" height="74" rx="8"/>
<rect class="box" x="405" y="304" width="245" height="74" rx="8"/>
<text x="164" y="328" class="small">Settings &gt; Instance &gt; Access,</text>
<text x="164" y="346" class="small">and in Studio beside each name.</text>
<text x="419" y="328" class="small">The workspace switcher, and the</text>
<text x="419" y="346" class="small">settings of the workspace.</text>
<text x="8" y="412" class="small-strong">What it does not do</text>
<rect class="box" x="150" y="386" width="245" height="74" rx="8"/>
<rect class="box" x="405" y="386" width="245" height="74" rx="8"/>
<text x="164" y="410" class="small">It has no members and no</text>
<text x="164" y="428" class="small">conversations. It does not decide</text>
<text x="164" y="446" class="small">where an agent can be used.</text>
<text x="419" y="410" class="small">Membership gives no right to</text>
<text x="419" y="428" class="small">read or change the definition</text>
<text x="419" y="446" class="small">of an agent or a skill.</text>
<text x="8" y="498" class="small-strong">The one bridge</text>
<rect class="frame" x="150" y="468" width="500" height="58" rx="8"/>
<text x="164" y="492" class="small">Each agent has a setting "Available in" that names the workspaces</text>
<text x="164" y="510" class="small">where people can choose it. It is set per agent, not per Namespace.</text>
</svg>
<figcaption>A Namespace groups agents by name for the people who build them. A workspace groups conversations for the people who use them.</figcaption>
</figure>

### When they go hand in hand

Take the tax team of a company. It has both.

- The Shared Workspace **Tax team** is where its twelve people chat. Its owner added them as members, and members reach the shared conversations in it. A private conversation stays with the person who created it. A Superadmin can enter every Shared Workspace without being a member.
- The Namespace `tax-` holds the agents the team uses, such as `tax-vat-helper`. Mara and one colleague hold grants in it. They are the two people of the team who build those agents. An Admin or a Superadmin of the instance can change them too.

<figure class="docs-diagram">
<svg viewBox="0 0 420 372" role="img" aria-labelledby="rights-fig-6-title rights-fig-6-desc">
<title id="rights-fig-6-title">The tax team has a workspace and a Namespace</title>
<desc id="rights-fig-6-desc">Two boxes, one above the other. On top, the Namespace tax- holds three assets, and two people hold grants in it. Below, the workspace Tax team has twelve members and their conversations. One arrow goes down from the Namespace to the workspace. It stands for the setting Available in, which is set for each agent. Nothing else connects the two boxes.</desc>
<defs><marker id="rights-arrow-6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="box-accent" x="10" y="8" width="400" height="150" rx="10"/>
<text x="28" y="36" class="strong">Namespace tax-</text>
<text x="28" y="62" class="small">A prefix that says what a right covers.</text>
<text x="28" y="90" class="small">tax-vat-helper, tax-year-end, tax-audit-notes</text>
<text x="28" y="110" class="small">Grants: Mara and one colleague</text>
<text x="28" y="138" class="small-strong">Decides who builds.</text>
<path class="line" d="M120 158 L120 212" marker-end="url(#rights-arrow-6)"/>
<text x="136" y="190" class="small">Available in, per agent</text>
<rect class="box" x="10" y="214" width="400" height="150" rx="10"/>
<text x="28" y="242" class="strong">Workspace "Tax team"</text>
<text x="28" y="268" class="small">Where people work and what they see.</text>
<text x="28" y="296" class="small">12 members, their conversations and files</text>
<text x="28" y="316" class="small">The agents they can choose</text>
<text x="28" y="344" class="small-strong">Decides who uses.</text>
</svg>
<figcaption>One team, two things. The only arrow between them is the setting <strong>Available in</strong>, which somebody sets on each agent. No setting says "the agents of <code>tax-</code> belong to the workspace Tax team".</figcaption>
</figure>

So ten people of the team use the agents and two build them. Membership in the workspace makes nobody a builder, and a grant in the Namespace gives no access to the team's conversations.

### How an agent of the Namespace reaches the workspace

Each agent has a setting named **Available in**. It lists the workspaces whose members can choose the agent in the chat.

- **All workspaces** is where every new agent starts, also one created in a Namespace. Mara's new `tax-travel-costs` can be chosen in every workspace of the instance at once, personal ones and future ones included.
- **Selected workspaces** narrows that to the Personal Workspaces, to chosen Shared Workspaces, or to both. With nothing ticked the agent is hidden everywhere.

To keep the tax agents to the tax team, somebody opens each agent in Studio, goes to **Available in**, chooses **Selected workspaces** and ticks **Tax team**. That somebody needs "Edit agent configuration" for the whole instance. Mara's grant in `tax-` does not show her this section, so she cannot do it herself.

Two exceptions. The default agent of the instance is always available everywhere. And an agent that arrives through a release push starts hidden when the same push deletes an agent that was limited to selected workspaces, because that is a rename and the new name must not reach more people than the old one did.

Nothing links a Namespace to a workspace today. You cannot say "the agents of `tax-` belong to the workspace Tax team". The only bridge is the **Available in** setting, agent by agent, and only a person with the instance-wide right sets it.

One kind of grant does name a workspace. With the module `connections` on, a grant to read or use Connections can be written "In a shared workspace", and it covers the Connections that workspace owns. The same kind of grant can instead be written in a Namespace or on one Connection. A grant on a workspace says nothing about agents, skills or conversations, and it has nothing to do with a Namespace.

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
3. A **grant** on the Access page allows or denies one action in one place. For agents and skills the place is one Namespace or one asset. For Connections it is one Namespace, one Connection or one Shared Workspace.

Then it decides:

- If any entry that covers this action in this place says **deny**, the answer is no.
- Otherwise, if any entry that covers it says **allow**, the answer is yes.
- Otherwise the answer is no. Nothing is allowed by default.

A "no" gets `403 FORBIDDEN`. The message names the missing right, for example `Missing the right 'agent.write'`.

Example: Mara has the role User, which carries no administrative right. A grant allows her to write agents in the Namespace `tax-`. She can save `tax-vat-helper`. She cannot save `hr-onboarding`, because nothing she holds covers that name.

### Does it need a second pair of eyes

A caller who holds the right can still be held back. This question is asked for the actions on the [full path](#which-actions-take-the-whole-path). Each of them is either **reading** or **changing**, and a **policy** gives it one of four values:

| Value | What happens |
| --- | --- |
| `allow` | The action runs. |
| `confirm` | The caller has to confirm. When you click a button or call the API or the CLI yourself, that call is the confirmation, and the action runs. |
| `approval` | The action waits. A person with the right to approve decides it in the [Inbox](/operate/governance/#inbox). |
| `deny` | The action is refused with `403 POLICY_DENIED`. |

A reading action only knows `allow` and `deny`. Nobody approves a read.

The instance ships with `allow` for reading and `confirm` for changing. The operator of the instance changes that in [release config](/configure/release-config/#operation-policy).

Example: an instance sets changing actions to `approval`. Mara saves `tax-vat-helper`. Studio says "This change waits for an approval. Nothing was changed yet and your text is still here." An administrator approves it in the Inbox. The instance then checks the call once more and saves the agent as Mara.

## Roles and single rights

Catalyst has three roles. The interface calls the role of a person their **Access level**, and you set it on **Settings > Instance > Users**.

| Role | What it carries |
| --- | --- |
| User | Chat, and nothing administrative. |
| Admin | Read and change agents and skills, approve changes, manage users, see usage and the audit log. Every right on Connections, where the module is on. |
| Superadmin | Everything an Admin has, plus managing API access and the model settings of agents. |

The three roles are fixed. You cannot change what a role carries, and you cannot create a role of your own.

Below the Access level, the same page has a card named **Rights** with one switch per right. A switch adds a right the role does not carry, or takes away one it does. The card shows where each right comes from: "by role", "granted individually" or "revoked individually". A revoked right stays revoked even though the role carries it.

| Switch on the Users page | Name in the API | Carried by |
| --- | --- | --- |
| View agent configuration | `config_assets.read` | Admin, Superadmin |
| Edit agent configuration | `config_assets.write` | Admin, Superadmin |
| Approve skill changes | `agent_skills.approve` | Admin, Superadmin |
| Manage users | `users.manage` | Admin, Superadmin |
| View usage | `usage.view` | Admin, Superadmin |
| View audit log | `audit.view` | Admin, Superadmin |
| Manage API access | `api_access.manage` | Superadmin |
| Manage agent model settings | `agent_models.manage` | Superadmin |

Some things are reserved for a Superadmin. Only a Superadmin gives somebody the Superadmin level, changes another Superadmin, deletes a user, or switches "Manage API access" and "Manage agent model settings" on or off.

"Approve skill changes" also lets a person decide an action that waits for an approval.

One right is on no switch. Pushing a release with `catalyst config push` needs `config_assets.release`, and only a Service Principal can hold it. See [API keys and Service Principals](#api-keys-and-service-principals).

Chatting is not on this list. Which conversations you see depends on the Collaboration Workspaces you are a member of and on whether a conversation is private, and not on one of these rights. The one exception is a Superadmin, who can enter every Shared Workspace.

The Users page has one more field, **Permission refs**. A tool written for one customer can ask for a reference such as `support-ticket-reader`. An agent can use that tool only for a person who has the same reference in this field.

## Grants

A role and a single right always apply to the whole instance. A grant is for everything narrower. It says five things:

| Part | Choices today |
| --- | --- |
| Who | One person. |
| Kind | Agents, or skills. Connections too, when the module `connections` is on. |
| Action | Read, write, delete for agents and skills. Read and use for Connections. |
| Where | For agents and skills, one Namespace or one existing asset. For Connections, one Namespace, one existing Connection or one Shared Workspace. |
| Effect | Allow, or deny. |

So the answer to "can rights only be given to single people" is yes, today. A grant names one person. There are no groups, and a role cannot hold a grant.

**Deny wins.** A deny on an asset beats every allow, including the one from the Admin role. Use it for the one agent that even administrators should not change by accident. A deny has limits of its own, which [Rights and Namespaces](/operate/rights-and-namespaces/#grants) lists.

**Read and write are separate.** A person who should edit agents needs both. With write alone they cannot open the agent they are meant to change.

**Check before you guess.** The tab **Check** on the Access page takes a person and a name and says for each action whether it is allowed and what decided. The name does not have to exist yet. The tab covers agents and skills. To get a result you need "View agent configuration" beside "Manage users", because the tab looks up the assets.

## Namespaces

A Namespace answers the question "which agents belong to this team". It does that through names.

You register a prefix, for example `tax-`. From then on every agent and skill of the instance whose name starts with `tax-` belongs to the Namespace. That includes agents somebody creates next month. A grant "write agents in `tax-`" therefore covers the whole family, and you never have to list the members.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 430" role="img" aria-labelledby="rights-fig-3-title rights-fig-3-desc">
<title id="rights-fig-3-title">Where a right can sit</title>
<desc id="rights-fig-3-desc">The Client Instance contains the agents and skills of the instance and the Collaboration Workspaces. Among the agents and skills, the Namespace tax- holds three assets and is covered by one grant. In the Namespace hr-, a grant sits on the single asset hr-onboarding. The asset helpdesk is in no Namespace. Workspaces hold conversations, and access to them comes from membership. A grant can name a workspace only for the Connections that workspace owns.</desc>
<defs><marker id="rights-arrow-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>
<rect class="frame" x="8" y="8" width="644" height="414" rx="12"/>
<text x="24" y="34" class="strong">Client Instance</text>
<text x="24" y="54" class="small">Roles and the single rights of the Users page apply to everything in here.</text>
<rect class="box" x="24" y="72" width="400" height="330" rx="10"/>
<text x="40" y="98" class="strong">Agents and skills of the instance</text>
<rect class="box-accent" x="40" y="114" width="368" height="128" rx="8"/>
<text x="54" y="138" class="strong">Namespace tax-</text>
<text x="54" y="156" class="small">A grant here covers every name that starts with tax-</text>
<rect class="box" x="54" y="170" width="110" height="56" rx="6"/>
<text x="109" y="203" class="small" text-anchor="middle">tax-vat-helper</text>
<rect class="box" x="172" y="170" width="110" height="56" rx="6"/>
<text x="227" y="203" class="small" text-anchor="middle">tax-audit-notes</text>
<rect class="box" x="290" y="170" width="110" height="56" rx="6"/>
<text x="345" y="203" class="small" text-anchor="middle">later ones too</text>
<rect class="box" x="40" y="256" width="236" height="130" rx="8"/>
<text x="54" y="280" class="strong">Namespace hr-</text>
<rect class="box-accent" x="54" y="296" width="150" height="74" rx="6"/>
<text x="129" y="326" class="small" text-anchor="middle">hr-onboarding</text>
<text x="129" y="346" class="small" text-anchor="middle">a grant on this one asset</text>
<rect class="box" x="290" y="256" width="118" height="130" rx="8"/>
<text x="349" y="280" class="small-strong" text-anchor="middle">No Namespace</text>
<rect class="box" x="300" y="296" width="98" height="74" rx="6"/>
<text x="349" y="338" class="small" text-anchor="middle">helpdesk</text>
<rect class="box" x="440" y="72" width="196" height="330" rx="10"/>
<text x="456" y="98" class="strong">Workspaces</text>
<text x="456" y="124" class="small">Collaboration Workspaces hold</text>
<text x="456" y="144" class="small">conversations and their files.</text>
<text x="456" y="184" class="small">Access to conversations comes</text>
<text x="456" y="204" class="small">from Workspace Membership.</text>
<text x="456" y="244" class="small">A grant can name a workspace</text>
<text x="456" y="264" class="small">only for its Connections.</text>
</svg>
<figcaption>The tinted boxes show where a grant on agents and skills can sit: a whole Namespace, or one asset. A grant on Connections sits in a Namespace, on one Connection or on a Shared Workspace. Everything wider is a role or a single right on the Users page.</figcaption>
</figure>

### An example

A company has a tax team. Its agents are named `tax-vat-helper` and `tax-year-end`, and it has a skill named `tax-audit-notes`.

1. An administrator registers the Namespace `tax-` with the display name "Tax team".
2. The administrator grants Mara read and write on agents in `tax-`.
3. Mara opens **Studio**. She sees the two tax agents and can change them. She does not see `hr-onboarding` or `helpdesk`.
4. Mara creates `tax-travel-costs`. The name starts with the prefix, so her grant covers it at once.
5. Jonas from the same team gets a grant on one asset instead, read on `tax-year-end`. He sees **Studio** with a list of agents that holds this one agent and nothing else. It opens read-only.

### Rules for a prefix

- A prefix is made of lowercase letters and digits, in parts joined by single hyphens. It starts with a letter and ends in a hyphen: `tax-`, `tax-team-`. It has 2 to 32 characters. `tax/` is not a valid prefix.
- Two Namespaces never overlap. While `tax-` exists, `tax-team-` is refused, so a name belongs to at most one Namespace.
- A prefix cannot be changed later. The id of an agent cannot be changed either. Decide the names first.
- Deleting a Namespace needs its grants revoked first. The agents and skills stay.

### A Namespace can also limit tools and models

A Namespace can carry a list of allowed tools and a list of allowed models. An agent in the Namespace is saved only with tools from the tool list and with model bindings from the model list. One way around the model list is left: a person with "Manage agent model settings" can save an agent that names no model binding, and it then runs on the model the instance uses by default. The lists are checked when an agent is saved. They bind every writer, an administrator and the release push included. They are not rights. They are limits on what an agent in this family may be given. The details are in [Rights and Namespaces](/operate/rights-and-namespaces/#namespaces).

### A Namespace is not a workspace

A grant in a Namespace covers what the instance itself owns under that prefix: its agents, its skills or its Connections, depending on the kind of the grant. It gives no access to any conversation. [Namespace or workspace?](#namespace-or-workspace) puts the two side by side.

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

| Step | Set by | Where |
| --- | --- | --- |
| 1 Sign-in or key | Administrator, Superadmin | Users for people, API access for keys |
| 2 Module | Operator | `modules` in [release config](/configure/modules/) |
| 3 Rate limit | Operator | `rateLimits` in release config |
| 4 Key scope | Superadmin | API access, when the key is created |
| 5 Tool list of the agent | Whoever may write the agent | The list of tools in the agent's definition |
| 6 Input | Nobody. The action defines its input. | |
| 7 Right | Administrator | Users for role and single rights, Access for grants |
| 8 and 10 Policy | Operator, and the author of a tool | `policy.defaults` in release config, `permission.mode` on a tool |
| 9 Guardrails | Nobody yet | See [Guardrails](#guardrails) |
| 11 and 12 Run and record | Nobody. It is part of every action on the full path. | Read it on Operations and Audit |

The chart shows the common exits. A few rarer ones exist.

- At step 1, a Service Principal that calls a route meant for people gets `403 FORBIDDEN`, and so does a browser request from an address the instance does not trust.
- At step 10, a call that needs an approval and cannot be held gets `403 POLICY_DENIED`. That is every call of a Service Principal and every call that carries a secret. A call whose input is too large to be held gets `422 VALIDATION_FAILED`.
- A call that repeats an `Idempotency-Key` gets the answer of the first call again, without new checks. The same key with different input is refused with `IDEMPOTENCY_KEY_REUSED`.

Three things about the order are worth knowing.

- **The module comes before the right.** A feature that is switched off does not exist for anybody, an administrator included. One switch is narrower. With `assetManagement` off, nobody changes agents and skills in the interface, but they can still be read and a release push still writes them.
- **The right comes before the policy.** A caller without the right never learns what the policy says, and never puts anything into somebody's Inbox.
- **An approved action is checked again.** An approval queues the call. Just before the call runs, the instance asks for the module, the right, the policy and the guardrails once more for the person who made the call, as that person is at that moment. If they lost the right while the call waited, the call does not run.

### Which actions take the whole path

Not every part of the product is on the full path yet.

- **All 12 steps:** every tool call of an agent. Reading, saving, deleting and reverting agents and skills in Studio and through the asset API, and the release push. Writing or revoking a grant, and creating, changing or deleting a Namespace. Creating, changing and deleting a user, and changing a user's sign-in identities, password or invitation. Creating and changing a Service Principal, and creating and revoking an API key. The retry of a background job.
- **Steps 1 to 4, a simpler input check and step 7:** everything else, for example conversations, workspaces, the lists of grants and Namespaces, the default agent, the **Available in** setting, usage and the audit log. These calls are refused the same way for a missing sign-in, module, scope or right. They have no policy step, cannot wait for an approval and leave no Operation Run.

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

There is an older, separate approval that works without the policy. An agent can propose a change to one of its skills. That proposal is an Approval Request of the kind "Skill change", and the same people decide it. The operator can add **Approval Checks** to it, which are rules a model evaluates and which warn the approver or block the proposal. See [config assets](/configure/config-assets/#agent-skill-changes).

Agents and approvals do not go together yet. A run cannot pause for a person and continue later. So the instance refuses to start with a tool of the release whose calls would need an approval or a confirmation. Such a tool states `allow` or `deny`, unless the instance default for its kind of action already is one of the two.

### Guardrails

A guardrail is meant to be a rule that looks at an action just before it runs and can block it or send it to an approval. It sits at step 9, after the right and the first look at the policy, and it can only make the answer stricter.

**No guardrail exists yet.** The step is built and every action on the full path passes it, but nothing is plugged in, so it always answers "no objection". The error `GUARDRAIL_BLOCKED` is in the API reference and does not occur today.

What protects an instance today are fixed limits that are not called guardrails:

| Limit | What it stops | Set in |
| --- | --- | --- |
| Module switches | A whole feature, for everybody | [release config](/configure/modules/) |
| Tool and model lists of a Namespace | An agent with a tool or model off the list | Access, tab Namespaces |
| Editable fields of an agent | A change in the interface to a field the release owns | [release config](/configure/config-assets/#interactive-editing-and-field-ownership) |
| Approval Checks | A proposed skill change that breaks a rule | [release config](/configure/release-config/#approval-checks) |
| Usage limits and budgets | Model calls beyond a daily or monthly amount | [Capacity and limits](/operate/capacity-and-limits/) |
| Rate limits | Too many requests in a short time | release config |

### What the record shows

Every changing action on the full path leaves an **Operation Run**. That is one record of one call: which action, who called, from where, and how it ended. A reading action leaves one only when it was refused or failed. Every tool call of an agent leaves one, a reading one too. A call that is stopped at steps 1 to 4, or for invalid input, leaves none, and neither does an action off the full path.

**Settings > Instance > Operations** lists them. The origin says where a call came from: User, CLI or Agent. A call that was refused has the status "Denied" and names what refused it. You need "View audit log" to open the page.

Beside the run, the instance writes Audit Events, for example `permission.granted` when somebody writes a grant. The events the product writes hold names, ids and codes, and no content of an agent or a conversation. A tool written for one customer adds its own details to its events and has to keep to the same rule. See [Governance](/operate/governance/#audit).

## A worked example

Mara has the role User and two grants: read and write on agents in `tax-`. The instance runs with the default policy.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 660 424" role="img" aria-labelledby="rights-fig-4-title rights-fig-4-desc">
<title id="rights-fig-4-title">Mara saves an agent of the tax team</title>
<desc id="rights-fig-4-desc">A sequence between Mara, the Studio area, the instance and its records. Mara saves the agent tax-vat-helper. The instance checks the sign-in, the module, the right through her Namespace grant, the policy and the tool list, then records the Operation Run and answers that the agent was saved.</desc>
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
<text x="346" y="232" class="small">allowed by her grant in tax-</text>
<text x="346" y="262" class="small">policy confirm: her own call confirms</text>
<text x="346" y="292" class="small">lists of tax-: nothing off the list</text>
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
2. Right `agent.read` on `hr-onboarding`: her grant covers names that start with `tax-`. This one does not. Nothing else covers it.
3. The instance answers `403 FORBIDDEN`. Studio says "You may not read this asset."
4. The refused call is on the Operations page with the status "Denied".

## Give a colleague the right to edit the agents of one team

You need "Manage users" yourself. Open **Settings > Instance > Access**.

**First, the Namespace.** If the team has none, open the tab **Namespaces** and choose **New Namespace**. Enter the prefix, for example `tax-`, and a display name. Leave "Limit tools" and "Limit models" off unless you want the lists. The team's agents must already carry the prefix in their names, or be created with it.

**Then the grant.** Open the tab **Grants** and choose **New grant**. In the German interface the button is "Neues Recht". The dialog has six fields.

| Field | What you choose | What it means |
| --- | --- | --- |
| Person | One person from the list | The grant is for this person alone. To give it to three colleagues, send the dialog three times. |
| Kind | Agents or Skills | One kind per dialog. A team that edits both needs the dialog twice. With the module `connections` on, the dialog offers Connections as a third kind. |
| Actions | Read, Write, Delete | Tick Read and Write for somebody who should edit. Tick Delete only if they should remove agents too. The dialog writes one row per tick. |
| Where | "In a Namespace" or "On one asset" | "In a Namespace" covers every agent whose name starts with the prefix, future ones included. "On one asset" covers one agent that exists now. For Connections the choices are "In a Namespace", "On one connection" and "In a shared workspace". |
| Namespace, or Asset | The Namespace `tax-`, or the one agent | Only registered Namespaces are offered. If the list is empty, register one first. |
| Effect | Allow or Deny | Allow gives the ticked actions there. Deny refuses them there and beats every allow and every role. For this task choose Allow. |

Press **Create grant**. Under the default policy the grant works at once. On an instance that sends changes to an approval, it works once the approval is given. Your colleague sees **Studio** in the main rail the next time the interface loads, with the agents of `tax-`. If these grants are all they hold, they see nothing else.

Three things to know afterwards.

- You can send the same dialog again. Rows the person already has are left alone, and the dialog says how many it added.
- **Check** on the same page confirms the result. Choose the person, enter `tax-vat-helper` and read the answer for each action. You need "View agent configuration" for that.
- A save can still be refused for a reason that is not a right. Examples are a tool that is off the Namespace's list, or a model setting that needs "Manage agent model settings". The Check tab lists these under its result.

To take the right away, open the menu of the line in the list and choose **Revoke** for the action. Once the revocation has run, the next call of your colleague is refused.

## API keys and Service Principals

The Catalyst CLI does not sign in as a person. It works as a Service Principal, and so should a script. A Superadmin creates a **Service Principal** on **Settings > Instance > API access** and gives it one or both of two rights:

- "Read configuration assets", to pull and compare agents and skills.
- "Release configuration assets", to push them with `catalyst config push`.

Then the Superadmin creates an **API key** for it and picks the key's scopes from the rights the Service Principal holds. The key is shown once.

A Service Principal has no role. A Superadmin can allow one to use a single named resource, such as one Connection: a grant with the holder kind `service_principal`, a use right, and that one asset as scope. The use rights are `connection.use`, `workflow.use`, and `data_store.read`, `data_store.insert` and `data_store.execute` for the rows of a Data Store, each where its module is on. No other grant can be written for one: no right that writes, publishes, deletes or manages, no workspace, Namespace or instance scope, and no deny. A Service Principal never writes a grant, also not for itself. Disabling a Service Principal leaves its grants recorded and without effect. The interface does not offer these grants yet; they are written through `POST /api/v1/instance/access/grants`.

A release push reaches every agent and skill of the instance and is not held back by the editing limits of the interface. It is still bound by the tool and model lists of a Namespace and by a deny on an asset. See [config assets](/configure/config-assets/#permissions).

## Which screen for what

| You want to | Screen | You need |
| --- | --- | --- |
| Make somebody an Admin or a Superadmin | Settings > Instance > Users, Access level | Manage users. Superadmin for the Superadmin level. |
| Give or take one right for the whole instance | Settings > Instance > Users, Rights | Manage users |
| Let somebody edit the agents of one team | Settings > Instance > Access, Grants | Manage users |
| Register a team's prefix, limit its tools or models | Settings > Instance > Access, Namespaces | Manage users |
| Find out why somebody can or cannot do something | Settings > Instance > Access, Check | Manage users and View agent configuration |
| Create a key for the CLI or a script | Settings > Instance > API access | Superadmin |
| Decide a call or a skill change that waits | Inbox | Approve skill changes |
| See what was called, by whom, and what was refused | Settings > Instance > Operations | View audit log |
| See who changed which right | Settings > Instance > Audit | View audit log |
| Switch a feature on or off, set the policy | Release config, then a deploy | The operator |

## What the system does not have yet

- **Groups and teams.** A grant names one person. Nothing gives a right to a group.
- **Custom roles.** The three roles are fixed. The Rights card on the Users page shows which rights a person has by role, and nothing edits what a role carries.
- **Company sign-in with group mapping.** People are not signed in through a company identity provider with its groups.
- **Grants on a workspace for agents and skills, and grants for other kinds.** A grant covers agents and skills, in a Namespace or on one asset, and Connections, in a Namespace, on one Connection or in one Shared Workspace. Writing, deleting and approving a Connection stay with the Admin role. Reading, using, writing and publishing a Workflow can be granted in a Namespace or on one Workflow through the API; the Access page does not offer the kind yet. Data Stores and Apps have no grant for a person.
- **Policy settings for administrators.** The instance can already resolve a policy value per action, per Namespace, per workspace and per kind of asset. Nothing stores such settings and no screen edits them. Today the policy is two instance-wide defaults and the mode a tool states. An administrator cannot set "saving in `tax-` needs an approval" in the interface.
- **Guardrails.** The step exists and nothing is plugged in.
- **An agent that waits for a person.** A run cannot pause for a confirmation or an approval and continue.
- **One path for everything.** Conversations, workspaces and the other areas named [above](#which-actions-take-the-whole-path) are checked for sign-in, module, scope and right, without policy and without an Operation Run.
