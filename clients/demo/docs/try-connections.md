# Try the Connection of the demo

A walk through the sample business system and its Connection, from a fresh start to a refusal and a stopped server. It takes about ten minutes after the first build. What the pieces are is described in the [README](../README.md#the-sample-business-system-and-its-connection).

The labels below are the English ones. In German the same places read: Studio > Verbindungen, Verbindung testen, Einstellungen > Operationen, Alle Aufrufe, Erledigt, Verweigert, and for the states of the Connection Netzwerk gesperrt and Nicht erreichbar.

## Start

From `platform/clients/demo`, with an `OPENAI_API_KEY` in `.env`:

```bash
cp .env.example .env   # only once
pnpm dev
```

`pnpm dev` writes the two local keys into `.env` when they are missing, prints only their names and starts the stack. Leave it running; it rebuilds a service when one of its files changes. When the API is up, fill the instance from a second terminal:

```bash
pnpm demo:seed
```

The seed brings the people of an invented company, pushes the demo's agent and grants the rights on the Connection. It can run any number of times. It writes a key for the config CLI into `.env`, and a running `pnpm dev` may rebuild the API once because of that. Wait until `http://127.0.0.1:4100/ready` answers again before signing in, about two minutes.

The seeded people sign in with the password in `DEMO_SEED_PASSWORD`. `cp .env.example .env` brings the line with its local test value. In a `.env` without the line the seed uses its own fixed default, which is the same value as the one in `.env.example`.

After a change to `agents/`, for example a new tool in the agent's list, `pnpm config:push` brings the change to the running instance.

## Sign in

Open `http://127.0.0.1:5173`. Every seeded person signs in with the password of `DEMO_SEED_PASSWORD`, see above. Four of them show the Connection from four sides:

| Person | Address | On the Connection |
| --- | --- | --- |
| Mara Lindqvist | `mara.lindqvist@nordlicht-beratung.test` | Admin: holds every right by her role. Use her for the pages below. |
| Sven Olsen | `sven.olsen@nordlicht-beratung.test` | May see and use it: Studio > Connections lists it, and his questions are answered. |
| Tobias Keller | `tobias.keller@nordlicht-beratung.test` | May use it only: his questions are answered, and Studio shows him no Connections. |
| Elif Aydin | `elif.aydin@nordlicht-beratung.test` | No right: the agent tells her that it may not read the business data. |

## Look at the Connection

1. Open **Studio > Connections**. Two rows are there, both of type `mcp` and enabled: "Sample business", which this walk follows, and "Sample accounting", which a Workflow reads and no agent.
2. Open it. The page shows the status Ready, the credential as set with its version and never its value, and six operations. Each one is reading, ready and callable by Agents and Apps. "Used by" names the Workflow Assistant.
3. Press **Test connection**. The status reads "Ready" with the time of the test.
4. Open **Settings** (the gear at the bottom of the sidebar) and there **Operations** under Instance. The test is the newest run in the list, `connections.test`, with Mara's name. Choose **All calls** to see the agent's reading calls as well.

## Ask three questions

Start a new conversation with the Workflow Assistant for each. The numbers change on the first day of a month, because the sample data covers the last twelve full months; within a month they stay the same.

| Question | A right answer | What it takes |
| --- | --- | --- |
| What was our revenue by month in the last quarter? | Three months, each with its revenue in EUR and its number of orders. | One call of `revenue_by_month`, a few seconds. |
| Which five customers ordered most in the last twelve months? | Five ranked customers with revenue and number of orders. The first three are far ahead of the rest, with several times as many orders as anyone else. | One call of `top_customers`, under ten seconds. |
| How much is overdue in unpaid invoices, and which customers owe the most? | One total with the number of overdue invoices, then the customers ranked by what they owe. The three largest customers lead here too. | One call of `list_invoices` and one of `list_customers`, about half a minute. |

Open the work history above an answer and then "1 tool call": it shows the tool as "Revenue By Month". After each question, **Settings > Operations** with **All calls** shows the calls as runs named `connection.sample-business.<tool>`, called by you through the agent, with the status Done. A reading call that ended well is not in the default list, only one that was refused or failed.

The server writes one line per request, which shows that an answer came from a call and not from the model:

```bash
docker compose logs sample-mcp
```

## Ask without the right

Sign out and sign in as Elif Aydin. Ask the revenue question. The agent answers within a few seconds that it cannot get the figures and gives no numbers; the work history shows the missing right. Signed in as Mara again, **Settings > Operations** shows that call with the status Denied. The sample server's log has no line for it.

Tobias Keller gets the numbers for the same question.

## See a refusal by the network

A Connection reaches only what `egress.allow` in `config/app.yaml` lists.

1. In `config/app.yaml`, replace the list under `egress` with `allow: []` and save. `pnpm dev` rebuilds and restarts the API. The rebuild and restart take two to three minutes; until then the test still reads "Ready".
2. Open the Connection again. After the restart the status reads "Network denied" before the test is pressed, and the page says that the host is not in `egress.allow`. **Test connection** gives the same answer.
3. Ask the revenue question again. The agent says that the instance has not been allowed to reach the system, that an administrator has to allow it, and gives no numbers. The run under **Settings > Operations** did not finish as Done.
4. `docker compose logs sample-mcp` shows no new line: the request never left the instance.

Put the entry back and save. After the rebuild and restart the test reads "Ready" again.

## Stop the sample server

```bash
docker compose stop sample-mcp
```

The instance keeps running: the interface works and `http://127.0.0.1:4100/ready` answers. **Test connection** reads "Unavailable", and the agent, asked the revenue question, says that it could not reach the system and gives no numbers. This answer usually takes under ten seconds and can take about 40 when the first call waits until its time is up.

```bash
docker compose start sample-mcp
```

Wait a few seconds. After that the test reads "Ready" again and the same question gets its numbers. Nothing has to be restarted on the instance.

## Name a host that does not resolve

A host that is on the list and has no address is the same case as a stopped server, not a refusal by the network.

1. In `config/app.yaml`, change the host in `connections.sample-business.settings.url` and in the entry under `egress.allow` to a name nothing answers to, for example `sample-mcp-gone`, and save. Wait for the rebuild and restart, two to three minutes.
2. Press **Test connection**. The status reads "Unavailable" at once, without waiting for a time to run out. It does not read "Network denied": the list allows the host.
3. Put both names back and save. After the restart the test reads "Ready" again.

## Stop

`Ctrl+C` in the terminal of `pnpm dev`, then `pnpm dev:down`. The database stays; `docker compose down --volumes` removes it, and then `.env` may lose its two generated lines as well.
