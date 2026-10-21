---
title: Rights at a glance
description: Three pictures that explain who may do what in Catalyst, where an App's data comes from, and what a workspace gives its members.
---

This page is for the administrators of a Catalyst instance. It all comes down to two questions: who are you, and what may you do? [How rights work](/operate/how-rights-work/) explains the same system in full detail.

## Two questions

**Who are you?** A person who signs in. A person who is a member of a workspace also gets what is shared there. A Workflow runs as a technical account. By default it gets its own when it is first published, with only the rights its steps need, and only rights the person publishing holds themselves. A Workflow can instead name an existing shared account. An agent has none: it acts with the rights of the person it works for, and a tool on an agent adds no right.

**What may you do?** A right is an action in a place, for example "use the accounting Connection". The place is one workspace, one item, or the whole instance. A role bundles rights; the three roles User, Admin and Superadmin are fixed. A right is given to a person, to a Workflow's technical account, or comes with a role.

Three rules always hold:

- Nothing is allowed until it is given.
- A deny beats every allow, even an administrator's. Exporting an agent and setting the default agent are not affected.
- Using is not editing. Whoever may open an App may not change it for that reason.

<figure class="docs-diagram">
<svg viewBox="0 0 420 562" role="img" aria-labelledby="rx-f1-title rx-f1-desc">
<title id="rx-f1-title">Two questions: who are you, and what may you do?</title>
<desc id="rx-f1-desc">At the top three kinds of caller: a person, a member of a workspace and a Workflow's technical account. Below: a right is an action in a place. At the bottom: a right is given to a person, a Workflow's account or a role.</desc>
<defs>
<marker id="rx-f1-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead" d="M0 0 10 5 0 10z"/>
</marker>
<marker id="rx-f1-arrow-stop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead-stop" d="M0 0 10 5 0 10z"/>
</marker>
</defs>
<rect class="box" x="10" y="8" width="400" height="156" rx="10"/>
<text x="26" y="34" class="strong">1   Who are you?</text>
<circle class="node-person" cx="75" cy="82" r="16"/>
<text x="75" y="86" class="initial" text-anchor="middle">A</text>
<text x="75" y="124" class="small" text-anchor="middle">A person</text>
<text x="75" y="140" class="small" text-anchor="middle">who signs in</text>
<rect class="zone" x="172" y="56" width="76" height="52" rx="10"/>
<circle class="node-person" cx="210" cy="82" r="16"/>
<text x="210" y="86" class="initial" text-anchor="middle">B</text>
<text x="210" y="124" class="small" text-anchor="middle">A member of</text>
<text x="210" y="140" class="small" text-anchor="middle">a workspace</text>
<rect class="node-account" x="329" y="66" width="32" height="32" rx="6"/>
<g class="icon" transform="translate(337 74) scale(0.6666666666666666)">
<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
<circle cx="16.5" cy="7.5" r=".5"/>
</g>
<text x="345" y="124" class="small" text-anchor="middle">A Workflow's</text>
<text x="345" y="140" class="small" text-anchor="middle">technical account</text>
<path class="line" d="M210 164 L210 186" marker-end="url(#rx-f1-arrow)"/>
<rect class="box-accent" x="10" y="188" width="400" height="214" rx="10"/>
<text x="26" y="214" class="strong">2   What may you do?</text>
<rect class="box" x="26" y="228" width="160" height="132" rx="8"/>
<text x="40" y="250" class="small-strong">Action</text>
<text x="40" y="270" class="small">use</text>
<text x="40" y="285" class="small">read</text>
<text x="40" y="300" class="small">write</text>
<text x="40" y="315" class="small">publish</text>
<text x="40" y="330" class="small">delete</text>
<text x="40" y="345" class="small">approve</text>
<text x="210" y="298" class="strong" text-anchor="middle">+</text>
<rect class="box" x="234" y="228" width="160" height="132" rx="8"/>
<text x="248" y="250" class="small-strong">Where</text>
<text x="248" y="270" class="small">in one workspace</text>
<text x="248" y="285" class="small">on one item</text>
<text x="248" y="300" class="small">on the whole instance</text>
<text x="210" y="386" class="strong" text-anchor="middle">= one right</text>
<path class="line" d="M210 402 L210 424" marker-end="url(#rx-f1-arrow)"/>
<rect class="box" x="10" y="426" width="400" height="128" rx="10"/>
<text x="26" y="452" class="strong">Given to</text>
<circle class="node-person" cx="75" cy="486" r="14"/>
<text x="75" y="490" class="initial" text-anchor="middle">A</text>
<text x="75" y="522" class="small" text-anchor="middle">a person</text>
<rect class="node-account" x="196" y="472" width="28" height="28" rx="6"/>
<g class="icon" transform="translate(202 478) scale(0.6666666666666666)">
<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
<circle cx="16.5" cy="7.5" r=".5"/>
</g>
<text x="210" y="522" class="small" text-anchor="middle">a Workflow's</text>
<text x="210" y="536" class="small" text-anchor="middle">account</text>
<rect class="node-role" x="329" y="470" width="32" height="32" rx="6"/>
<g class="icon" transform="translate(337 478) scale(0.6666666666666666)">
<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>
<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>
<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>
</g>
<text x="345" y="522" class="small" text-anchor="middle">a role</text>
<text x="345" y="536" class="small" text-anchor="middle">(a bundle of rights)</text>
</svg>
</figure>

## Where an App gets its data, and who sees it

An App shows data in two ways: live from an outside system, or from its Data Store. A Data Store is filled by Workflows, by the App's own actions that add rows, and by people with the right to add rows. The two ways follow different rules. The numbers in the picture are the four decisions on the way.

People can be granted `data_store.read`, `data_store.insert` and `data_store.execute` on one
store, on the stores a workspace owns, or on the instance. `insert` adds rows; `execute`
changes or removes rows with `update` and `delete_rows`. Editing or publishing a definition
(`data_store.write` and `data_store.publish`) gives no row right. Admins hold row rights by
default; Builder and Publisher do not. An agent acts with its person's rights, and merely
being offered a tool grants none. Row writes ask for confirmation under the ordinary policy.

<figure class="docs-diagram docs-diagram-wide">
<svg viewBox="0 0 680 384" role="img" aria-labelledby="rx-f2-title rx-f2-desc">
<title id="rx-f2-title">Where an App gets its data, and who sees it</title>
<desc id="rx-f2-desc">Two ways inside one instance. At the top Anna reads live from an accounting data source through the App; the App calls the Connection as Anna. Below, the Workflow Night import copies data from an accounting data source into the App's Data Store as its technical account, and everyone who may open the App reads the copy. Numbers 1, 3 and 4 are Catalyst's decisions, number 2 the outside system's.</desc>
<defs>
<marker id="rx-f2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead" d="M0 0 10 5 0 10z"/>
</marker>
<marker id="rx-f2-arrow-stop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead-stop" d="M0 0 10 5 0 10z"/>
</marker>
</defs>
<rect class="frame" x="150" y="8" width="410" height="364" rx="12"/>
<text x="166" y="32" class="small-strong">Your Catalyst instance</text>
<text x="358" y="70" class="lane" text-anchor="middle">Read live</text>
<text x="290" y="168" class="lane">Stored</text>
<rect class="box-outside" x="578" y="72" width="96" height="160" rx="8"/>
<g class="icon icon-outside" transform="translate(588 83) scale(0.6666666666666666)">
<circle cx="12" cy="12" r="10"/>
<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
<path d="M2 12h20"/>
</g>
<text x="610" y="96" class="strong">Books</text>
<text x="588" y="116" class="small">Outside</text>
<text x="588" y="132" class="small">system</text>
<circle class="gate-outside" cx="578" cy="152" r="10"/>
<text x="578" y="156" class="gate-num" text-anchor="middle">2</text>
<rect class="box" x="170" y="72" width="104" height="280" rx="8"/>
<g class="icon" transform="translate(180 83) scale(0.6666666666666666)">
<rect width="7" height="7" x="3" y="3" rx="1"/>
<rect width="7" height="7" x="14" y="3" rx="1"/>
<rect width="7" height="7" x="14" y="14" rx="1"/>
<rect width="7" height="7" x="3" y="14" rx="1"/>
</g>
<text x="202" y="96" class="strong">Deadlines</text>
<text x="180" y="116" class="small">App</text>
<rect class="box" x="444" y="72" width="104" height="160" rx="8"/>
<g class="icon" transform="translate(454 83) scale(0.6666666666666666)">
<path d="M12 22v-5"/>
<path d="M15 8V2"/>
<path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/>
<path d="M9 8V2"/>
</g>
<text x="476" y="96" class="strong">Books</text>
<text x="454" y="116" class="small">Connection</text>
<circle class="node-person" cx="64" cy="110" r="16"/>
<text x="64" y="114" class="initial" text-anchor="middle">A</text>
<text x="64" y="146" class="small" text-anchor="middle">Anna</text>
<text x="64" y="162" class="small" text-anchor="middle">opens the App</text>
<path class="line" d="M84 110 L168 110" marker-end="url(#rx-f2-arrow)"/>
<circle class="gate" cx="128" cy="110" r="10"/>
<text x="128" y="114" class="gate-num" text-anchor="middle">4</text>
<path class="line" d="M274 110 L442 110" marker-end="url(#rx-f2-arrow)"/>
<text x="340" y="102" class="small" text-anchor="middle">as Anna</text>
<circle class="gate" cx="414" cy="110" r="10"/>
<text x="414" y="114" class="gate-num" text-anchor="middle">1</text>
<path class="line" d="M548 110 L576 110" marker-end="url(#rx-f2-arrow)"/>
<rect class="box" x="290" y="178" width="124" height="56" rx="8"/>
<g class="icon" transform="translate(300 189) scale(0.6666666666666666)">
<rect width="8" height="8" x="3" y="3" rx="2"/>
<path d="M7 11v4a2 2 0 0 0 2 2h4"/>
<rect width="8" height="8" x="13" y="13" rx="2"/>
</g>
<text x="322" y="202" class="strong">Night import</text>
<text x="300" y="222" class="small">Workflow</text>
<path class="line" d="M414 206 L442 206" marker-end="url(#rx-f2-arrow)"/>
<circle class="gate" cx="429" cy="206" r="10"/>
<text x="429" y="210" class="gate-num" text-anchor="middle">3</text>
<path class="line" d="M548 206 L576 206" marker-end="url(#rx-f2-arrow)"/>
<path class="runs-as" d="M380 234 L380 246"/>
<rect class="node-account" x="366" y="246" width="28" height="28" rx="6"/>
<g class="icon" transform="translate(372 252) scale(0.6666666666666666)">
<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>
<circle cx="16.5" cy="7.5" r=".5"/>
</g>
<text x="402" y="256" class="small">runs as its</text>
<text x="402" y="270" class="small">tech. account</text>
<rect class="box" x="290" y="290" width="124" height="56" rx="8"/>
<g class="icon" transform="translate(300 301) scale(0.6666666666666666)">
<ellipse cx="12" cy="5" rx="9" ry="3"/>
<path d="M3 5V19A9 3 0 0 0 21 19V5"/>
<path d="M3 12A9 3 0 0 0 21 12"/>
</g>
<text x="322" y="314" class="strong">Deadlines</text>
<text x="300" y="334" class="small">Data Store</text>
<path class="line" d="M312 234 L312 288" marker-end="url(#rx-f2-arrow)"/>
<text x="320" y="266" class="small">copies</text>
<path class="line" d="M274 318 L288 318" marker-end="url(#rx-f2-arrow)"/>
<circle class="node-person" cx="42" cy="318" r="13"/>
<text x="42" y="322" class="initial" text-anchor="middle">B</text>
<circle class="node-person" cx="64" cy="318" r="13"/>
<text x="64" y="322" class="initial" text-anchor="middle">C</text>
<circle class="node-person" cx="86" cy="318" r="13"/>
<text x="86" y="322" class="initial" text-anchor="middle">A</text>
<text x="64" y="352" class="small" text-anchor="middle">Everyone who may</text>
<text x="64" y="368" class="small" text-anchor="middle">open the App</text>
<path class="line" d="M100 318 L168 318" marker-end="url(#rx-f2-arrow)"/>
<circle class="gate" cx="134" cy="318" r="10"/>
<text x="134" y="322" class="gate-num" text-anchor="middle">4</text>
</svg>
</figure>

1. **Catalyst decides who may reach the outside system.** The App calls the Connection as Anna. Anna needs the right to use the Connection herself; the App lends her none. The operation must also list Apps under **Callable by** ("Aufrufbar durch").
2. **The outside system decides what it shows.** It answers with what the account the Connection signed in with may see there.
3. **The Workflow runs as its technical account,** whether a person or a schedule starts it. It can do only what that account may. Whoever publishes it decides what gets copied. A test run of a draft is different: it acts as the person testing, and can do only what both that person and the Workflow's account may. For a Workflow with its own account, that means the rights the draft's steps need, even before the first publish.
4. **Whoever may open the App sees what its queries show.** For an App in a workspace, these are the workspace's members, and the instance's administrators.

So two rules apply:

- **Read live:** the rights of the person looking count.
- **Stored:** like an exported report, the App is the gate. Whoever may open it sees what its queries show, without a right on the Connection. The person who publishes the App needs the right to read the Data Store where the App reads from it, and the right to add rows where the App adds rows.

## Workspaces

A workspace is where a team works together. Members see its shared conversations, open its Apps and use the agents offered there. Private conversations stay private.

Being a member is not building. Editing a workspace's agents and skills is a right of its own, given on the Access page. Someone who only builds need not be a member and sees no conversations. A workspace's Apps are edited by administrators.

<figure class="docs-diagram">
<svg viewBox="0 0 420 340" role="img" aria-labelledby="rx-f3-title rx-f3-desc">
<title id="rx-f3-title">A workspace</title>
<desc id="rx-f3-desc">The workspace Payroll holds conversations, Apps and the agents offered there. Members see and use them. Mia may build there but is not a member: she edits the workspace's agents and sees no conversations.</desc>
<defs>
<marker id="rx-f3-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead" d="M0 0 10 5 0 10z"/>
</marker>
<marker id="rx-f3-arrow-stop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path class="arrowhead-stop" d="M0 0 10 5 0 10z"/>
</marker>
</defs>
<rect class="zone" x="10" y="8" width="400" height="234" rx="12"/>
<text x="26" y="32" class="small-strong">Workspace “Payroll”</text>
<circle class="node-person" cx="60" cy="104" r="14"/>
<text x="60" y="108" class="initial" text-anchor="middle">A</text>
<circle class="node-person" cx="80" cy="104" r="14"/>
<text x="80" y="108" class="initial" text-anchor="middle">B</text>
<circle class="node-person" cx="100" cy="104" r="14"/>
<text x="100" y="108" class="initial" text-anchor="middle">C</text>
<text x="80" y="138" class="small" text-anchor="middle">Members</text>
<text x="80" y="154" class="small" text-anchor="middle">see and use</text>
<rect class="box" x="176" y="46" width="220" height="56" rx="8"/>
<g class="icon" transform="translate(186 57) scale(0.6666666666666666)">
<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>
</g>
<text x="208" y="70" class="strong">Conversations</text>
<text x="186" y="90" class="small">the shared ones; private stay private</text>
<path class="line" d="M126 104 L174 74" marker-end="url(#rx-f3-arrow)"/>
<rect class="box" x="176" y="108" width="220" height="56" rx="8"/>
<g class="icon" transform="translate(186 119) scale(0.6666666666666666)">
<rect width="7" height="7" x="3" y="3" rx="1"/>
<rect width="7" height="7" x="14" y="3" rx="1"/>
<rect width="7" height="7" x="14" y="14" rx="1"/>
<rect width="7" height="7" x="3" y="14" rx="1"/>
</g>
<text x="208" y="132" class="strong">Apps</text>
<text x="186" y="152" class="small">that the workspace owns</text>
<path class="line" d="M126 104 L174 136" marker-end="url(#rx-f3-arrow)"/>
<rect class="box" x="176" y="170" width="220" height="56" rx="8"/>
<g class="icon" transform="translate(186 181) scale(0.6666666666666666)">
<path d="M12 8V4H8"/>
<rect width="16" height="12" x="4" y="8" rx="2"/>
<path d="M2 14h2"/>
<path d="M20 14h2"/>
<path d="M15 13v2"/>
<path d="M9 13v2"/>
</g>
<text x="208" y="194" class="strong">Agents</text>
<text x="186" y="214" class="small">offered here</text>
<path class="line" d="M126 104 L174 198" marker-end="url(#rx-f3-arrow)"/>
<circle class="node-person" cx="70" cy="296" r="16"/>
<text x="70" y="300" class="initial" text-anchor="middle">M</text>
<text x="96" y="290" class="small">Mia may build here</text>
<text x="96" y="306" class="small">but is not a member</text>
<path class="line" d="M226 288 L262 228" marker-end="url(#rx-f3-arrow)"/>
<text x="250" y="268" class="small">edits</text>
<g class="icon icon-stop" transform="translate(96 314) scale(0.5833333333333334)">
<path d="M18 6 6 18"/>
<path d="m6 6 12 12"/>
</g>
<text x="116" y="326" class="small">sees no conversations</text>
</svg>
</figure>

An agent of the whole instance can be offered in several workspaces under **Available in** ("Verfügbar in"). Only someone with the right to edit agents on the whole instance can change where it is offered.

Beside it, **Who may use it** ("Wer ihn verwenden darf") says who chats with the agent where it is offered: everyone who works there, which every agent starts with, or only people and roles given the right **Use** ("Verwenden") on the agent, on the Access page. Both must allow: the right never opens an agent in a workspace where it is not offered, and a deny of Use keeps one person or role from an agent everyone else uses. Instance admins can always use it. Someone without the right does not see the agent in the chat, and a start that names it, also over the API, is refused naming the right.

## Connections

A Connection is signed in with one shared account ("Ein gemeinsames Konto"). Everyone who may use it sees the same in the outside system: what that account sees. If a team should be able to do less, create a second Connection with fewer operations and give the right to use it to each person of that team.

A right on a Connection is given on that one Connection. Writing, deleting and approving Connections stay with the Admin role.
