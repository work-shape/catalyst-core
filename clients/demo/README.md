# Demo Client

This client assembly is source-controlled reference content for local validation.

Run it through Docker Compose from this directory:

```bash
cp .env.example .env
pnpm dev
```

The development stack starts Postgres, migrates the database with the one-shot `migrate` service, then starts the API and the UI. The API listens on `http://127.0.0.1:4100`, and the UI listens on `http://127.0.0.1:5173`.

## Agent and skill configuration

Agents and skills are loaded live from the database. The YAML and Markdown files under `agents/` and `skills/` are the CLI working copy, not runtime file config. On the first boot, start the API and then push that working copy from another terminal:

```bash
pnpm seed:auth
pnpm config:local-key
pnpm config:push
```

`pnpm config:local-key` signs in as the seeded demo superadmin, creates the service principal `Local config CLI` with `config_assets.read` and `config_assets.release` and a key limited to `config_assets:read` and `config_assets:release`, and writes the key into the gitignored `.env` as `CATALYST_API_KEY` without printing it. Run it again after every database reset. It works only against `localhost`, `127.0.0.1` or `::1` and only with a development config; on any other instance, create the principal and key by hand under Administration > API Access.

`pnpm config:push` builds the config CLI and loads `.env`. The key is exchanged for a short-lived access token; it is not written to `catalyst.yaml` or `.catalyst-state.json`.

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
