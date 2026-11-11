---
title: Add your own MCP server
description: Add an MCP server for yourself under You > Connections, sign in to it or paste its token, choose its tools, and use them in your private chats.
---

You can add an MCP server that only you use, such as a notes service you have an account with. Its tools then join your agents in your private chats. Nobody else uses it, sees its tools or reaches your account there.

The German interface shows the labels in quotes.

## Before you start

- You need the address of the server's MCP endpoint, such as `https://notes.example.com/mcp`. Its service documents it.
- The server signs you in with OAuth and registers its clients itself (Dynamic Client Registration), or takes a token its service gives you, such as an API key. A server that asks for no sign-in at all cannot be added.
- The address must be public `https` on port 443. A server on a private network or on another port is refused unless the operator lists it.
- Your role holds **Add your own MCP server** (`connection.add_own`). The built-in role `user` holds it; an administrator can take it away.
- You are signed in to the instance in the browser. A key, the CLI and an embedding host cannot add a server.

## Add the server

1. Open **Settings**, then **You** ("Du") and **Connections** ("Verbindungen").
2. Under **Your MCP servers** ("Deine MCP-Server") click **Add MCP server** ("MCP-Server hinzufügen").
3. Enter the **Address** ("Adresse") and click **Connect** ("Verbinden"). The instance saves the server and asks it, without any credential, what it needs.
4. The dialog shows **Sign in to …** ("Anmeldung bei …") with the host of the service. Click the button: the service's sign-in opens in another tab. Sign in there and allow the access it asks for. The tab closes and the dialog goes on.
5. The instance reads the server's tools with your sign-in. Each shows what it does: **reads** ("liest") or **changes** ("ändert"). Tools that only read start ticked. Tick what your agents may use. A tool the server does not mark as read-only always counts as changing; one it marks so you may set to **changes** yourself.
6. Change the **Name** if you like and click **Done** ("Fertig").

### With a token instead of a sign-in

A server that asks for a token shows **Token for …** ("Token für …") in place of the sign-in. A server that offers a sign-in may take a token too: click **Paste a token instead** ("Stattdessen Token einfügen").

1. Paste the token the service gave you into **Token** and click **Set token** ("Token setzen").
2. The token goes as `Authorization: Bearer …`. A service that wants it under a header of its own names that header: open **Technical details** ("Technische Details") and enter its name under **Header**.
3. The instance reads the server's tools with your token, and you go on at step 5 above.

The token is stored encrypted and is never shown again, to you or anyone. It is sent only to the address you added: a redirect to another host never gets it. If the server refuses it, the dialog asks for it again. Your agents never see it.

The server now shows as a card with its host, its state and how many tools you chose. From your next message on, your agents can use those tools in your private chats, in a group of their own.

If the address is refused, the dialog says why at the field: it is not a web address, holds a name or password, is not reached by the instance, or answers as no MCP server. A refused server is not kept.

## Let an agent start it in a chat

In a chat only you read, you can ask any agent to set up your server, such as "add my notes service". The agent answers with a card **Add MCP server** ("MCP-Server hinzufügen") that names the server and its host. **Open** ("Öffnen") takes you to **Connections** with the add dialog filled with the name and address; while you watch the agent's answer, it opens by itself, with the chat beside it. From there you go on as above: nothing is saved before you click **Connect**, and the sign-in, the tools and **Done** are yours. Once you click **Done**, the chat gets a message from you with the server's name and the tools you chose, and the agent can use them from your next message.

The agent never sees a sign-in or a token, never saves the server and never chooses its tools. It offers this only where you may add a server yourself, never in a chat others read, a Workflow or a run started with a key. An agent whose publisher turned own servers off for it does not offer it.

## Each change asks first

A tool that only reads runs when an agent calls it. A tool that changes something asks you before each call, with the card you know from other tools. Choose **Always allow** ("Immer erlauben") on that card to let it run without asking, for you alone.

A chat in which a tool of another Connection ran asks again, whatever you chose. So does a tool whose description or input changed since you chose it, until you accept the new one under **Change tools**.

## Change tools, sign in again, remove

On the server's card:

- **Change tools** ("Tools ändern") shows its tools again. Tick or untick them and click **Save** ("Speichern"). **Read tools again** ("Tools neu lesen") asks the server for its current tools. A tool you always allow shows **Always allow** ("Immer erlauben"); **Ask again** ("Wieder fragen") takes it back. A tool the server changed shows **Needs review** ("Prüfung nötig") and **Accept new description** ("Neue Beschreibung akzeptieren"); it runs again once you accept it and save.
- **Sign in again** ("Neu anmelden") shows when the service ended your sign-in.
- **Replace token** ("Token ersetzen") takes a new token. **Token missing** ("Token fehlt") shows when the server refused yours, or after you moved the server to another address or changed how the token is sent: both delete it. **Set token** ("Token setzen") pastes a new one.
- **Remove** ("Entfernen") ends your sign-in or deletes your token, and deletes the server, after one question.

**Switched off** ("Abgeschaltet") means an administrator or the operator stopped the server. Its tools are not used, and nothing is contacted. You can still remove it.

## What others see

An administrator sees that you added a server, with its host, and can switch it off or delete it. They never see what your agents sent to it or what it answered, and cannot use it. The audit log keeps what was decided, such as the adding, the sign-in, a token set or refused and your Always allow, never a token or what a call carried.

## For operators

`modules.connections.ownServers` in release config governs this:

```yaml
modules:
  connections:
    enabled: true
    ownServers:
      enabled: true # default; false stops every self-added server without deleting it
      perPerson: 10 # default; how many servers one person adds
      publicHttps: true # default; false admits only hosts a `public` entry of egress.allow names
```

A self-added server never reaches a private address, the Platform Store or the instance itself, whatever `egress.allow` lists.
