---
title: Connect a system
description: Connect an outside system through its MCP server, enter its key, test it, and let an agent use it.
---

A Connection lets agents work in another system, such as your CRM or ticket tool. You set it up once in Studio. After that, every agent you give its tools can read or change things there, with the rights of the person it works for.

The German interface shows the labels in quotes.

## Before you start

- The system needs an **MCP server** reachable over HTTPS. That is the only kind of connection today. A system that only has a plain HTTP or REST API needs an MCP server in front of it, or the operator adds a custom tool.
- You need the address of its MCP endpoint, such as `https://crm.example.com/mcp`, and its key or token if it asks for one.
- You need to be an administrator. Creating a Connection, entering its key and testing it are rights of the administrator role.
- The operator must allow the instance to reach the server's host. If it does not, the test says **Network denied** ("Netzwerk gesperrt"); ask the operator.
- The operator must have set up a key store for credentials (a Secret Store key). Without it the key you enter is not kept, and **Credential** shows **Not set** ("Nicht gesetzt"). If that happens, ask the operator.

## Create the Connection

1. Open **Studio** and choose **Connections** ("Verbindungen").
2. Click **New connection** ("Neue Verbindung"). Give it a name people will recognise, such as "CRM". The ID below it follows the name; keep it or change it now, as it cannot change later. Click **Continue** ("Weiter").
3. Under **Server** enter the **Server address** ("Serveradresse"): the https address of the MCP endpoint.
4. Under **Authentication** ("Authentifizierung") choose what the server expects:
   - **None** ("Keine"),
   - **Bearer token** ("Bearer-Token"), or
   - **Key in a header** ("Schlüssel in einem Header"), with the **Header name** the server documents.
5. Paste the key into **Key** ("Schlüssel").
6. Click **Create connection** ("Verbindung anlegen").

The key is stored encrypted and is never shown again, to anyone. Later you replace it on the Connection's page under **Credential** ("Zugangsdaten") with **Enter a new key** ("Neuen Schlüssel eingeben").

Never type a key into a chat. An agent cannot take it from there, and an agent that asks you for one is wrong.

## Choose what agents may do

The instance asks the server which tools it offers. On the Connection's page, **Discovered tools** ("Gefundene Tools") lists them. Each says whether it only reads or also changes something.

1. For each tool you want, check **What it does** ("Was es tut"): **Reading** ("Lesend") or **Changing** ("Ändernd").
2. **Agents can use it** ("Agenten dürfen es nutzen") is already ticked. Untick it if agents should not call this tool.
3. Click **Accept** ("Akzeptieren"). The tool moves to **Operations** ("Operationen").

Accept only what you need. You can **Remove** ("Entfernen") an operation later.

If the server adds tools later, click **Read tools again** ("Tools neu lesen").

## Test it

Click **Test connection** ("Verbindung testen"). The **Status** shows **Ready** ("Bereit") when the server answered with the key you gave. Any other status says on the page what to do. The most common:

| Status | What to do |
| --- | --- |
| **Unauthorized** ("Nicht autorisiert") | The server refused the key. Enter a new key under **Credential**, then test again. |
| **Not configured** ("Nicht konfiguriert") | No key yet. Enter it under **Credential**, then test again. |
| **Unavailable** ("Nicht erreichbar") | The server did not answer. Check the address under **Settings** ("Einstellungen"). |
| **Network denied** ("Netzwerk gesperrt") | The instance may not reach this host. Ask the operator to allow it. |

[The page of a Connection](/configure/build/#the-page-of-a-connection) lists every status.

## Give an agent the tools

1. In **Studio**, open **Agents** ("Agenten") and the agent.
2. Go to the **Tools** section ("Werkzeuge"). Under **Connections** ("Verbindungen") there is a group for your Connection.
3. Tick the operations this agent may use, and save.

Only operations that are ready and allowed for agents appear here.

## Let people use it

An agent acts with the rights of the person it works for. So the person who chats needs the right to use the Connection too. Administrators have it. For anyone else:

1. Open **Settings > Instance > Access** ("Einstellungen › Instanz › Zugriff").
2. Click **New right** ("Neues Recht") and choose **Use connections**: "Let agents this person builds or runs call the outside system through it." Pick the person and the Connection.

**Read connections** lets someone see the Connection and its status in Studio, never its key.

## Good to know

- One key serves everyone who may use the Connection. The outside system sees every call as that one account, and the instance records who asked for it.
- A Connection set up by the operator in the release config opens read-only. Changes to it go through the operator.
- A Connection cannot be deleted while an agent still has one of its tools or an App uses it. Take the tools off the agents and the Connection out of the Apps first.
