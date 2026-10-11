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

| Person         | Address                             | Role  | State                        | Rights beside the role                   |
| -------------- | ----------------------------------- | ----- | ---------------------------- | ---------------------------------------- |
| Mara Lindqvist | `mara.lindqvist@nordlicht-beratung.test`      | admin | active                       |                                          |
| Jonas Brandt   | `jonas.brandt@nordlicht-beratung.test`     | admin | active                       | `api_access.manage`, `agent_models.manage` |
| Tobias Keller  | `tobias.keller@nordlicht-beratung.test`    | user  | active                       |                                          |
| Elif Aydin     | `elif.aydin@nordlicht-beratung.test`      | user  | active                       |                                          |
| Sven Olsen     | `sven.olsen@nordlicht-beratung.test`      | user  | active                       | `config_assets.read`, `usage.view`       |
| Lena Hoffmann  | `lena.hoffmann@nordlicht-beratung.test`      | user  | deactivated                  |                                          |
| Noah Fischer   | `noah.fischer@nordlicht-beratung.test`      | user  | invited, never signed in     |                                          |

The superadmin is the one of the demo's config, so the instance has eight people in three roles.

- Three Namespaces: `tax-` (Steuern), `hr-` (Personal) and `sales-` (Vertrieb). `tax-` has a tool list (`read_skill`, `show_view`, `demo.workflow_summary`) and a model list (`primary`, `gpt56Luna`); the other two inherit everything.
- Eight agents and seven skills from the working copy under `seed/`, pushed with the config CLI: two agents and two skills in each Namespace, and the agents `meeting-notes` and `travel-weather` and the skill `plain-language` outside every Namespace. The agent `tax-vat-checker` has two revisions: a draft Jonas Brandt saved in the interface's way, and the pushed definition over it.
- Sixteen grant rows: allows in a Namespace, allows on one agent and one skill, a deny on one agent inside an allowed Namespace, and a deny in a Namespace against an admin.
- Three grant rows on the Connection `sample-business`, which the release config brings and not the seed: Sven Olsen may see and use it, Tobias Keller may use it. The two admins hold every right on it by their role and the other users hold none, so an agent of Elif Aydin is refused when it calls one of the Connection's tools. See [docs/try-connections.md](docs/try-connections.md).
- One service principal, `Local config CLI`, with one key.
- Two approvals waiting in the Inbox, both asked for by Elif Aydin and held by the demo, see below. One is the new skill `hr-parental-leave-faq` ("Elternzeit: häufige Fragen"), which the Inbox shows whole. The other replaces one paragraph of the pushed skill `hr-leave-policy` ("Urlaubsrichtlinie"), which the Inbox shows as before and after.
- One Shared Workspace, `Nordlicht Beratung`: Mara Lindqvist owns it, and Jonas Brandt, Tobias Keller, Elif Aydin and Sven Olsen are its members.
- Two Apps in that workspace, written from the source files under `seed/apps/`: `client-onboarding` is published, and `fee-estimate` is published with a draft one revision ahead, which adds a second route. A write of an App is built by the workspace command worker, so the seed needs that worker running. The Apps list shows them to Mara Lindqvist and Jonas Brandt, who hold the rights of the kind as admins.

### The approval setting in `hr-`

The demo's server runs with one policy setting, in `src/policy.ts`, whether or not the seed has run. It holds a new or changed skill that is saved through `assets.put` into the Namespace `hr-`, for every caller, admins and the superadmin included. So editing an HR skill in the interface asks for an approval first. It holds nothing else: not a delete, not a revert, and not a push of the config CLI, which is a different operation. While no Namespace `hr-` is registered it matches nothing, so a demo that was never seeded behaves as before.

A held call is decided by anyone who holds `operations.approve`. Admins and the superadmin hold it, so Mara Lindqvist, Jonas Brandt or the superadmin can decide the seeded requests. A requester who holds the right can decide their own request. Elif Aydin does not hold it, so hers wait for somebody else.

| Request in the Inbox                     | Asked by   | What approving does                                        | A rerun of the seed                                                                                         |
| ---------------------------------------- | ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| New skill: Elternzeit: häufige Fragen    | Elif Aydin | Creates the skill `hr-parental-leave-faq`                  | Asks again after a decline. Leaves it once the skill exists.                                                |
| Skill change: Urlaubsrichtlinie          | Elif Aydin | Replaces the last paragraph of `hr-leave-policy`           | Asks again while the request for the new skill waits. An approved change is replaced by the file of `seed/`. |

The seed asks for the change only while the request for the new skill waits: that request tells it that the instance holds such a call. On an instance that holds none it would be written at once.

### Running it again

A rerun puts back what the seed owns and leaves everything else alone. The seed owns what it finds by its own names: the seven people by their address, the three Namespaces by their prefix, and the agents and skills of `seed/` by their name.

- A seeded person gets the seeded label, role, rights and status again. So a seeded person you deactivated is active after a rerun, and Lena Hoffmann is deactivated again.
- A seeded Namespace gets its seeded name, tool list and model list again.
- A seeded agent or skill that differs from `seed/` is replaced by the file with a new revision, like `pnpm config:push --force` does. Changes made in the interface are lost.
- A seeded grant row that was removed is written again, the rows on the Connection too. Rows you added stay.
- A decided approval request is not asked again once the skill exists.
- The seeded workspace is found by its name. A seeded member who was removed is added again; members you added stay.
- A seeded App that has all its revisions is left as it is, whatever was published or written since. One that an earlier run left half way gets the missing revision or the missing publish.
- Other people, Namespaces, agents, skills, grants, keys and conversations are not touched. Something of yours that uses a seeded address, prefix or name counts as the seed's.

The seed never sets a password after it created a person. It signs in as Mara Lindqvist, Jonas Brandt and Elif Aydin when it has to write something in their name. If one of them has a new password, that sign-in is refused and the run stops with the address it could not sign in as. The way out is to change that person's password back to the value of `DEMO_SEED_PASSWORD`, or to set `DEMO_SEED_PASSWORD` in `.env` to the new password if all three share it.

A run that stopped half way is continued by the next one. An invited person who was created and never mailed gets the invitation then: the seed looks for it in the audit events. A key that was created and not written to `.env` stays on the service principal unused, and the next run creates another; remove the unused one under Administration > API Access.

### What to ask the Check tab

Open Settings > Instance > Access > Check, pick the person, the kind and the asset, and compare.

| Person         | Asset                            | Read | Write | Delete | Because                                                                                                   |
| -------------- | -------------------------------- | ---- | ----- | ------ | --------------------------------------------------------------------------------------------------------- |
| Mara Lindqvist | agent `sales-offer-writer`       | yes  | yes   | yes    | An admin may change every agent.                                                                          |
| Mara Lindqvist | agent `hr-onboarding-guide`      | yes  | no    | no     | A deny on writing agents in `hr-` wins over her admin role, and whoever is denied writing does not delete. |
| Tobias Keller  | agent `tax-deadline-planner`     | yes  | yes   | yes    | His rows in the Namespace `tax-` allow all three.                                                         |
| Tobias Keller  | agent `tax-vat-checker`          | yes  | no    | no     | A deny on this one agent wins over the allow of its Namespace.                                            |
| Sven Olsen     | agent `sales-offer-writer`       | yes  | yes   | no     | He reads through the right set on the Users page and writes through a row on this one agent.              |
| Sven Olsen     | agent `sales-pitch-coach`        | yes  | no    | no     | His write row names another agent, and nothing covers this one.                                           |
| Elif Aydin     | agent `hr-exit-interview`        | yes  | yes   | yes    | The agent does not exist yet. Her rows in `hr-` would let her create it.                                  |
| Elif Aydin     | skill `tax-vat-rules`            | no   | no    | no     | Her rows end at the Namespace `hr-`.                                                                      |
| Lena Hoffmann  | agent `sales-pitch-coach`        | no   | no    | no     | Her account is deactivated, so her rows in `sales-` allow nothing.                                        |

The table is `checkQuestions` in `src/seed/company.ts`, and `tests/demo-seed.test.ts` asks the instance every row of it.

A Connection has a fourth action: using it, which is calling through it, is a right of its own beside reading its settings. Choose the kind Connections and the asset `sample-business`.

| Person         | Read | Use | Write | Delete | Because                                                                                  |
| -------------- | ---- | --- | ----- | ------ | ---------------------------------------------------------------------------------------- |
| Mara Lindqvist | yes  | yes | yes   | yes    | An admin may do everything with every Connection.                                        |
| Tobias Keller  | no   | yes | no    | no     | He holds the right to use this one Connection, which does not let him see its settings.  |
| Sven Olsen     | yes  | yes | no    | no     | He holds the rights to read and to use this one Connection, and none to change it.       |
| Elif Aydin     | no   | no  | no    | no     | No right of hers names a Connection.                                                     |

This table is `connectionCheckQuestions` in `src/seed/company.ts`, and `tests/demo-seed-own-config.test.ts` asks an instance with the demo's own config every row of it.

### What it leaves out

- A conversation with a Page. A Page is saved by an agent's `page.save` during a run, and a run needs a model call, which the seed does not make.
- The Connection itself and its secret. Release config brings both when the instance starts; the seed only grants rights on the Connection, and says in its output when the instance has none of that name.

### Limits

- The host name is looked up once, before the first request. A name that answers with another address afterwards is not caught, so use `127.0.0.1` where that matters.
- Whether the invited person was mailed is read from the audit events, newest first, on every rerun. On an instance with a long audit history that takes many requests.

### Adding to it

Every feature slice that adds a kind or a screen adds its test data here: the data in `src/seed/company.ts` or the working copy under `seed/`, the step in `src/seed/run.ts`, a count in `tests/demo-seed.test.ts`, and a line in this section.

## Execution Workspaces and Pages

The demo runs with Execution Workspaces and the `apps` module on. Its agent reads and writes files in the workspace of a conversation, runs commands there and saves a Page with `page.save`.

- Commands and Page builds run in the Docker sandbox. The service `workspace-command-runner` builds the runner image (`vivd-catalyst-demo-workspace-command-runner:local`) and the service `workspace-command-worker` starts one container per command through the Docker socket of the host. The first build of the runner image takes several minutes.
- The worker keeps the directory of a running command under `/tmp/vivd-catalyst-demo-execution-workspaces` on the host. `WORKSPACE_COMMAND_HOST_ROOT` names another directory; Docker must be allowed to mount it.
- The runner image is the platform's own. It has Python with `openpyxl`, `python-docx`, `python-pptx` and `pypdf`, LibreOffice and the Page build command, and none of the artifact helper commands of the capabilities repository, so the demo ships no spreadsheet, document, presentation or PDF skills.

## The sample business system and its Connection

Beside the instance runs a small outside system: the Compose service `sample-mcp` (`sample-mcp/`), a remote MCP server with customers, orders and invoices of an invented wholesale company over the last twelve full months. The data is generated at start from a fixed seed, so it is the same for a whole month. The server has six reading tools, publishes no host port and answers only with its key.

The instance reaches it through the Connection `sample-business` ("Sample business" under Build > Connections), which release config defines in `config/app.yaml`:

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

## Agent and skill configuration

Agents and skills are loaded live from the database. The YAML and Markdown files under `agents/` and `skills/` are the CLI working copy, not runtime file config: a change to them, such as a new entry under `toolNames`, reaches a running demo only with `pnpm config:push`, and a database that was never pushed to has no agent. On the first boot, and after every change to the working copy, start the API and then push that working copy from another terminal:

```bash
pnpm seed:auth
pnpm config:local-key
pnpm config:push
```

`pnpm config:local-key` signs in as the seeded demo superadmin, creates the service principal `Local config CLI` with `config_assets.read` and `config_assets.release` and a key limited to `config_assets:read` and `config_assets:release`, and writes the key into the gitignored `.env` as `CATALYST_API_KEY` without printing it. Run it again after every database reset. It works only against `localhost`, `127.0.0.1` or `::1` and only with a development config; on any other instance, create the principal and key by hand under Administration > API Access.

`pnpm config:push` builds the config CLI and loads `.env`. The key is exchanged for a short-lived access token; it is not written to `catalyst.yaml` or `.catalyst-state.json`. It pushes with `--force`, which sends every local asset over what the instance holds now, so it replaces what was changed in the interface since the last push; `pnpm config:diff` shows the difference first.

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
