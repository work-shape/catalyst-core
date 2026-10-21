---
title: Connect a system
description: Connect an outside system through its MCP server, enter its key, test it, and let an agent use it.
---

A Connection lets agents work in another system, such as your CRM or ticket tool. You set it up once in Studio. After that, every agent you give its tools can read or change things there, with the rights of the person it works for.

The German interface shows the labels in quotes.

## Before you start

- The system needs an **MCP server** reachable over HTTPS, which this page sets up. A system with a REST interface that is read by GET is connected with its operations declared, as [Connecting an outside system](/configure/build/#connecting-an-outside-system) shows; one that must be written to needs a [custom tool](/extend/custom-tools/).
- An agent that sets up a Connection with you first checks which kinds of Connection this instance can make. For a system you sign in to with the provider's own sign-in (OAuth), such as a mailbox, it uses the provider's MCP server where there is one, and drafts no REST tools that could never sign in.
- You need the address of its MCP endpoint, such as `https://crm.example.com/mcp`, and its key or token if it asks for one.
- You need to be an administrator. Creating a Connection, entering its key and testing it are rights of the administrator role.
- The operator must allow the instance to reach the server's host. If it does not, the test says **Network denied** ("Netzwerk gesperrt"); ask the operator.
- The operator must have set up a key store for credentials (a Secret Store key). Without it the key you enter is not kept, and **Credential** shows **Not set** ("Nicht gesetzt"). If that happens, ask the operator.

## Create the Connection

1. Open **Studio** and choose **Connections** ("Verbindungen").
2. Click **New connection** ("Neue Verbindung"). Give it a name people will recognise, such as "CRM". Its id, under **Technical details** ("Technische Details"), follows the name and is checked while you type; keep it or change it now, as it cannot change later. Click **Continue** ("Weiter").
3. Under **Server** enter the **Server address** ("Serveradresse"): the https address of the MCP endpoint.
4. Under **Authentication** ("Authentifizierung") choose what the server expects:
   - **None** ("Keine"),
   - **Bearer token** ("Bearer-Token"), or
   - **Key in a header** ("Schlüssel in einem Header"), with the **Header name** the server documents.
5. Paste the key into **Key** ("Schlüssel").
6. Click **Create connection** ("Verbindung anlegen").

The key is stored encrypted and is never shown again, to anyone. Later you replace it on the Connection's page under **Credential** ("Zugangsdaten") with **Enter a new key** ("Neuen Schlüssel eingeben").

Never type a key into a chat. An agent cannot take it from there, and an agent that asks you for one is wrong.

### Let the agent set it up from the chat

You can also ask an agent in the chat to connect a system. An agent that may propose Connections answers with a card, **Connect …** ("… verbinden"), and opens the New connection dialog for you, filled with the name, the id and the address, with the chat beside it. You check the fields, enter the key or sign in there, and click **Connect** ("Verbinden"); nothing is saved before that. The card stays in the chat and opens the dialog again with **Set up connection** ("Verbindung einrichten").

When you have approved the tools, your chat gets a message from you that says what is connected and which tools you approved, such as "Brain ist verbunden (brain), 12 Werkzeuge freigegeben für Agenten: …". It holds no key and no address. The agent reads it and goes on with what you asked for.

## Choose what agents may do

The instance asks the server which tools it offers. On the Connection's page, **Discovered tools** ("Gefundene Tools") lists them. Each says whether it only reads or also changes something.

1. For each tool you want, check **What it does** ("Was es tut"): **Reading** ("Lesend") or **Changing** ("Ändernd").
2. **Agents can use it** ("Agenten dürfen es nutzen") is already ticked. Untick it if agents should not call this tool.
3. Click **Accept** ("Akzeptieren"). The tool moves to **Operations** ("Operationen").

Accept only what you need. You can **Remove** ("Entfernen") an operation later.

If the server adds tools later, click **Read tools again** ("Tools neu lesen").

## Test it

Click **Test connection** ("Verbindung testen"). The **Status** shows **Ready** ("Bereit") when the server answered with the key you gave. Any other status says on the page what to do. The most common:

| Status                                    | What to do                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| **Unauthorized** ("Nicht autorisiert")    | The server refused the key. Enter a new key under **Credential**, then test again. |
| **Not configured** ("Nicht konfiguriert") | No key yet. Enter it under **Credential**, then test again.                        |
| **Unavailable** ("Nicht erreichbar")      | The server did not answer. Check the address under **Settings** ("Einstellungen"). |
| **Network denied** ("Netzwerk gesperrt")  | The instance may not reach this host. Ask the operator to allow it.                |

[The page of a Connection](/configure/build/#the-page-of-a-connection) lists every status.

## Give an agent the tools

**Give to an agent** ("Einem Agenten geben") gives all the operations allowed for agents to one agent in one step. It is offered on the Connection's page after you approve operations, and as a card in a chat when an agent offers it: pick the agent and confirm. An agent that builds an App or a Workflow on the Connection offers you this card for itself first, so it can try the operations before it builds.

To give only some of the operations, open the agent in **Studio > Agents** ("Agenten"), go to **Tools** ("Werkzeuge"), tick the operations under **Connections** ("Verbindungen") and save. Only operations that are ready and allowed for agents appear there.

## Let people use it

An agent acts with the rights of the person it works for. So the person who chats needs the right to use the Connection too. Administrators have it. For anyone else:

1. Open **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff").
2. Click **New right** ("Neues Recht"), choose **Connections** and the level **Use** ("Verwenden"): "Let agents this person builds or runs call the outside system through it." Pick the person and the Connection.

**Read connections** lets someone see the Connection and its status in Studio, never its key.

## Good to know

- One key serves everyone who may use the Connection. The outside system sees every call as that one account, and the instance records who asked for it.
- A Connection set up by the operator in the release config opens read-only. Changes to it go through the operator.
- A Connection cannot be deleted while an agent still has one of its tools or an App uses it. Take the tools off the agents and the Connection out of the Apps first.

## Person context on a shared REST key

An HTTP API Connection can set `settings.personContextHeader` to the header its outside system uses to select a person's data. This is off by default. The name must not carry credentials or collide with a fixed, authentication or transport header.

On the Connection page, an administrator maps each person and each service principal to its outside value. A call sends the acting identity's mapping, including when a chat agent works for a person. A live Workflow sends its own service principal's value; a live child Workflow sends its own principal's value. The publisher and the person starting a live run contribute no mapping. A test run sends the tester's own mapped value on both the root and child runs. A Workflow with an unmapped principal cannot be published. Every call checks again, so removing a mapping stops subsequent calls. A missing mapping is refused as `person_context_unmapped` before any request reaches the outside system; the header is never omitted.

Mappings are bound to the Connection's origin and header. Changing either requires mapping again. Only `connection.write` holders may read or change them; `connection.use` remains required for calls. Mapping values are runtime data in `connection_bindings`, with no token or secret handle, and are not exported as config. They remain until the Connection is deleted; removing one revokes it and clears its value while preserving its version. The audit event `connection.person_context_set` names the identity and Connection and whether it was mapped, never the value. Operation Runs keep no mapping value. Mapping values leave only for the configured outside origin, whose retention and region follow the customer's provider agreement. Returned data follows the existing retention and model-region rules for Connection results.

Person context is not available in Apps yet. App exposure (`bridge`) is refused while a Connection has person context enabled: remove App exposure before setting the header, or remove the header before enabling App exposure. Release config that sets both stops the instance at startup. Any call an App action makes of such a Connection is refused as `person_context_app_unavailable` before any request reaches the outside system, also when an agent calls the action as its tool. An agent's own call of the Connection still sends the mapped value.

This selects data at the source. It does not retract copied data or replace App data-isolation guards. Enable it for a real provider only after confirming that the shared key may send that header and that the source enforces the intended rights.
