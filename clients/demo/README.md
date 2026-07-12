# Demo Client

This client assembly is source-controlled reference content for local validation.

Run it through Docker Compose from this directory:

```bash
cp .env.example .env
pnpm dev
```

The development stack starts Postgres, the API, and the UI. The API listens on `http://127.0.0.1:4100`, and the UI listens on `http://127.0.0.1:5173`.

## Agent and skill configuration

Agents and skills are loaded live from the database. The YAML and Markdown files under `agents/` and `skills/` are the CLI working copy, not runtime file config. On the first boot, start the API and then push that working copy from another terminal:

```bash
pnpm seed:auth
# Sign in as the demo superadmin, then create a Catalyst CLI service principal
# and API key under Administration > API Access. Put the one-time value in .env.
pnpm config:push
```

The script builds the config CLI and loads the gitignored `.env` file. Create the service principal with `config_assets.read` and `config_assets.release`, restrict the key to `config_assets:read` and `config_assets:release`, and set its one-time value as `CATALYST_API_KEY`. The key is exchanged for a short-lived access token; it is not written to `catalyst.yaml` or `.catalyst-state.json`.

For one compatibility release, the CLI falls back to `CATALYST_SERVER_CREDENTIAL` and then `CHAT_SERVER_CREDENTIAL` when no API key is set, and prints a deprecation warning. The config script no longer supplies a placeholder credential. `CHAT_SERVER_CREDENTIAL` remains a separate API-side setting for embedded chat session issuance.

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
