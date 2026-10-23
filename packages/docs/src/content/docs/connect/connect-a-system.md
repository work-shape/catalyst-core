---
title: Connect a system
description: Connect an outside system through its MCP server, enter its key, test it, and let an agent use it.
---

A Connection lets agents work in another system, such as your CRM or ticket tool. You set it up once in Studio. After that, every agent you give its tools can read or change things there, with the rights of the person it works for.

The German interface shows the labels in quotes.

## Before you start

- The system needs an **MCP server** reachable over HTTPS, which this page sets up. A system with a REST interface that is read by GET is connected with its operations declared, as [Connecting an outside system](/configure/build/#connecting-an-outside-system) shows; one that must be written to needs a [custom tool](/extend/custom-tools/).
- An agent that sets up a Connection with you first checks which kinds of Connection this instance can make. For a system you sign in to with the provider's own sign-in (OAuth), such as a mailbox, it uses the provider's MCP server where there is one. Otherwise it proposes a REST API, and you choose the OAuth sign-in in the dialog and enter the provider's addresses and the client of an app you registered with the provider.
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

## Personal OAuth bindings

A runtime Connection can select `credentialMode: user` with `authScheme: oauth` on `http_api` or `mcp`. Its operations accept exposure `agent` only. The mode is fixed when the Connection is created; a change returns `credential_mode_fixed`. Release-config Connections remain `shared`.

The Connection's own secret is the OAuth client secret. Each person with `connection.use` starts their own sign-in through `POST /api/v1/connections/:name/oauth/start` and completes it in the same first-party browser session. Neither endpoint takes a credential subject or another person's user id. `catalyst connection connect` refuses personal Connections with `personal_connect_in_browser`; the refusal directs the person to Settings > You > Verbindungen.

`GET /api/v1/me/connections` returns the personal Connections the caller may use, each with only their own sign-in state. `GET /api/v1/connections/:name/people` requires `connection.write` and lists each binding's owner, state, account label, connection time and last-used day. `DELETE /api/v1/connections/:name/people/:userId` requires the same right and revokes that binding locally. These display responses carry no tokens or scope lists. An account label comes only from the token response's OpenID display claims; it never authorizes access.

A call selects `user:<actor id>` and never falls back to a shared binding or a person-context mapping. An absent or revoked binding returns `connection_not_connected`; a refused grant returns `connection_needs_reconnect`. Both include Connection display metadata for the Connect card. Personal refresh happens only in the owner's call under that binding's lease; keep-alive refreshes shared bindings only.

Owner Disconnect deletes the token set and asks the provider to revoke its grant. Administrative revoke, deactivation, Connection deletion and origin changes delete personal token sets without opening them or contacting the provider. The person's grant can remain at the provider until they remove it or it expires. Tokens remain encrypted in the instance's Secret Store until one of those ends or the binding needs reconnect. Setup sessions expire within 15 minutes and are single use. Binding audit events identify the owner and reason without account labels, tokens or consent text.

The personal sign-in lifecycle is separate from the conversation isolation gate and Settings interface.

## Catalogue OAuth parts and result shapers

A catalogue tools part may declare `authScheme: oauth`, the provider endpoints under `oauth`,
`credentialModes: [user, shared]`, and `defaultCredentialMode`. Its fields fill
`oauth.clientId` and the one client secret, which is stored through `connections.set_secret`.
An entry never contains that secret. A source part always uses shared credentials.
Every OAuth endpoint and issuer must appear on the part's own `egress` list.

A part can declare `groups` with `id`, localized `title`, and `scopes`. When groups are
present, every operation names one and an `identity` group is required. Installation and
later operation edits derive `settings.oauth.scopes` from identity plus all groups with an
enabled operation. Enabling a further group keeps the current sign-in; the next sign-in
requests the wider set. A provider's insufficient-scope refusal asks the person to sign in
again. Release `fromEntry` expansion also derives scopes and remains shared; personal parts
are installed at runtime.

An assembly registers synchronous `resultShapers` on `defineClientInstance`. Each named
function receives only the parsed JSON answer and returns JSON, with no context, network
access supplied by the connector, or retained state. An HTTP operation's optional `shaper`
names one of those functions. An unknown name is refused at save, and a catalogue part
requiring an unregistered name is unavailable. The connector shapes the response before
size, secret-echo, and output-schema checks. A throwing shaper returns `output_invalid`;
operations without a shaper retain the normal response shape.

A declared query parameter may use `sendAs` for its wire name, including a leading `$`.
For example, `top: { schema: { type: integer }, sendAs: $top }` exposes `top` to the model
and sends `$top` to the server. Path parameters cannot use `sendAs`, and two query parameters
cannot use the same wire name. Shapers run in the server process on data already received,
keep nothing, and add no processor or region. Returned data follows the Connection's
existing retention and model-region rules.
