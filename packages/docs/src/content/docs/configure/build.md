---
title: Agents and skills in Studio
description: Create, edit, restore and delete agents and skills in Studio, connect outside systems, and read the other lists Studio holds.
---

**Studio** is the area of the interface where agents and skills are made. It stands in the main rail as a row of its own and opens at `/build`. The old address `/admin/config` leads there. Beside **Agents** (German: **Agenten**) and **Skills**, Studio lists **Connections** (**Verbindungen**), **Data stores** (**Datenspeicher**), **Knowledge bases** (**Wissensbasen**) and **Guardrails** (**Leitplanken**), each for a person who may read one. Apps and Workflows are not in Studio: each has a row of its own in the main rail.

Studio works on the [asset API](/reference/api/assets/): it reads a list page by page, reads one asset when its page opens and writes one asset at a time. It never loads the whole set of agents and skills.

## Who sees Studio

The Studio row shows for a person who holds a right on at least one agent or skill:

- `config_assets.read` or `config_assets.write` on the instance, or
- a [grant](/operate/rights-for-one-person/) in a Shared Workspace or on one asset.

A person with no such right has no Studio row, and the address says that Studio is not available.

A grant on one single asset, or on what one workspace owns, is checked by the instance on every read and write. The interface learns only that the person may read some asset of the kind: a read grant gives the Studio row and the list of the kind, which holds the assets the person may read. Such an asset opens read-only. A grant that allows another action and no reading gives no Studio row.

On an instance with the module [`connections`](/configure/modules/#connections) on, Studio also lists Connections for a person who may read every Connection of the instance, which the administrator role allows, and for a person with a read grant on one Connection, who sees that Connection. A read grant written earlier on a workspace shows the Connections it covers until it is revoked. A grant to use a Connection gives no entry in Studio. A row shows the connector type, whether the instance or a workspace owns the Connection, and whether it is enabled. A row opens the [page of the Connection](#the-page-of-a-connection). The list is **Studio > Connections**; the German interface names it **Studio › Verbindungen**.

## Connecting an outside system

[Connect a system](/connect/connect-a-system/) walks through these steps for the person who sets it up.

A Connection reaches a remote MCP server (connector type `mcp`) or a REST interface that it reads by GET (connector type `http_api`). An MCP server lists its tools itself. A REST interface lists nothing: each operation is declared in the Connection's definition with its path and parameters, as [release config](/configure/release-config/#a-rest-interface-http_api) shows. A person pastes such declarations as YAML into the approval list, or asks the agent beside the page to draft them from a vendor's public OpenAPI description. An agent that holds `platform.connections.draft_tools` checks its draft as a save would (GET only, the effect `reading`, no header or parameter that can carry a credential, no `.` or `..` path segment) and refuses a schema that carries a value of its own (`default`, `const`, `examples`, `example` or an `enum` with only one value, at any depth). It answers the draft as a card in the conversation; the card names the tools and holds the Connection's id, address and header names, never a key, and an existing Connection by its own title. Its button opens the Connection's approval list with the draft, which shows each tool's request, the description an agent reads and each parameter's allowed enum values, folded where long, for drafted and pasted declarations, or, for an id no Connection has, the New connection dialog filled with it. The person's approval there is the save: an agent never saves a Connection. A REST interface that must be written to needs a [custom tool](/extend/custom-tools/) in the client assembly.

1. **New connection** in Studio > Connections takes a name, the server's https address with the path of its MCP endpoint, and the authentication: none, a bearer token, or a key in a header the server names.
2. The key is entered in that form or later on the Connection's page under **Credential** (German: **Zugangsdaten**), with **Enter the key** or **Enter a new key**. It is stored encrypted and never shown again, to anyone. A key is never typed into a chat: an agent cannot take it, and an agent that asks for one is wrong. Give the key on the Connection's page only.
3. The instance reads the tools the server offers. On the Connection's page, accept the operations agents may call. **Test connection** checks the address and the key.
4. Give an agent the tools, as the next section says.

The rights this needs:

| Step                                                                          | Right                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| See Studio > Connections and a Connection's page                              | `connection.read`                                                                                    |
| Create a Connection, enter or replace its key, test it, accept its operations | `connection.write`, which the administrator role holds; the Access page does not grant it            |
| Delete a Connection                                                           | `connection.delete`, which the administrator role holds                                              |
| Give an agent a tool of the Connection                                        | `agent.write` on the agent, and `connection.read` to see the Connection in the agent's Tools section |
| Give an agent the approved tools with **Give to an agent**                     | `agent.write` and `agent.publish` on the agent, and `connection.read`                                |
| Have an agent call the tool                                                   | `connection.use` for the person the agent works for: an agent acts with that person's rights         |

The administrator role holds every right on Connections. Beside the rights, the operator must have turned the module [`connections`](/configure/modules/#connections) on, listed the server's host in [`egress.allow`](/configure/release-config/#egress) and set a [Secret Store key](/configure/release-config/#secret-store-keys); without the host on the list the save is refused with `egress_denied`. A Connection that comes from the release config is read-only on the instance, and its credential comes from the instance's environment.

## Giving an agent the tools of a Connection

The **Tools** section of an agent's page lists the instance's own tools under **Instance tools** and then, under **Connections**, one group for each Connection you may read (`connection.read`). A group holds a check box for each operation that agents may call and that is enabled and ready, with its description and whether it reads or changes. Ticking a box gives the agent the tool `connection.<name>.<operation>`. A group with more than 12 operations starts folded and shows how many of its operations the agent holds, and so does every group the agent holds nothing of when there are more than 6 groups.

**Give to an agent** (German: **Einem Agenten geben**) gives all of a Connection's approved tools to one agent in one step. It is offered after you approve operations that agents may call, in the **New connection** dialog and on the Connection's page, and on a card in a conversation when an agent that holds `platform.connections.offer_to_agent` offers it. It lists only the instance's agents you may change and publish. Before anything changes, it names the agent and the tools, and your confirmation publishes the agent as one new revision with them added: rights, approval policy and audit are those of a publish on the agent's page. Every conversation with the agent, the one you are in included, can use the tools from its next message.

If another person has an unpublished draft of the agent, the give is refused and names them. Nothing is written, and **Open** leads to the agent's page. If you have a draft of your own, the tools are added to it, and it is published only if you tick **Publish the whole draft now**, which publishes your other changes with them. A draft of yours that is based on an older published version is refused until you bring it up to date or discard it on the agent's page. A publish an approval policy holds waits in the Inbox.

A tool the agent already holds whose Connection or operation is gone, switched off, not offered to agents or not visible to you stays on the page in a group **No longer available** at the end of the section. Saving keeps it until you remove it. At run time the agent goes on without such a tool.

The instance checks on save that a name starting with `connection.` has the form `connection.<name>.<operation>`. It does not check that the Connection or the operation exists, because Connections change without a release.

The list is read once when the page opens, in one answer without pages. A Connection accepts at most 100 operations (`CONNECTION_MAX_ACCEPTED_OPERATIONS` in `packages/core/src/connections.ts`).

## The page of a Connection

A Connection made in Studio is changed on its page by a person who may change Connections (`connection.write`): its address and authentication under **Settings**, its key under **Credential**, and the operations agents may call. A Connection that comes from the release config opens read-only and says so; it is changed in the release config. The page never shows a credential or a reference to one.

- **Settings**: the connector type, the authentication scheme and the settings of the connector type.
- **Status**: whether the instance reaches the outside system, when it was last tested, and whether the credential is set, not set or unreadable. A Connection has one credential for everyone who may use it, and the page says so. A Connection with the authentication scheme `none` needs no credential, and the page says that instead.
- **Operations**: each accepted operation with its tool name `connection.<name>.<operation>`, whether it reads or changes, who may call it (agents, Apps, Workflows, outside clients or nobody) and its status. On a Connection made on the instance, a person with `connection.write` opens an operation to outside clients with the check box **Outside clients (CLI, MCP)** (German: **Externe Clients (CLI, MCP)**), and closes it again by clearing it. It is off on every operation until somebody ticks it, because what such a call returns is copied to the computer that holds the key. Only an operation with the status **Ready** can be called. **Awaiting discovery** means the instance has not read it from the outside system yet, **Needs review** that the outside system describes it differently than was accepted, **Unknown** that the outside system does not offer it, and **Disabled** that the operator switched it off. On a Connection made in Studio, **Accept new description** clears **Needs review**, and **Remove** takes an operation away.
- **Discovered tools** (German: **Gefundene Tools**), for a person who may change the Connection: the tools the server offers. For each, check **What it does** (**Was es tut**: Reading or Changing), untick **Agents can use it** (**Agenten dürfen es nutzen**) if agents should not call it, then **Accept** (**Akzeptieren**) to add it as an operation. **Read tools again** asks the server once more.
- **Used by**: the agents that carry a tool of the Connection, of those the reader may read.
- **Additional use rights**: the people and service principals given a right on this Connection itself. Workspace members use it through **Available in** and are not listed here.

**Test connection** asks the connector type to check the Connection and records the answer. It is offered to a person who may change Connections (`connection.write`); a person who may only read sees the recorded state. A test that a policy holds for an approval has not run: it waits in the Inbox.

What to do depends on where the Connection comes from. A Connection made in Studio is repaired on its page; one from the release config needs the operator.

| Status                | What it means                                                                                                                    | Made in Studio                                                                                                                                  | From the release config                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ready                 | The outside system answered the test.                                                                                            | Nothing.                                                                                                                                        | Nothing.                                                                                                                    |
| Not tested            | Nobody has tested the Connection yet.                                                                                            | Test it.                                                                                                                                        | Test it.                                                                                                                    |
| Testing               | A test runs.                                                                                                                     | Wait for it.                                                                                                                                    | Wait for it.                                                                                                                |
| Unauthorized          | The outside system refused the credential.                                                                                       | Enter a new key under **Credential**, then test again.                                                                                          | The operator sets a new credential in the instance's environment and restarts the instance.                                 |
| Network denied        | The host is not in [`egress.allow`](/configure/release-config/#egress), or it resolves to an address the instance may not reach. | The operator adds the host to `egress.allow`, or for a public HTTPS host on port 443 sets `egress.allowPublicHttps`, and restarts the instance. | The same.                                                                                                                   |
| Unavailable           | The outside system did not answer.                                                                                               | Check the address under **Settings** and change it if it is wrong.                                                                              | Check the address under **Settings**. The operator changes it in the release config.                                        |
| Not configured        | The credential is missing.                                                                                                       | Enter the key under **Credential**, then test again.                                                                                            | The operator supplies it in the instance's environment and restarts the instance.                                           |
| Credential unreadable | A credential is stored and the instance cannot read it.                                                                          | Enter the key again under **Credential**, then test again.                                                                                      | The operator restores the Secret Store key it was stored with, or supplies the credential again, and restarts the instance. |
| Failed                | The test failed for a reason the instance does not name.                                                                         | Test again, then ask the operator.                                                                                                              | Test again, then ask the operator.                                                                                          |

## The list

Each kind has a list. For **Agents** and **Skills** a row shows the name, the id and when it was last changed. A row is a link, so it opens in a new tab like any other link.

- **Search** asks the instance for names and ids that contain the text.
- **Show more** reads the next 50 rows.

The names in the list are in the instance's default language.

## Create

Where no agent that builds is offered, **New agent** or **New skill** opens a dialog that asks for the name, and for an agent what it should do. Its address, the id, is made from the name under **Advanced** and follows the name until you change it. It is checked while you type: a taken address, or one the kind does not allow, is named at the field, the fold opens, and **Continue** waits until it is fixed. The address cannot be changed after the asset is saved.

An asset made while you work in a Shared Workspace belongs to that workspace, and a right in the workspace covers it. See [What a workspace owns](/operate/how-rights-work/#what-a-workspace-owns).

**Continue** opens the page of the new asset. Nothing is stored until you press **Create agent** or **Create skill** there.

## Building from chat

The Build Agent reports only actions confirmed by successful tool results. A table in chat,
an HTML preview, generated SQL or a saved migration does not prove a record was inserted,
changed or found. A draft is not published, a simulated test is not a live write, and a call
waiting for Allow has saved nothing.

A request to keep a table creates a **Data Store draft**: `store.yaml` and a migration
that creates a table with a primary key and no rows. Until a person publishes it, no row is
stored. Example rows requested in chat are ordinary data; `seed/` fills only a test copy.

After publication, continue the conversation about that store. An agent with platform tools
is offered that ready store's `describe`, `query`, `preview_rows`, `insert`, `update` and
`delete_rows` tools. An agent reads or changes rows only with a `data_store.<store>.<verb>` tool in its list; it may also carry row tools explicitly in its definition. Tools
grant no rights. Each write asks for confirmation by default and the preview shows the
frozen keys and values. `insert` is reversible; changes and deletion are irreversible and cannot use a remembered allow decision.
A declined or pending confirmation changes no row. The agent reports a write only from the
tool's confirmed count, and reports when a query was `truncated`, paging before concluding
that a row is absent.

Without the tool, the agent says that no row was stored. Publish the Data Store and continue
a conversation about it, or publish and use an App or Workflow that writes rows. The Data
Store page under **Studio > Data stores** (German: **Studio > Datenspeicher**) shows the store
and its rows. It has no row editor: continue the conversation about the store to write rows. A table managed by `records` accepts corrections through records review.
A structured Knowledge Base may read described tables with `knowledge.query` where available.

Creating an agent or skill from chat is live at once and requires confirmation of the exact
call. Existing agents save a shared draft that a person publishes; existing skills are changed
on their page or through a skill change request. The save's `workspaceId` is the actual owner,
not a name prefix such as `team-`. Without a workspace id the owner is the instance. To build in
another workspace, switch to it before starting its Build conversation.

A newly created agent is available nowhere. Open **Studio > Agents > the agent > Available in >
Selected workspaces**, choose the requested shared workspace, then **Save changes**. In German:
**Studio > Agenten > the agent > Verfügbar in > Ausgewählte Arbeitsbereiche**, choose the workspace,
then **Änderungen speichern**. **Personal workspaces** includes every person's personal workspace;
it is not a selector for one person's workspace. Availability belongs to the instance: a person who may change
agents across the instance performs this step if you lack the right. Changes to an existing agent's draft also need **Publish** (**Veröffentlichen**).
Knowledge Bases and Connections the agent uses need the same workspaces under their own **Available in**. Publish and **Available in** list any that are missing; a person who may change them can tick **Make them available there too** (**Dort auch verfügbar machen**), anyone else is told which admins to ask.

For orientation, point to the places enabled for the person: **Workflows**, **Apps**, **Inbox**
(**Eingang**), and Studio's **Agents**, **Skills**, **Connections** (**Verbindungen**),
**Data stores** (**Datenspeicher**) and **Knowledge Bases** (**Wissensbasen**). On an agent page,
**Knowledge** (**Wissen**) selects its Knowledge Bases. A Knowledge Base is a **Wissensbasis**, plural **Wissensbasen**.

## Edit

An asset page has sections, and an index of them beside the content or above it on a narrow window. The save bar appears with the first change. It counts the changed fields and offers **Discard**.

Texts that exist in English and German are written in one language at a time. **Texts in** switches the language for the whole page. The switch marks a language in which texts are still empty. A field left empty in one language shows the text of the other one to people, and the field says so.

If you may read an asset but not change it, the page says so and has no save bar.

### The files of a skill

A skill's page shows the skill as a folder under **Files**: `SKILL.md`, which holds the instructions, and the files below `references/`, `scripts/` and `assets/`. The **+** of a folder uploads a file into it or starts a new, empty one; the type of a file is read from its name. A text file, such as a reference or a script, is edited in place. Any file can be renamed, replaced with a new version, downloaded and deleted, and the page shows its size and, once saved, its SHA-256 hash. A file that is not text is not shown, only replaced.

The changes are saved with the save bar like any other field. Where a file beside the instructions changed, the save writes the whole folder; otherwise it writes the text alone and the other files stay. The instance holds the limits and says which one a save broke, with the path of the file: a file of more than 2 MiB, more than 500 files or 8 MiB in a skill, a compiled program, or a file under `scripts/` that is not UTF-8 text. See [A skill as a folder of files](/configure/config-assets/#a-skill-as-a-folder-of-files).

### When a save is refused

- **A tool, model or skill that is not allowed.** For example a tool the instance does not enable, or a model setting you may not change. The refusal stands under the field it concerns, and the form keeps what you typed.
- **Somebody else saved first.** The page saves against the revision it loaded. If the asset changed in between, nothing is overwritten. A notice offers **Load the newer version** and asks before it replaces what you typed, so you can copy what you need first. Until then the page saves nothing. If the newer version cannot be loaded, the page says so and keeps your text.
- **Somebody deleted it.** The notice says that the asset was deleted. Your text stays so that you can copy it, and the notice leads back to the list.
- **A skill you may not read.** An agent can only be given skills you may read yourself. A skill it already has stays when you save other changes.
- **A file of a skill that is not allowed.** The refusal names the file and stands under the files of the skill.
- **Anything else** is shown in the words of the instance, above the save bar.

## History and restore

**History** opens a panel beside the editor with the saved revisions, the newest first, 50 at a time. **Restore** makes the content of an older revision the newest one. The asset gets a new revision, so a restore can itself be restored. After a restore the page says which revision it restored. While somebody else's newer version waits to be loaded, History restores nothing.

## Delete

**Delete** is in the menu beside History, for people who hold the delete right on the asset. An asset that another one still refers to is not deleted, and the page says which reference stands in the way.

## Limits

| What                                                 | Value  |
| ---------------------------------------------------- | ------ |
| Rows read per list request                           | 50     |
| Wait after typing before a search                    | 250 ms |
| Skills offered per search in an agent's skill picker | 50     |

The list never holds more than the pages you asked for. History reads 50 revisions of the one asset when it opens, and **Show more** reads the next 50.
