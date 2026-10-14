---
title: Agents and skills in Studio
description: Create, edit, restore and delete agents and skills in the Studio area, on the whole instance or in the Namespaces you hold rights in.
---

**Studio** is the area of the interface where agents and skills are made. It stands in the main rail as a row of its own and opens at `/build`. The old address `/admin/config` leads there.

Studio works on the [asset API](/reference/api/assets/): it reads a list page by page, reads one asset when its page opens and writes one asset at a time. It never loads the whole set of agents and skills.

## Who sees Studio

The Studio row shows for a person who holds a right on at least one agent or skill:

- `config_assets.read` or `config_assets.write` on the instance, or
- a grant in a [Namespace](/operate/rights-and-namespaces/).

A person with a grant in a Namespace sees the assets of that Namespace and nothing else. A person with no such right has no Studio row, and the address says that Studio is not available.

A grant on one single asset, or on what one workspace owns, is checked by the instance on every read and write. The interface learns only that the person may read some asset of the kind: a read grant gives the Studio row and the list of the kind, which holds the assets the person may read. Such an asset opens read-only. A grant that allows another action and no reading gives no Studio row.

On an instance with the module [`connections`](/configure/modules/#connections) on, Studio also lists Connections for a person who may read every Connection of the instance, which the administrator role allows, and for a person with a read grant on one Connection, who sees that Connection. A read grant written earlier in a Namespace or on a workspace shows the Connections it covers until it is revoked. A grant to use a Connection gives no entry in Studio. A row shows the connector type, whether the instance or a workspace owns the Connection, and whether it is enabled. A row opens the [page of the Connection](#the-page-of-a-connection). The list is **Studio > Connections**; the German interface names it **Studio › Verbindungen**.

## Connecting an outside system

A Connection reaches a remote MCP server. That is the one connector type a Connection made on the instance has: there is no connector for a plain HTTP or REST API. To reach such an API, put an MCP server in front of it, or have the operator add a [custom tool](/extend/custom-tools/) in the client assembly.

1. **New connection** in Studio > Connections takes a name, the server's https address with the path of its MCP endpoint, and the authentication: none, a bearer token, or a key in a header the server names.
2. The key is entered in that form or later on the Connection's page under **Credential** (German: **Zugangsdaten**), with **Enter the key** or **Enter a new key**. It is stored encrypted and never shown again, to anyone. A key is never typed into a chat: an agent cannot take it, and an agent that asks for one is wrong. Give the key on the Connection's page only.
3. The instance reads the tools the server offers. On the Connection's page, accept the operations agents may call. **Test connection** checks the address and the key.
4. Give an agent the tools, as the next section says.

The rights this needs:

| Step | Right |
| --- | --- |
| See Studio > Connections and a Connection's page | `connection.read` |
| Create a Connection, enter or replace its key, test it, accept its operations | `connection.write`, which the administrator role holds; the Access page does not grant it |
| Delete a Connection | `connection.delete`, which the administrator role holds |
| Give an agent a tool of the Connection | `agent.write` on the agent, and `connection.read` to see the Connection in the agent's Tools section |
| Have an agent call the tool | `connection.use` for the person the agent works for: an agent acts with that person's rights |

The administrator role holds every right on Connections. Beside the rights, the operator must have turned the module [`connections`](/configure/modules/#connections) on, listed the server's host in [`egress.allow`](/configure/release-config/#egress) and set a [Secret Store key](/configure/release-config/#secret-store-keys); without the host on the list the save is refused with `egress_denied`. A Connection that comes from the release config is read-only on the instance, and its credential comes from the instance's environment.

## Giving an agent the tools of a Connection

The **Tools** section of an agent's page lists the instance's own tools under **Instance tools** and then, under **Connections**, one group for each Connection you may read (`connection.read`). A group holds a check box for each operation that agents may call and that is enabled and ready, with its description and whether it reads or changes. Ticking a box gives the agent the tool `connection.<name>.<operation>`. A group with more than 12 operations starts folded and shows how many of its operations the agent holds.

A tool the agent already holds whose Connection or operation is gone, switched off, not offered to agents or not visible to you stays on the page in a group **No longer available** at the end of the section. Saving keeps it until you remove it. At run time the agent goes on without such a tool.

The instance checks on save that a name starting with `connection.` has the form `connection.<name>.<operation>`. It does not check that the Connection or the operation exists, because Connections change without a release.

The list is read once when the page opens, in one answer without pages. A Connection accepts at most 100 operations (`CONNECTION_MAX_ACCEPTED_OPERATIONS` in `packages/core/src/connections.ts`).

## The page of a Connection

The page of a Connection shows it and changes nothing. It never shows a credential or a reference to one.

- **Settings**: the connector type, the authentication scheme and the settings of the connector type, as the release config names them.
- **Status**: whether the instance reaches the outside system, when it was last tested, and whether the credential is set, not set or unreadable. A Connection has one credential for everyone who may use it, and the page says so. A Connection with the authentication scheme `none` needs no credential, and the page says that instead.
- **Operations**: each accepted operation with its tool name `connection.<name>.<operation>`, whether it reads or changes, who may call it (agents, Apps, Workflows, outside clients or nobody) and its status. On a Connection made on the instance, a person with `connection.write` opens an operation to outside clients with the check box **Outside clients (CLI, MCP)** (German: **Externe Clients (CLI, MCP)**), and closes it again by clearing it. It is off on every operation until somebody ticks it, because what such a call returns is copied to the computer that holds the key. Only an operation with the status **Ready** can be called. **Awaiting discovery** means the instance has not read it from the outside system yet, **Needs review** that the outside system describes it differently than was accepted, **Unknown** that the outside system does not offer it, and **Disabled** that the release config switches it off.
- **Used by**: the agents that carry a tool of the Connection, of those the reader may read.

**Test connection** asks the connector type to check the Connection and records the answer. It is offered to a person who may change Connections (`connection.write`); a person who may only read sees the recorded state. A test that a policy holds for an approval has not run: it waits in the Inbox.

| Status | What it means | What to do |
| --- | --- | --- |
| Ready | The outside system answered the test. | Nothing. |
| Not tested | Nobody has tested the Connection yet. | Test it. |
| Unauthorized | The outside system refused the credential. | The operator sets a new credential in the instance's environment and restarts the instance. |
| Network denied | The host is not in [`egress.allow`](/configure/release-config/#egress), or it resolves to an address the instance may not reach. | The operator adds the host to `egress.allow`, or for a public HTTPS host on port 443 sets `egress.allowPublicHttps`, and restarts the instance. |
| Unavailable | The outside system did not answer. | Check the address under Settings. It is changed in the release config. |
| Not configured | The credential is missing. | The operator supplies it in the instance's environment and restarts the instance. |
| Credential unreadable | A credential is stored and the instance cannot read it. | The operator restores the Secret Store key it was stored with, or supplies the credential again, and restarts the instance. |
| Failed | The test failed for a reason the instance does not name. | Test again, then ask the operator. |

## The list

Each kind has a list: **Agents** and **Skills**. A row shows the name, the Namespace if the asset is in one, the id and when it was last changed. A row is a link, so it opens in a new tab like any other link.

- **Search** asks the instance for names and ids that contain the text.
- **Namespace** narrows the list to one Namespace. It shows when you hold rights in more than one.
- **Show more** reads the next 50 rows.

The names in the list are in the instance's default language.

## Create

**New agent** or **New skill** opens a dialog for the name and the id. The id follows the name until you change it. It cannot be changed after the asset is saved.

If you hold the write right in a Namespace, the dialog offers that Namespace and the id starts with its prefix. Only Namespaces you may write in are offered. The choice **No Namespace** is offered to people who may write every asset of the instance.

**Continue** opens the page of the new asset. Nothing is stored until you press **Create agent** or **Create skill** there.

## Edit

An asset page has sections, and an index of them beside the content or above it on a narrow window. The save bar appears with the first change. It counts the changed fields and offers **Discard**.

Texts that exist in English and German are written in one language at a time. **Texts in** switches the language for the whole page. The switch marks a language in which texts are still empty. A field left empty in one language shows the text of the other one to people, and the field says so.

If you may read an asset but not change it, the page says so and has no save bar.

### When a save is refused

- **A tool, model or skill that is not allowed.** A Namespace can limit the tools and models of its agents. The refusal stands under the field it concerns, and the form keeps what you typed.
- **Somebody else saved first.** The page saves against the revision it loaded. If the asset changed in between, nothing is overwritten. A notice offers **Load the newer version** and asks before it replaces what you typed, so you can copy what you need first. Until then the page saves nothing. If the newer version cannot be loaded, the page says so and keeps your text.
- **Somebody deleted it.** The notice says that the asset was deleted. Your text stays so that you can copy it, and the notice leads back to the list.
- **A skill you may not read.** An agent can only be given skills you may read yourself. A skill it already has stays when you save other changes.
- **Anything else** is shown in the words of the instance, above the save bar.

## History and restore

**History** opens a panel beside the editor with the saved revisions, the newest first, 50 at a time. **Restore** makes the content of an older revision the newest one. The asset gets a new revision, so a restore can itself be restored. After a restore the page says which revision it restored. While somebody else's newer version waits to be loaded, History restores nothing.

## Delete

**Delete** is in the menu beside History, for people who hold the delete right on the asset. An asset that another one still refers to is not deleted, and the page says which reference stands in the way.

## Limits

| What                                                                 | Value     |
| -------------------------------------------------------------------- | --------- |
| Rows read per list request                                           | 50        |
| Wait after typing before a search                                    | 250 ms    |
| Skills offered per search in an agent's skill picker                 | 50        |
| How long the list of your Namespaces is kept before it is read again | 5 minutes |

The list never holds more than the pages you asked for. The Namespace filter and the create dialog list the Namespaces you hold rights in. History reads 50 revisions of the one asset when it opens, and **Show more** reads the next 50.
