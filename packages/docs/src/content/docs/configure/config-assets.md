---
title: Config Assets
description: Agents and skills live in the database and are edited through the admin UI or synchronized with the Catalyst CLI.
---

Agents, skills, and the default agent are **config assets**: they live in the client instance's database, not in config files. The server never reads agent or skill files — a release config that still contains `agents`, `agentFiles`, `skills`, `skillFiles`, or `defaultAgentName` fails validation with a pointer to this workflow.

This gives config assets a different lifecycle than release config:

- **Release config** (`app.yaml`) ships with a deployment and owns infrastructure: auth, model providers and bindings, usage budgets, tool enablement, workspaces.
- **Config assets** change at runtime — through the admin UI's Config tab or a `catalyst config push` — and apply to new conversations immediately, without a deployment. A running conversation keeps the agent snapshot it started with.

Every mutation is validated against the full resulting asset set before it is stored (unknown tool or skill references, missing default agent, duplicate names, and skill use without the `read_skill` tool are all rejected), appended to a per-asset revision history, and audited. A fresh instance boots with zero assets; the chat UI shows a "not configured" notice until the first push.

## The CLI working copy

The repo's YAML and Markdown files are a **working copy**, not the live configuration. Nothing you edit locally is live until you push it:

```sh
catalyst config pull        # replace the working copy with the live assets
catalyst config diff        # compare working copy against the live instance
catalyst config validate    # schema + cross-reference check without writing
catalyst config push        # replace the live assets with the working copy
```

A `catalyst.yaml` manifest in the working-copy root names instances and the asset file globs; `.catalyst-state.json` (gitignored) records the config version you last pulled. `push` sends that version and is rejected with a conflict when the live configuration moved — pull, re-apply, and push again, exactly like a rejected git push. `push --force` overwrites deliberately.

The CLI authenticates with `CATALYST_SERVER_CREDENTIAL` (the instance's server-to-server secret) and mints a short-lived service token scoped to config assets. Note that a service principal's permissions are captured into its product-user record on first authentication and, like any user's permissions, do not refresh from later token claims — if a CLI upgrade needs new permissions on an existing instance, delete the stored `catalyst-cli` user (or update its permissions) so it is recreated with the current grants.

## Interactive editing and field ownership

Admins with the `config_assets.write` permission edit assets in the admin panel's Config tab. Release config decides how much of an agent is interactively editable:

```yaml
administration:
  agentConfiguration:
    enabled: true
    editableAgentFields:
      - displayName
      - welcomeMessage
      - welcomeSubtitle
      - instructions
```

Fields outside `editableAgentFields` are owned by the CLI workflow: the UI shows them read-only and the server rejects interactive writes that change them. `catalyst config push` requires the separate `config_assets.release` permission and may change everything.

Optimistic concurrency protects both surfaces: UI saves carry the loaded config version, and a save after a concurrent CLI push surfaces a conflict dialog instead of silently overwriting.

## Permissions

| Permission | Grants | Default roles |
| --- | --- | --- |
| `config_assets.read` | View assets, revisions, and the export bundle | admin, superadmin |
| `config_assets.write` | Interactive edits within `editableAgentFields`, skill editing, default agent | admin, superadmin |
| `config_assets.release` | Full replace via `catalyst config push` | none (service tokens only) |

Effective permissions resolve from role defaults plus per-user grants (`"config_assets.write"`) and revocations (`"!config_assets.write"`) stored on the product user.
