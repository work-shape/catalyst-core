# Demo Client

This client assembly is source-controlled reference content for local validation.

Run it through Docker Compose from this directory:

```bash
cp .env.example .env
pnpm dev
```

The development stack starts Postgres, migrates the database with the one-shot `migrate` service, then starts the API, the UI, the artifact preview worker and the workspace command worker. The API listens on `http://127.0.0.1:4100`, and the UI listens on `http://127.0.0.1:5173`.

## Test data

One command fills a running local demo with a small invented company, Nordlicht Beratung, so that every administration screen has something to show. Three commands take an empty machine to a filled instance:

```bash
pnpm dev                          # up: Postgres, the migration, the API, the UI and the workers
docker compose run --rm migrate   # migrate: only after pulling new migrations into a running stack
pnpm demo:seed                    # seed: the test company
```

`pnpm dev` already runs the migration once when it starts, so the second command is for a stack that is already up. Run `pnpm demo:seed` in a second terminal once the API answers.

The seed signs in as the demo superadmin of `config/app.yaml` and works only through the operations of the API and the config CLI. It writes no table itself. It can run any number of times: a second run on an untouched instance creates nothing and changes nothing. It seeds the instance of `catalyst.yaml`; `DEMO_SEED_URL` names another local instance.

It talks to this machine only. It refuses every host that is not `localhost`, `127.0.0.1`, `[::1]` or a name ending in `.localhost` or `.test`, and a name is refused unless every address it resolves to is a loopback address. It refuses an address with a user, a password, a query or a fragment, sends every request to that one origin, follows no redirect, and prints the origin only.

Every seeded person signs in with the address below and the password in `DEMO_SEED_PASSWORD`, see `.env.example`. The seed creates the service principal `Local config CLI` when it is missing and writes its key into the gitignored `.env` as `CATALYST_API_KEY` without printing it, the same way `pnpm config:local-key` does.

### What it contains

| Person         | Address                                  | Role  | State                    | Rights beside the role                     |
| -------------- | ---------------------------------------- | ----- | ------------------------ | ------------------------------------------ |
| Mara Lindqvist | `mara.lindqvist@nordlicht-beratung.test` | admin | active                   |                                            |
| Jonas Brandt   | `jonas.brandt@nordlicht-beratung.test`   | admin | active                   | `api_access.manage`, `agent_models.manage` |
| Tobias Keller  | `tobias.keller@nordlicht-beratung.test`  | user  | active                   |                                            |
| Elif Aydin     | `elif.aydin@nordlicht-beratung.test`     | user  | active                   |                                            |
| Sven Olsen     | `sven.olsen@nordlicht-beratung.test`     | user  | active                   | `config_assets.read`, `usage.view`         |
| Lena Hoffmann  | `lena.hoffmann@nordlicht-beratung.test`  | user  | deactivated              |                                            |
| Noah Fischer   | `noah.fischer@nordlicht-beratung.test`   | user  | invited, never signed in |                                            |
| Kai Berger     | `kai.berger@nordlicht-beratung.test`     | user  | active                   |                                            |
| Fabian Wolf    | `fabian.wolf@nordlicht-beratung.test`    | user  | active                   |                                            |

The superadmin is the one of the demo's config, so the instance has ten people in three roles.

- Eight agents and seven skills from the working copy under `seed/`, pushed with the config CLI: two agents and two skills whose names start with each of `tax-`, `hr-` and `sales-`, and the agents `meeting-notes` and `travel-weather` and the skill `plain-language`. A prefix is part of the name and nothing more. The agent `tax-vat-checker` has two revisions: a draft Jonas Brandt saved in the interface's way, and the pushed definition over it.
- Thirty-four grant rows on existing assets: allows for the current tax, HR and sales assets, denies on the tax checker and HR agents, and six rows on Kai Berger's two drafts. Each row names one asset: a prefix in `src/seed/company.ts` only picks which assets get rows, and an asset added later gets none.
- Kai Berger holds read, write and delete on `kai-helper`, and read, write and publish on `kai-client-years`. An admin prepares these drafts, then Kai saves their next revisions in his session. His Workflow stays unpublished: publishing lends the principal's rights, which he does not hold. He has no right on an App or to create other instance assets. The seed leaves his Workflow out when the Workflows module is off.
- Three grant rows on the Connection `sample-business`, which the release config brings and not the seed: Sven Olsen may see and use it, Tobias Keller may use it. The two admins hold every right on it by their role and the other users hold none, so an agent of Elif Aydin is refused when it calls one of the Connection's tools. See [docs/try-connections.md](docs/try-connections.md).
- Fabian Wolf, an outside builder, holds Builder and Publisher in the workspace Nordlicht Beratung, two grant rows an instance admin writes on Instance > Access, and is no member of it. He reads, writes and publishes what the workspace owns, works there in private conversations of his own and sees none of its other conversations. He holds no right on the REST Connection the firm's people use.
- One service principal, `Local config CLI`, with one key.
- Two approvals waiting in the Inbox, held by the demo, see below. Mara Lindqvist asks for the new skill `hr-parental-leave-faq` ("Elternzeit: häufige Fragen") in the workspace `Personalwesen / HR`, which the Inbox shows whole. Elif Aydin asks to replace one paragraph of that workspace's skill `sick-note` ("Krankmeldung"), which the Inbox shows as before and after.
- Two Shared Workspaces, both owned by Mara Lindqvist. `Nordlicht Beratung` has Jonas Brandt, Tobias Keller, Elif Aydin and Sven Olsen as its members. `Personalwesen / HR` has no other member. Its agents may use only the tools `read_skill`, `show_view` and `demo.workflow_summary` and the models `primary` and `gpt56Luna`, of which the seed keeps the ones the instance has; an instance admin sets these limits under Instance > Workspaces. Elif Aydin holds Builder there, a grant row on the workspace, so she writes the skills it owns without being a member.
- One skill the HR workspace owns, `sick-note` ("Krankmeldung"), written by Mara Lindqvist in one sync batch that names the workspace, as a push of a config CLI root bound to it does. The demo holds a save of a skill there, not a sync.
- One skill and one agent that workspace owns, saved by Mara Lindqvist in its Studio: the skill `nordlicht-house-style` and the agent `nordlicht-front-desk`, which names it. Studio lists both under the scope `Nordlicht Beratung` with the workspace's chip. The agent is offered in that workspace and nowhere else. Only an asset of that workspace may name the skill: an instance agent that names it is refused.
- Three Apps in that workspace, written from the source files under `seed/apps/`: `client-onboarding` is published, `fee-estimate` is published with a draft one revision ahead, which adds a second route, and `customer-list` is published with a tile that reads customers of the Connection `sample-business` through the named action `list-customers` and has a Refresh button. The tile reads with the rights of whoever looks: Sven Olsen and the admins see rows, and a member without the right `connection.use` is told which right is missing. The seed leaves `customer-list` out on an instance without that Connection. A write of an App is built by the workspace command worker, so the seed needs that worker running. The Apps list shows them to Mara Lindqvist and Jonas Brandt, who hold the rights of the kind as admins.
- One Workflow, `accounting-clients`, written and published from `seed/workflows/accounting-clients/workflow.yaml`: it lists the first clients of the Connection `sample-accounting` and reads the fiscal years of each in a loop. It runs as the service principal `workflow-demo`, which the seed creates without a permission and gives one grant: `connection.use` on `sample-accounting`, where the release config brings it. A step never calls an asset operation such as `assets.list`, so a Workflow does not read the instance's agents or skills. Open Workflows as the demo superadmin and press Start; the job worker of `pnpm dev` executes the steps. The seed leaves it out on an instance whose module `workflows` is off.

### The approval setting in `Personalwesen / HR`

The demo's server runs with one policy setting, in `src/policy.ts`, whether or not the seed has run. It holds a new or changed skill that is saved through `assets.put` into the Shared Workspace named `Personalwesen / HR`, for every caller, admins and the superadmin included. So editing a skill of that workspace in its Studio asks for an approval first. It holds nothing else: not a delete, not a revert, not a skill of the instance or of another workspace, and not a push or sync of the config CLI, which is a different operation. A workspace id is known only once the workspace exists, so the server looks the name up each time it reads the setting, and holds the skills of every workspace of that name. While there is none it matches nothing, so a demo that was never seeded behaves as before.

A held call is decided by anyone who holds `operations.approve`. Admins and the superadmin hold it, so Mara Lindqvist, Jonas Brandt or the superadmin can decide the seeded requests. A requester who holds the right can decide their own request. Elif Aydin does not hold it, so her change waits for somebody else. Mara can decide her own request.

| Request in the Inbox                  | Asked by       | What approving does                                           | A rerun of the seed                                                                                                      |
| ------------------------------------- | -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| New skill: Elternzeit: häufige Fragen | Mara Lindqvist | Creates the skill `hr-parental-leave-faq` in the HR workspace | Asks again after a decline. Leaves it once the skill exists.                                                             |
| Skill change: Krankmeldung            | Elif Aydin     | Replaces the last paragraph of the HR workspace's `sick-note` | Asks again while the request for the new skill waits. An approved change is set back to the seed's text by a sync first. |

The seed asks for the change only while the request for the new skill waits: that request tells it that the instance holds such a call. On an instance that holds none it would be written at once.

### Running it again

A rerun puts back what the seed owns and leaves everything else alone. The seed owns what it finds by its own names: the nine people by their address, the two workspaces by their name, the agents and skills of `seed/` and the agent and Workflow of Kai Berger by their name.

- A seeded person gets the seeded label, role, rights and status again. So a seeded person you deactivated is active after a rerun, and Lena Hoffmann is deactivated again.
- The HR workspace gets its seeded tool list and model list again.
- A seeded agent or skill that differs from `seed/` is replaced by the file with a new revision: the seed reads the revision the instance holds and writes against it. Changes made in the interface are lost.
- A seeded grant row that was removed is written again, the rows on the Connection too. Rows you added stay.
- A decided approval request is not asked again once the skill exists.
- A seeded workspace is found by its name. A seeded member who was removed is added again; members you added stay. A Builder or Publisher row that was removed is written again.
- The HR workspace's `sick-note` that differs from the seed's title, description or text is set back with a sync. The company workspace's own skill and agent are left as they are once there.
- An agent or Workflow of Kai Berger that the instance holds is left as it is, whatever was written since.
- A seeded App that has all its revisions is left as it is, whatever was published or written since. One that an earlier run left half way gets the missing revision or the missing publish.
- Other people, workspaces, agents, skills, grants, keys and conversations are not touched. Something of yours that uses a seeded address, prefix or name counts as the seed's.

The seed never sets a password after it created a person. It signs in as Mara Lindqvist, Jonas Brandt, Elif Aydin and Kai Berger when it has to write something in their name. If one of them has a new password, that sign-in is refused and the run stops with the address it could not sign in as. The way out is to change that person's password back to the value of `DEMO_SEED_PASSWORD`, or to set `DEMO_SEED_PASSWORD` in `.env` to the new password if all four share it.

A run that stopped half way is continued by the next one. An invited person who was created and never mailed gets the invitation then: the seed looks for it in the audit events. A key that was created and not written to `.env` stays on the service principal unused, and the next run creates another; remove the unused one under Administration > API Access.

### What to ask the Check tab

Open Settings > Instance > Access > Check, pick the person, the kind and the asset, and compare.

| Person         | Asset                        | Read | Write | Delete | Because                                                                                                    |
| -------------- | ---------------------------- | ---- | ----- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Mara Lindqvist | agent `sales-offer-writer`   | yes  | yes   | yes    | An admin may change every agent.                                                                           |
| Mara Lindqvist | agent `hr-onboarding-guide`  | yes  | no    | no     | A deny on writing agents in `hr-` wins over her admin role, and whoever is denied writing does not delete. |
| Tobias Keller  | agent `tax-deadline-planner` | yes  | yes   | yes    | His rows on this agent allow all three.                                                                    |
| Tobias Keller  | agent `tax-vat-checker`      | yes  | no    | no     | A deny on this agent wins over its allow.                                                                  |
| Sven Olsen     | agent `sales-offer-writer`   | yes  | yes   | no     | He reads through the right set on the Users page and writes through a row on this one agent.               |
| Sven Olsen     | agent `sales-pitch-coach`    | yes  | no    | no     | His write row names another agent, and nothing covers this one.                                            |
| Elif Aydin     | agent `hr-exit-interview`    | no   | no    | no     | The agent does not exist. Her asset rows give no right to create another.                                  |
| Elif Aydin     | skill `tax-vat-rules`        | no   | no    | no     | Her rows cover the existing HR assets.                                                                     |
| Lena Hoffmann  | agent `sales-pitch-coach`    | no   | no    | no     | Her account is deactivated, so her rows in `sales-` allow nothing.                                         |
| Kai Berger     | agent `kai-helper`           | yes  | yes   | yes    | His rows on this draft allow all three.                                                                    |
| Kai Berger     | skill `plain-language`       | no   | no    | no     | His rows cover his two drafts, and he holds no right beside them.                                          |

The table is `checkQuestions` in `src/seed/company.ts`, and `tests/demo-seed.test.ts` asks the instance every row of it.

A Connection has a fourth action: using it, which is calling through it, is a right of its own beside reading its settings. Choose the kind Connections and the asset `sample-business`.

| Person         | Read | Use | Write | Delete | Because                                                                                 |
| -------------- | ---- | --- | ----- | ------ | --------------------------------------------------------------------------------------- |
| Mara Lindqvist | yes  | yes | yes   | yes    | An admin may do everything with every Connection.                                       |
| Tobias Keller  | no   | yes | no    | no     | He holds the right to use this one Connection, which does not let him see its settings. |
| Sven Olsen     | yes  | yes | no    | no     | He holds the rights to read and to use this one Connection, and none to change it.      |
| Elif Aydin     | no   | no  | no    | no     | No right of hers names a Connection.                                                    |

This table is `connectionCheckQuestions` in `src/seed/company.ts`, and `tests/demo-seed-own-config.test.ts` asks an instance with the demo's own config every row of it.

A Workflow has a further action as well: using it, which is starting it. Choose the kind Workflows and the asset `kai-client-years`. Publishing is a row of its own under Rights and not a question of this tab.

| Person     | Read | Use | Write | Delete | Because                                                                                        |
| ---------- | ---- | --- | ----- | ------ | ---------------------------------------------------------------------------------------------- |
| Kai Berger | yes  | no  | yes   | no     | His asset rows let him read and change his draft. He holds no row for starting or deleting it. |

This table is `workflowCheckQuestions` in `src/seed/company.ts`, and `tests/demo-seed.test.ts` asks every row of it.

### What it leaves out

- A conversation with a preview. A preview is opened by an agent's `workspace.open` during a run, and a run needs a model call, which the seed does not make.
- The Connection itself and its secret. Release config brings both when the instance starts; the seed only grants rights on the Connection, and says in its output when the instance has none of that name.

### Limits

- The host name is looked up once, before the first request. A name that answers with another address afterwards is not caught, so use `127.0.0.1` where that matters.
- Whether the invited person was mailed is read from the audit events, newest first, on every rerun. On an instance with a long audit history that takes many requests.

### Adding to it

Every feature slice that adds a kind or a screen adds its test data here: the data in `src/seed/company.ts` or the working copy under `seed/`, the step in `src/seed/run.ts`, a count in `tests/demo-seed.test.ts`, and a line in this section.

## Execution Workspaces and Pages

The demo runs with Execution Workspaces and the `apps` module on. Its agent reads and writes files in the workspace of a conversation, runs commands there, shows what it built with `workspace.open` and keeps it as an App with `app.save`.

- Commands and Page builds run in the Docker sandbox. The service `workspace-command-runner` builds the runner image (`vivd-catalyst-demo-workspace-command-runner:local`) and the service `workspace-command-worker` starts one container per command through the Docker socket of the host. The first build of the runner image takes several minutes.
- The worker keeps the directory of a running command under `/tmp/vivd-catalyst-demo-execution-workspaces` on the host. `WORKSPACE_COMMAND_HOST_ROOT` names another directory; Docker must be allowed to mount it.
- The runner image is the platform's own. It has Python with `openpyxl`, `python-docx`, `python-pptx` and `pypdf`, LibreOffice and the Page build command, and none of the artifact helper commands of the capabilities repository, so the demo ships no spreadsheet, document, presentation or PDF skills.

## The sample business system and its Connection

Beside the instance runs a small outside system: the Compose service `sample-mcp` (`sample-mcp/`), a remote MCP server with customers, orders and invoices of an invented wholesale company over the last twelve full months. The data is generated at start from a fixed seed, so it is the same for a whole month. At `/mcp` the server has six reading tools. It publishes no host port and answers only with its key.

The instance reaches it through the Connection `sample-business` ("Sample business" under Studio > Connections), which release config defines in `config/app.yaml`:

- `connections.sample-business` names the Connector type `mcp`, the address `http://sample-mcp:8787/mcp`, the secret `DEMO_SAMPLE_MCP_KEY` and the six accepted operations, each reading and open to agents and to Pages.
- `egress.allow` lists the one target a Connection may reach: `sample-mcp`, port 8787, as a private target whose address lies in a private range. Docker gives a Compose network such a range. Remove the entry and the Connection's test answers `network_denied`.
- `secretStore.keys` names `DEMO_SECRET_STORE_KEY`, the key that encrypts the secrets of Connections in the database.

`pnpm dev` generates both keys into the gitignored `.env` when they are missing and prints only their names. They are local test values and nothing else reads them: Compose hands `DEMO_SAMPLE_MCP_KEY` to `sample-mcp` and to the API, and `DEMO_SECRET_STORE_KEY` to the API. The API reads the sample key once, at start, and stores it encrypted. Without `DEMO_SECRET_STORE_KEY` the API stops at start and names the variable; `node scripts/ensure-local-secrets.mjs` writes it for a stack that is not started with `pnpm dev`.

To replace the sample key, delete the line `DEMO_SAMPLE_MCP_KEY` from `.env` and start again with `pnpm dev`: the server takes the new key and the API stores it as the next secret version. Keep `DEMO_SECRET_STORE_KEY` as long as the database lives, because the stored secret is read with it. After a database reset both lines may go.

The demo agent carries the six tools as `connection.sample-business.<tool>`. Like every change to the working copy they reach a running demo with `pnpm config:push`. Then ask, for example:

```text
Which five customers ordered most in the last twelve months?
```

[docs/try-connections.md](docs/try-connections.md) walks through the Connection page, three questions with what a right answer looks like, a refusal and a stopped sample server.

## The sample accounting system and its Connection

The same Compose service answers at a second address, `/accounting/mcp`, with the same key. It stands for another outside system: the books of 600 invented clients (Mandanten) of one tax consultancy, served as the Exampledata interface over DATEV data serves them, so that a Workflow can pull a month's bookings client by client before a real key exists. The code is in `sample-mcp/accounting/`.

The instance reaches it through the Connection `sample-accounting` in `config/app.yaml`. Its four operations are reading and open to a Workflow only (`exposure: [workflow]`): no agent carries them and no Page may call them, because no booking passes through a model. The `egress.allow` entry of the first Connection covers it, since host and port are the same.

| Tool                      | Input                                                 | Rows                                                                                                                                |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list_accounting_clients` | `page`, `page_size`                                   | The clients, by `client_id`.                                                                                                        |
| `list_fiscal_years`       | `client_id`                                           | The client's fiscal years, oldest first, with `skr` (3 or 4), `account_length`, `consultant_number` and `client_number`. Not paged. |
| `list_postings`           | `client_id`, `month` (`YYYY-MM`), `page`, `page_size` | The month's bookings, by `date` and then in a stable order.                                                                         |
| `list_accounts`           | `client_id`                                           | The client's chart of accounts with its personal accounts, by `account_number`. Not paged.                                          |

**Paging.** `page` starts at 1. `page_size` is 100 when left out and at most 1,000 (`ACCOUNTING_MAXIMUM_PAGE_SIZE`). An answer is `{ rows }` with no total and no next marker, as Exampledata answers: read page 1, 2, 3 and so on and stop at the first page with fewer rows than `page_size`, which may be an empty one. The largest page of bookings measures 1.40 MiB as a Connection counts it (the rows twice, structured and as text), under its bound of 2 MiB, and is answered in under 30 ms.

**Invalid input.** The clients have the consecutive ids 1001 to 1600 and the months run from 2024-01 to the last month, 2026-09 unless the server is given another, and the input schema of each tool says so (`minimum`, `maximum`, `enum`). A Connection validates a call against that schema before it sends it, so an unknown client or a month outside the range is refused as `input_invalid` (`VALIDATION_FAILED`, "Correct the input and try again") and never reaches the server. A caller that asks the server all the same gets a tool error with a sentence that names the range.

**Data.** Nothing is stored. A booking is a pure function of a fixed seed, the client, the month and the booking's position in the month, so a month gives the same rows forever, and a page costs time in proportion to the page. The books run from 2024-01 to a fixed last month and never to the clock: 2026-09, the last whole month before the sample was brought up to date. A later month has no bookings and is refused, and the last month is served whole, to its last day. To move the end, start the server with `SAMPLE_ACCOUNTING_LAST_MONTH` set to a month as `YYYY-MM` (the `accountingLastMonth` of `createSampleMcpServer`, the `lastMonth` of `createAccountingSample`): the months before it keep their bookings, and the input schema and the description of `list_postings` name the new range. A client's count varies by up to 8 % from month to month inside its size:

| Size   | Clients | Bookings a month |
| ------ | ------- | ---------------- |
| micro  | 335     | 50 to 250        |
| small  | 184     | 300 to 4,000     |
| medium | 73      | 10,000 to 60,000 |
| large  | 8       | exactly 100,000  |

The client list is the one of a real firm. The legal form decides how large a ledger may be, and the industry what is in it:

| Legal form              | Clients | Sizes                |
| ----------------------- | ------- | -------------------- |
| Einzelunternehmen       | 150     | micro, small         |
| Freiberufler            | 125     | micro, small         |
| GmbH                    | 110     | small, medium, large |
| GbR                     | 70      | micro, small         |
| e. K.                   | 65      | micro, small         |
| GmbH & Co. KG           | 45      | small, medium, large |
| UG (haftungsbeschränkt) | 25      | micro, small         |
| AG                      | 7       | medium, large        |
| eG                      | 3       | small, medium        |

| Industry            | Revenue                                                                             | What marks its books                                                        |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| retail              | 60 % through the till at 19 % and 7 %, the rest invoiced                            | Goods are most of the cost, the margin is thin, December is the best month. |
| crafts              | Invoiced at 19 %                                                                    | Material, subcontractors and wages; a weak winter.                          |
| restaurant          | Through the till. Food eaten in is taxed at 19 % until 2025 and at 7 % from 2026    | Food bought at 7 %, a high payroll and rent. No ledger above 4,000 a month. |
| medical practice    | Exempt under § 4 Nr. 14 UStG, a small taxed part                                    | Almost no input VAT: purchases are booked gross.                            |
| property management | Rent, each flat once a month with the same amount: exempt housing, taxed commercial | Repairs and utilities, little input VAT.                                    |
| consulting          | Invoiced at 19 %, mostly on `Erlöse` with the key 3                                 | Payroll is half the revenue.                                                |
| manufacturing       | Invoiced: domestic at 19 %, tax-free intra-community deliveries and exports         | Goods and wages; the only industry with the largest ledgers besides retail. |
| freelancer          | Invoiced at 19 % with the key 3                                                     | Few bookings, few or no employees, the profit is the owner's income.        |

A client's margin is drawn for its industry, higher where the owner draws the profit instead of a wage, and about one client in fifteen loses money over a year (41 of 600 in 2025). Revenue follows the industry's season. A profile gives the share of the revenue each cost takes and the usual amount of one booking, so the number of invoices, purchases and employees follows from the size of the ledger (`sample-mcp/accounting/profiles.ts`, `business.ts`).

A month holds what such a business books (`activities.ts`):

- Sales invoices in the client's own running number range (`AR 20451 Tessaro GmbH`) against the customer's debtor account, and the customer's payment against the bank about two weeks later with the invoice's number in `document_field_1`. The invoices of the first part of a month are paid in that month, the others in the next, so some are open at each month's end.
- Purchases on account (`ER 2026-0412 Velmora Bürobedarf`) against the supplier's creditor account, and their payment the same way. Each client has its own suppliers and customers, the same every month, with a few that do most of the business. Each supplier has its own invoice number format and its numbers rise from month to month. Inside a month a number follows the day, but not strictly, and the client's own invoice numbers do the same (`documents.ts`): of the pairs of documents about three days apart, one in twelve has changed turns, an invoice that came late and one booked ahead of it. So an invoice often carries a higher number than a later one of the same supplier or customer.
- Payments as they come (`settlements.ts`). One payment in eight is two bookings with the invoice's number: the payment less 2 or 3 % cash discount and, on the same day, the discount (`Skonto ER 2026-0412 Velmora Bürobedarf`), or a part payment in whole euros (`Teilzahlung …`) and the rest a few payments later (`Restzahlung …`). A tenant takes no discount. The discount stands in the bank's place of the payment's booking, on `Gewährte Skonti` or `Erhaltene Skonti` by the tax rate of the invoice (SKR03 8730, 8731, 8736 and 3730, 3731, 3736; SKR04 4730, 4731, 4736 and 5730, 5731, 5736). The accounts for 7 % and 19 % are automatic, so the booking shows the corrected tax in `tax_rate`, `net_amount` and `tax_amount`. Payments follow the invoices in no strict order: up to six in a row swap their turns.
- Till reports where the industry has a till (`tills.ts`): one report per till and open day with the number of the report, booked once for each tax rate, so a restaurant's day is two bookings, food and drinks, with a split that varies from day to day. A restaurant is open every day and takes most from Friday to Sunday; one with few reports is open on its best days only. A shop is closed on Sundays and public holidays. The cash goes to the bank on banking days, in whole fifties that differ from one deposit to the next.
- Purchases paid by direct debit or in cash, one in a hundred a general reversal.
- The payroll run once a month where there are employees: per payslip the net wage, the wage tax and both shares of social security (`Lohn 09/2026 Pers.-Nr. 0012 Lohnsteuer`), all with `record_type` `LO` and one `document_link`, then the payments to the health insurers, the employees and, around the 10th, the tax office.
- Standing orders: the rent (`Miete 09/2026 Ladenlokal`), the bank's charge and, for an owner-run business, private withdrawals.

**Days.** Bookings follow the week of a ledger (`calendar.ts`): few on a Saturday, fewer on a Sunday, and none on the nine public holidays all of Germany keeps (New Year, Good Friday, Easter Monday, 1 May, Ascension Day, Whit Monday, 3 October, 25 and 26 December). The holidays of single states are working days. The one exception is the till of a restaurant, which is open on a holiday.

Clients book on a subset of SKR03 or SKR04 with four-digit general ledger accounts. `list_accounts` also lists the personal accounts, because a booking's `contra_account_number` is one for every invoice and payment: a debtor from 10000 and a creditor from 70000 in both charts, labelled with the name of the customer or supplier. Some accounts are blocked, and which ones differs by client: `Durchlaufende Posten` and `Sonstige betriebliche Aufwendungen` in every chart, the accounts of purchases the client's industry does not make (a consultancy has no `Wareneingang`), and the creditors of three suppliers the client no longer buys from. The largest client has about 3,200 accounts in one answer. 97 of the 600 clients book with cost centres, and 45 have a fiscal year that does not start in January.

`createAccountingSample().businessOf(client_id)` names a client's industry and legal form, which no row says.

**What identifies a posting.** Nothing does for certain. The documented `PostingDto` has no id, no journal or batch number and no line number, and no field or set of fields is promised to be unique. The sample invents none. The fields that come nearest:

- `document_link` (Beleglink) is a GUID that names the document behind the booking, not the booking. The sample gives one to every booking with a kept document: an invoice, a receipt, a till report, the payroll journal. It is the same across restarts and pages. All payslip lines of a month share one, as do the bookings of one till report, and a payment, a discount, a standing order and a bank charge have none (empty).
- `document_field_1` is the invoice or receipt number. An invoice and its payment carry the same one.
- `follow_up_index` is 0 for an original and above 0 for a follow-up booking the accounting system generates from it. The sample generates none, so it is 0 in every row.
- `record_type` (Herkunftskennzeichen) says where a booking comes from: `RE` for the accounting itself, `LO` for the payroll.
- `capitalisation_number` is the month's number where the month is locked and 0 in the three open months.

A natural key over all fields of a row still collides: the sample plants exact duplicates on purpose (`duplicate-posting`), and real books contain them. A posting can be told from its neighbours by its position in the month only as long as nothing is booked late. `client_id` is a field the endpoint lets a caller select and filter by, but it is not part of the documented response schema; the sample keeps it in every row.

**Planted findings.** A month is a clean ledger except for bookings that each break exactly one rule of `sample-mcp/accounting/rules.ts`, the only place a rule is worded (one German and one English sentence, and its parameters). `createAccountingSample().expectedFindings(client_id, month)` gives the count per rule, taken from what was planted, so a check's result can be asserted exactly. Not every month breaks every rule, and a month under 300 bookings breaks few.

A planted booking is an ordinary booking of the client with one thing wrong, added to its business (`anomalies.ts`): an office purchase on account, a sales invoice, or a payment made once more by hand. Its text and its pair of accounts are those of clean bookings, in this client's books or in another's, so only the rule tells it apart: a purchase on an account that is blocked for this client and open for another, an invoice with `Erlöse` and key 9 where a consultancy books with key 3, a second `Zahlung ER 2026-0412 Velmora Bürobedarf` for an invoice the month before left open, without the invoice's number and for a round amount. Such a payment falls on the customers and the suppliers by the number of their open invoices, so it is a small share of either's payments. In one month in twenty with such bookings the first of them is a standing order instead, mostly a second `Miete 09/2026 Ladenlokal`: about 2 % of the rent bookings are planted (12 of 576 in one month of every client), and no month has a third. A planted purchase or sales invoice is numbered as the month's own are, at the point of the month it is dated on, so its number fits its day or misses it as often as theirs: of the invoices numbered above a later one of the same counterparty, about 0.2 % are planted, where 0.4 % of all invoices are (176 of 101,972 and 3,291 of 851,184 in one month of every client). No planted booking is like another booking of its month, so a month has exactly the expected duplicates. One dated outside the month lies on no public holiday and never leaves its fiscal year. The tests recount one month of every client against `expectedFindings` with a check written from the rule sentences (`tests/demo-sample-accounting-findings.test.ts`).

| Rule id                    | A booking is a finding when                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-posting`        | an earlier booking of the month has the same date, account, contra account, amount, document field 1 and text. The first of a group does not count. |
| `vat-key-account-mismatch` | it has an input VAT key (8, 9) on a revenue account or a VAT key (2, 3) on an expense account.                                                      |
| `blocked-account`          | its account or contra account is blocked in the chart.                                                                                              |
| `round-amount-no-document` | its `document_field_1` is empty and its amount is at least 1,000 euros and a multiple of 100 euros.                                                 |
| `date-outside-month`       | its `date` lies outside the requested month.                                                                                                        |
| `expense-in-credit`        | it books an expense account in credit (`H`) and is no general reversal.                                                                             |
| `missing-cost-centre`      | it books an expense account without `kost1` while another booking of the month carries one.                                                         |

**What Exampledata documents and what the sample adds.** The rows of clients, fiscal years and bookings hold the fields of the Enterprise API's `/api/accounting/clients`, `/clients/{clientId}/fiscal-years` and `/postings`, and `client_id` in a booking as said above. Three things are the sample's own:

- The tool names and parameters. Exampledata's MCP server publishes no tool list, so the tools mirror its REST API.
- `client_id` and `month` as plain parameters of `list_postings`. Exampledata selects with a `filter` expression (`fiscal_year gte 20260101 and client_id eq 1234`); a filter parser is out of scope.
- `list_accounts`. The Enterprise API has no chart-of-accounts endpoint. Of its fields, `account_number` and `label` are the ones Exampledata's monthly balances name; `account_class`, `automatic_vat_key` and `blocked` are the sample's, there because the rules need them. That it lists the personal accounts is the sample's choice too.

**Assumptions to verify with a real key.** The public documentation does not pin these:

- Dates of a booking are ISO strings (`YYYY-MM-DD`) and its `fiscal_year` is the start of the fiscal year as `"YYYYMMDD"`. The dates of a fiscal year are numbers (`20260101`), as documented. `created_at` is an ISO timestamp.
- A cash discount is a booking of its own beside the payment, as a DATEV ledger shows it, with `follow_up_index` 0. Whether the interface marks it as a follow-up booking of the payment is open.
- Amounts are numbers in euros with two decimals and never negative; `debit_credit_indicator` is `S` or `H` and refers to `account_number`; `net_amount + tax_amount = amount`, to be compared in cents.
- A field without a value is the empty string (`document_field_1`, `document_field_2`, `kost1`, `kost2`, `follow_up_type`, `document_link`), and only `delivery_date` is `null`.
- A booking is written once, with its revenue or expense account in `account_number` and the personal account, the bank or the till in `contra_account_number`. A payment has the bank or the creditor in `account_number`. A booking on an automatic account carries the key 0, and a general reversal keeps the key of what it reverses and sets `general_reversal` to 1.
- `record_type`: the documentation shows `RE` only. `LO` for the payroll is an assumption.
- `document_link` is written as an upper-case GUID, as the documented example is. That an invoice's payment has none is an assumption.
- `gross_net_indicator` is `"B"`, `exchange_rate` 1, `national_law` `"HGB"`, and `size_class_code` follows the size. Their real values and meanings are not documented. The three name fields of a fiscal year all hold the client's name.
- A fiscal year is named by the year it starts in.
- There is no maximum `page_size` in the documentation; the sample's maximum is its own.

Sources, read on 2026-10-12 without an account: <https://exampledata.com/en/docs/mcp-setup>, <https://exampledata.com/en/products/mcp/scope>, <https://api.exampledata.com/docs/enterprise>.

## Agent and skill configuration

Agents and skills are loaded live from the database. The YAML and Markdown files under `agents/` and `skills/` are the CLI working copy, not runtime file config: a change to them, such as a new entry under `toolNames`, reaches a running demo only with `pnpm config:push`, and a database that was never pushed to has no agent. On the first boot, and after every change to the working copy, start the API and then push that working copy from another terminal:

```bash
pnpm seed:auth
pnpm config:local-key
pnpm config:push
```

`pnpm config:local-key` signs in as the seeded demo superadmin, creates the service principal `Local config CLI` with `config_assets.read` and `config_assets.release` and a key limited to `config_assets:read` and `config_assets:release`, and writes the key into the gitignored `.env` as `CATALYST_API_KEY` without printing it. Run it again after every database reset. It works only against `localhost`, `127.0.0.1` or `::1` and only with a development config; on any other instance, create the principal and key by hand under Administration > API Access.

`pnpm config:push` builds the config CLI and loads `.env`. The key is exchanged for a short-lived access token; it is not written to `catalyst.yaml` or `.catalyst-state.json`. It pushes what changed locally since the last pull, each asset against the revision that pull recorded, and is refused where the asset changed in the interface since; `pnpm config:diff` shows the difference first. A working copy that never pulled pushes every asset as a creation. After a database reset remove `.catalyst-state.json` first, or run `pnpm demo:seed`, which writes the seeded assets over whatever the instance holds.

The workflow assistant can propose changes to its shared instructions with
`propose_skill_change`, including new instructions. Ask it to remember a general
rule, then review the proposal in **Freigaben**. Approval requires
`agent_skills.approve` (admins by default, grantable per user in user
administration). The `no_personal_data` approval check uses `guardrailCheck`
(OpenAI `gpt-5-nano`), the same provider and model as conversation titles; a
failed check warns the approver. Approved changes live in the database; pull
before editing the working copy to preserve them.

The CLI signs in with `CATALYST_API_KEY` only. `CHAT_SERVER_CREDENTIAL` is a separate API-side setting for embedded chat session issuance and the CLI does not read it.

For the production-style Compose stack, copy `.env.prod.example` to `.env.prod`, replace every placeholder secret, then run:

```bash
pnpm prod:config
pnpm dev:prod
```

The production-style stack runs migrations as a one-shot job before starting the API. Caddy is the public front door on `http://127.0.0.1:8080` by default and proxies API/auth routes to the API while serving the static UI through the UI container.

It registers example tools, including `demo.weather_forecast` and `demo.workflow_summary`.
The weather tool returns `display.kind: "weather.forecast"`, and the demo UI registers
`demoDisplayWidgets` from `widgets/` to render that output.

To exercise the tool path locally, ask for a forecast such as:

```text
Check the weather forecast for Oslo for the next three days.
```

### REST over the same sample accounting

`sample-accounting-rest` is an `http_api` Connection beside the MCP Connection. Both read
one `AccountingSample`, including its planted findings. The REST base is
`http://sample-mcp:8787/rest` on the existing private egress entry. The key is the existing
`DEMO_SAMPLE_MCP_KEY`; every REST call also needs `x-client-instance-id: demo-local`.
The company seed grants `connection.use` on it to the six active demo users and
to `workflow-demo`. The default superadmin already holds it. Disabled and invited users get
no new grant. The MCP grants and the sample Workflow remain as they were.

The REST endpoints all answer JSON arrays, with no total or next marker. The `http_api`
connector exposes an array as `{ items }`:

| Shape                   | GET path below `/rest`                                                                        | Paging                                     |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Enterprise clients      | `/api/accounting/clients`                                                                     | `page` from 1, `page_size` from 1 to 1,000 |
| Enterprise fiscal years | `/api/accounting/clients/{clientId}/fiscal-years`                                             | same; normally all fit in one page         |
| Enterprise postings     | `/api/accounting/postings`                                                                    | same                                       |
| Gateway clients         | `/datevconnect/master-data/v1/clients`                                                        | `top` from 1 to 1,000, `skip` from 0       |
| Gateway fiscal years    | `/datevconnect/accounting/v1/clients/{clientId}/fiscal-years`                                 | same                                       |
| Gateway postings        | `/datevconnect/accounting/v1/clients/{clientId}/fiscal-years/{fiscalYearId}/account-postings` | same                                       |

Both sizes default to 100. Continue until a page is shorter than the requested size.
Gateway client rows have `id`, `number`, `name`, `status`, `organization_number`, following
[Exampledata's public Gateway example](https://api.exampledata.com/docs/gateway).
`clientId` is the decimal sample client id, such as `1402`; `fiscalYearId` is its fiscal-year
start, such as `20260101`, returned as `id` by the fiscal-year endpoint. DATEV's public
[Accounting 1.7.4 portal](https://developer.datev.de/en/product-detail/accounting/1.7.4/overview)
did not expose its schema to the code preparation probe. Gateway fiscal years and postings
therefore keep the Enterprise fields, with the additional fiscal-year `id`. They do not
claim full DATEV compatibility. The real path identifiers and row sizes still need Monday's
probe.

Postings accept repeated `filter` values, combined with AND. Fields are `client_id`, `date`
and `fiscal_year`; operators are `eq`, `gte`, `lt`. Dates use `YYYY-MM-DD`, fiscal years
`YYYYMMDD`. For example:

```text
/rest/api/accounting/postings?filter=client_id%20eq%201402&filter=date%20gte%202026-09-01&filter=date%20lt%202026-10-01&page=1&page_size=1000
```

Order is client id, ledger month, then the same booking order as MCP `list_postings`.
Date ranges select the ledger period: a full month retains the deliberately wrong-date
bookings so it equals MCP, even when a planted booking's date lies outside that month.
For a partial-month range those dates are clamped to the ledger month's first or last day
before filtering. This is a sample accounting convention, not a claim about DATEV's filter
semantics. Unfiltered reads span every client and available month; Gateway postings span
all months in the named fiscal year, including non-calendar fiscal years.

`x-profile-id` is optional. Omitted or `service-account` sees all 600 clients; `team-a` sees
1001–1300, `team-b` sees 1301–1600. Filtering happens before paging and applies to every
client, fiscal-year and posting route. Unknown profiles return 403; out-of-scope client paths
return 404 and posting filters return an empty array. These fixed sample scopes let CS-15
rehearse person context. They do not enable that feature on the seeded Connection yet.

`GET /rest/api/monitoring/instance/demo-local/datev-connect-health` is the Connection's
`testPath`: health only, no accounting rows. Authentication uses Exampledata's observed
`Authentication failed` / `Unauthorized` response; instance and profile refusals are the
sample's own wording. Logs contain only `REST <status>`, never query values, headers or rows.

The Connection declares `listClients` (Gateway), `listFiscalYears` (Gateway), `listPostings`
(Enterprise), and `listAccountPostings` (Gateway), exposed to Workflows, agents and App
bridges. Each description tells the caller where the ids come from and how to page.
`listPostings.filter` is an array: each value goes out as one repeated `filter` key, as
direct REST takes it, so one client's month is three values. `listPostings` declares
`paging` by page, so a paged Workflow step reads that month to its short last page.

All fault switches are off unless set. They affect REST reads; the volume divisor affects
the shared MCP/REST generator. Health does not spend the rate window or fail under the
503 switches.

| Environment variable                           | Default | Effect                                                                                                       |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `SAMPLE_ACCOUNTING_REST_LATENCY_MS`            | `0`     | Delay each REST call; disconnect cancels its delay                                                           |
| `SAMPLE_ACCOUNTING_REST_RATE_LIMIT_AFTER`      | `0`     | Allow N accounting reads in a shared window, then return 429 with `Retry-After` in whole seconds; 0 disables |
| `SAMPLE_ACCOUNTING_REST_RATE_WINDOW_MS`        | `60000` | Window length; the next window accepts reads again                                                           |
| `SAMPLE_ACCOUNTING_REST_UNAVAILABLE`           | `false` | Return 503 `connector_unavailable` on accounting reads                                                       |
| `SAMPLE_ACCOUNTING_REST_UNAVAILABLE_CLIENT_ID` | unset   | Return that 503 for reads selecting this client; keep client lists available                                 |
| `SAMPLE_ACCOUNTING_SCALE_DIVISOR`              | `1`     | Divide monthly booking counts, rounding with a floor of 50; keep the first large client at 100,000 per month |

The divisor changes the existing generator's business sizes, counts and planted findings
together. It keeps all 600 clients, fiscal years and size classes, and with divisor 100 a
month has fewer than 200,000 bookings including the preserved large client. No second data
generator or stored ledger is involved. Complete-month pages generate at most the requested
rows; skipping complete months uses their counts. Partial-month filters inspect the rows of
overlapping months. Every 1,000-row page of the preserved large client's September ledger
is tested below 1 MiB.

In `pnpm dev:demo`, set them in `clients/demo/.env`: Compose passes each to the sample server,
and an unset switch stays off. After a change, `docker compose up -d sample-mcp` restarts the
sample server alone. To try the code without a demo stack, from an installed worktree root:

```sh
pnpm --filter @work-shape/catalyst-demo exec node scripts/ensure-local-secrets.mjs
pnpm --filter @work-shape/catalyst-demo build:server
PORT=18787 HOST=127.0.0.1 SAMPLE_ACCOUNTING_SCALE_DIVISOR=100 \
  pnpm --filter @work-shape/catalyst-demo start:sample-mcp
```

In a second terminal, from the same worktree root, this prints client rows without printing
the key:

```sh
node --env-file=clients/demo/.env --input-type=module <<'JS'
const response = await fetch('http://127.0.0.1:18787/rest/datevconnect/master-data/v1/clients?top=2', {
  headers: { authorization: `Bearer ${process.env.DEMO_SAMPLE_MCP_KEY}`, 'x-client-instance-id': 'demo-local' }
});
console.log(response.status, await response.json());
JS
```

For Monday's demo setup, `pnpm dev:demo` brings the Connection from release config and the
normal company seed grants its rights. Test it under Connections, then give an agent
`connection.sample-accounting-rest.listClients` and ask it to read two clients. The hosted
integration test performs that call with the deterministic agent and runs a Workflow through
a real 429 to `done` with operation-step attempt 1. No live instance or configuration is
changed by this code preparation.
