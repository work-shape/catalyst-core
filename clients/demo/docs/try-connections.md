# Try the Connection of the demo

A walk through the sample business system and its Connection, from a fresh start to a refusal and a stopped server. It takes about ten minutes after the first build. What the pieces are is described in the [README](../README.md#the-sample-business-system-and-its-connection).

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

The seed brings the people of an invented company, pushes the demo's agent and grants the rights on the Connection. It can run any number of times. After a change to `agents/`, for example a new tool in the agent's list, `pnpm config:push` brings the change to the running instance.

## Sign in

Open `http://127.0.0.1:5173`. Every seeded person signs in with the password in `DEMO_SEED_PASSWORD`; `.env.example` holds the local test value. Four of them show the Connection from four sides:

| Person | Address | On the Connection |
| --- | --- | --- |
| Mara Lindqvist | `mara.lindqvist@nordlicht-beratung.test` | Admin: holds every right by her role. Use her for the pages below. |
| Sven Olsen | `sven.olsen@nordlicht-beratung.test` | May see and use it: Build > Connections lists it, and his questions are answered. |
| Tobias Keller | `tobias.keller@nordlicht-beratung.test` | May use it only: his questions are answered, and Build shows him no Connections. |
| Elif Aydin | `elif.aydin@nordlicht-beratung.test` | No right: the agent tells her that it may not read the business data. |

## Look at the Connection

1. Open **Build > Connections**. One row is there: "Sample business", type `mcp`, enabled.
2. Open it. The page shows the status Ready, the credential as set with its version and never its value, and six operations. Each one is reading, ready and callable by agents and by Pages. "Used by" names the Workflow Assistant.
3. Press **Test connection**. The status reads "Ready" with the time of the test.
4. Open **Settings** (the gear at the bottom of the sidebar) and there **Operations** under Instance. The page starts with the changing calls; choose **All calls** in the first filter. The test is the newest run, `connections.test`, with Mara's name.

## Ask three questions

Start a new conversation with the Workflow Assistant for each. The numbers change on the first day of a month, because the sample data covers the last twelve full months; within a month they stay the same.

| Question | A right answer | What it takes |
| --- | --- | --- |
| What was our revenue by month in the last quarter? | Three months, each with its revenue in EUR and its number of orders. | One call of `revenue_by_month`, a few seconds. |
| Which five customers ordered most in the last twelve months? | Five ranked customers with revenue and number of orders. The first three are far ahead of the rest, with several times as many orders as anyone else. | One call of `top_customers`, under ten seconds. |
| How much is overdue in unpaid invoices, and which customers owe the most? | One total with the number of overdue invoices, then the customers ranked by what they owe. The three largest customers lead here too. | One call of `list_invoices` and one of `list_customers`, about half a minute. |

Open the work history above an answer to see which tool was called. After each question, **Settings > Operations** with **All calls** shows the calls as runs named `connection.sample-business.<tool>`, called by you through the agent, with the status Done. A reading call that ended well is not in the default list, only one that was refused or failed.

The server writes one line per request, which shows that an answer came from a call and not from the model:

```bash
docker compose logs sample-mcp
```

## Ask without the right

Sign out and sign in as Elif Aydin. Ask the revenue question. The agent answers within a few seconds that it may not read the business data, and gives no numbers. Signed in as Mara again, **Settings > Operations** shows that call with the status Denied: the right `connection.use` was missing. The sample server's log has no line for it.

Tobias Keller gets the numbers for the same question.

## See a refusal by the network

A Connection reaches only what `egress.allow` in `config/app.yaml` lists.

1. In `config/app.yaml`, replace the list under `egress` with `allow: []` and save. `pnpm dev` rebuilds and restarts the API.
2. Press **Test connection**. The status reads "Network denied" and the page says that the host is not in `egress.allow`.
3. Ask the revenue question again. The agent says that it could not read the system and gives no numbers. The run under **Settings > Operations** did not finish as Done.
4. `docker compose logs sample-mcp` shows no new line: the request never left the instance.

Put the entry back and save. After the restart the test reads "Ready" again.

## Stop the sample server

```bash
docker compose stop sample-mcp
```

The instance keeps running: the interface works and `http://127.0.0.1:4100/ready` answers. The test no longer reads "Ready", and the agent, asked the revenue question, says that it could not reach the system and gives no numbers. This answer takes about 40 seconds: the first call waits for the server until its time is up, and the agent tries once more before it gives up.

```bash
docker compose start sample-mcp
```

After that the test reads "Ready" again and the same question gets its numbers. Nothing has to be restarted on the instance.

## Stop

`Ctrl+C` in the terminal of `pnpm dev`, then `pnpm dev:down`. The database stays; `docker compose down --volumes` removes it, and then `.env` may lose its two generated lines as well.
