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

The seed signs in as the demo superadmin of `config/app.yaml` and works only through the operations of the API and the config CLI. It writes no table itself. It can run any number of times: a second run creates nothing and changes nothing. It refuses every host that is not `localhost`, `127.0.0.1`, `[::1]` or a name ending in `.localhost` or `.test`. It seeds the instance of `catalyst.yaml`; `DEMO_SEED_URL` names another local instance.

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
- One service principal, `Local config CLI`, with one key.
- One approval waiting in the Inbox: Elif Aydin saved the skill `hr-parental-leave-faq`, and the demo holds every skill change in `hr-` for approval (`src/policy.ts`). Approve it as Mara Lindqvist or as the superadmin; Elif cannot approve her own request.

### What to ask the Check tab

Open Administration > Access > Check, pick the person and the asset, and compare.

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

### What it leaves out

- A conversation with a Page. A Page is saved by an agent's `page.save` during a run, and a run needs a model call, which the seed does not make.
- Connections. The demo has the module `connections` off, and the platform has no connector type and no Secret Store yet, so a seeded Connection would reach nothing. The seed looks for the module and the kind `connection` and says in its output what it found; the Connection, its secret and its grants are added behind that check.

### Adding to it

Every feature slice that adds a kind or a screen adds its test data here: the data in `src/seed/company.ts` or the working copy under `seed/`, the step in `src/seed/run.ts`, a count in `tests/demo-seed.test.ts`, and a line in this section.

## Execution Workspaces and Pages

The demo runs with Execution Workspaces and the `apps` module on. Its agent reads and writes files in the workspace of a conversation, runs commands there and saves a Page with `page.save`.

- Commands and Page builds run in the Docker sandbox. The service `workspace-command-runner` builds the runner image (`vivd-catalyst-demo-workspace-command-runner:local`) and the service `workspace-command-worker` starts one container per command through the Docker socket of the host. The first build of the runner image takes several minutes.
- The worker keeps the directory of a running command under `/tmp/vivd-catalyst-demo-execution-workspaces` on the host. `WORKSPACE_COMMAND_HOST_ROOT` names another directory; Docker must be allowed to mount it.
- The runner image is the platform's own. It has Python with `openpyxl`, `python-docx`, `python-pptx` and `pypdf`, LibreOffice and the Page build command, and none of the artifact helper commands of the capabilities repository, so the demo ships no spreadsheet, document, presentation or PDF skills.

## Agent and skill configuration

Agents and skills are loaded live from the database. The YAML and Markdown files under `agents/` and `skills/` are the CLI working copy, not runtime file config: a change to them, such as a new entry under `toolNames`, reaches a running demo only with `pnpm config:push`, and a database that was never pushed to has no agent. On the first boot, and after every change to the working copy, start the API and then push that working copy from another terminal:

```bash
pnpm seed:auth
pnpm config:local-key
pnpm config:push
```

`pnpm config:local-key` signs in as the seeded demo superadmin, creates the service principal `Local config CLI` with `config_assets.read` and `config_assets.release` and a key limited to `config_assets:read` and `config_assets:release`, and writes the key into the gitignored `.env` as `CATALYST_API_KEY` without printing it. Run it again after every database reset. It works only against `localhost`, `127.0.0.1` or `::1` and only with a development config; on any other instance, create the principal and key by hand under Administration > API Access.

`pnpm config:push` builds the config CLI and loads `.env`. The key is exchanged for a short-lived access token; it is not written to `catalyst.yaml` or `.catalyst-state.json`. It pushes with `--force`, so it replaces what was changed in the interface since the last push; `pnpm config:diff` shows the difference first.

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
