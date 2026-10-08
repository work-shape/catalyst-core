---
title: Config Assets
description: Agents and skills live in the database and are edited through the admin UI or synchronized with the Catalyst CLI.
---

Agents, skills, and the default agent are **config assets**: they live in the client instance's database, not in config files. The server never reads agent or skill files — a release config that still contains `agents`, `agentFiles`, `skills`, `skillFiles`, or `defaultAgentName` fails validation with a pointer to this workflow.

This gives config assets a different lifecycle than release config:

- **Release config** (`app.yaml`) ships with a deployment and owns infrastructure: auth, model providers and bindings, usage budgets, tool enablement, workspaces.
- **Config assets** change at runtime — through the admin UI's Config tab or a `catalyst config push` — and apply to new conversations immediately, without a deployment. A running conversation keeps the agent snapshot it started with.

Skill content is read on demand by the `read_skill` tool, so edits are visible to reads after the edit even within an already-running conversation; the agent's system prompt, model selection, and tool list remain on the run's snapshot. A skill is one atomic package: its required `SKILL.md` root may include selectively readable UTF-8 text resources. The root read returns a compact resource manifest, and a second `read_skill` call can load one exact listed path.

Every mutation is validated against the full resulting asset set before it is stored (unknown tool or skill references, missing default agent, duplicate names, and skill use without the `read_skill` tool are all rejected), appended to a per-asset revision history, and audited. A fresh instance boots with zero assets; the chat UI shows a "not configured" notice until the first push.

## The CLI working copy

The repo's YAML and Markdown files are a **working copy**, not the live configuration. Nothing you edit locally is live until you push it:

```sh
catalyst config pull        # replace the working copy with the live assets
catalyst config diff        # show local changes, remote newer assets, and conflicts
catalyst config validate    # schema + cross-reference check without writing
catalyst config push        # merge changed local assets into the live instance
```

A `catalyst.yaml` manifest in the working-copy root names instances and the asset file globs. The database is the live authoring source; the folder is a pulled working copy. `.catalyst-state.json` (gitignored) records each pulled asset's revision and content hash, plus the default agent. Skill hashes cover the root and all resources. YAML formatting and provenance comments do not count as edits.

`push` sends only assets changed locally since their last pull. Unchanged files leave instance edits alone. Assets missing locally stay on the instance unless you use `--prune`, which explicitly deletes them. `--force` deliberately bypasses conflict protection and sends all selected local assets; it does not imply deletion.

If a touched asset was updated, deleted, or created on the instance since its baseline, the server rejects the **whole push** without applying anything. The CLI lists every conflicting asset with its current revision, last operation, actor, and timestamp, then prints a scoped pull command:

```sh
catalyst config pull --only skill:support_review --only agent:assistant
```

Commit or stash local edits in git before running that command: pull overwrites the selected files and removes selected assets deleted on the instance. Re-apply your edits to the pulled content, review with `diff`, and push again. There is no automatic content merge or conflict resolution.

`diff` labels assets **changed locally**, **remote newer**, or **conflict** when both sides changed. Remote-newer assets are not local updates. A full pull refreshes all written asset baselines and the manifest's default agent; `pull --only` refreshes only the selected assets. The default-agent pointer is guarded only when you change it locally. Resolving a default-agent conflict requires a full pull.

State files from an older CLI remain readable, but their global version is not a per-asset baseline. Pull before a guarded push. Older CLIs keep their global-version guard against a newer server. This CLI refuses to push to a server that does not advertise per-asset conflict support, including with `--force`; upgrade the server first.

The canonical skill package layout is:

```text
skills/support_review/
├── SKILL.md
└── references/
    ├── escalation.md
    └── response-format.json
```

The CLI recursively includes `.md`, `.txt`, `.json`, `.yaml`, and `.yml` resources below each matched skill directory. It validates them as UTF-8 text, includes them in pull/diff/push, and rejects unsupported files instead of silently dropping them. Resource paths are normalized relative paths; absolute paths, traversal, duplicate paths, and a second `SKILL.md` resource are invalid. Binary assets do not belong in config assets.

The server URL can come from a named `catalyst.yaml` instance or directly from `--instance https://catalyst.example.com`. Authentication is environment-only for now:

```sh
export CATALYST_API_KEY='the-one-time-value-from-api-access'
catalyst config diff --instance production
```

Create the credential once as a superadmin under **Administration → API Access**:

1. Create a service principal such as `Catalyst CLI` with `config_assets.read` and `config_assets.release`.
2. Create a key restricted to `config_assets:read` and `config_assets:release`.
3. Copy the secret when it is shown once and expose it as `CATALYST_API_KEY` in the operator environment or CI secret store.

The CLI sends the API key only to `POST /api/auth/access-token`, then uses the returned short-lived access token for config operations. It refuses to send an API key over plain HTTP except to `localhost`, `127.0.0.0/8`, or `::1`; remote instances must use HTTPS. A key belongs to a service principal but is independently named, audited, expirable, and revocable. Create separate keys for developer machines and CI jobs so they can be rotated without disrupting one another.

Do not pass the key on the command line or put it in `catalyst.yaml` or `.catalyst-state.json`. Keychain-backed profiles are a future enhancement; the current CLI intentionally reads only environment variables.

For one compatibility release, a CLI without `CATALYST_API_KEY` falls back to `CATALYST_SERVER_CREDENTIAL`, then `CHAT_SERVER_CREDENTIAL`, and prints a deprecation warning. `CATALYST_API_KEY` always takes precedence when both new and legacy values are present.

## Interactive editing and field ownership

Agent `name` is the stable technical identifier used by config references and
agent selection. Use `displayName` for the user-facing name and an optional
localized `description` for the short explanation beneath it in the agent
selector. `displayName` and `description` accept a plain string or an `en`/`de`
map. Keep `welcomeMessage` and `welcomeSubtitle` for the conversation's empty
state.

Two boolean release-config settings decide what the chat shows of its agents.
`ui.showAgentName` is `true` by default and puts the selected agent's name
beside its icon on the start page; with `false` the start page shows the icon
alone. In a conversation the chat always shows the icon alone, which opens the
selector when the pointer is on it. `ui.showAgentDescriptions` is `false` by
default; with `true` the selector lists each description, and otherwise, or
without a description, only the display name.

Admins with the `config_assets.write` permission edit assets in the admin panel's Config tab. Release config decides how much of an agent is interactively editable:

```yaml
administration:
  agentConfiguration:
    enabled: true
    editableAgentFields:
      - displayName
      - description
      - welcomeMessage
      - welcomeSubtitle
      - instructions
```

Fields outside `editableAgentFields` are owned by the CLI workflow: the UI shows them read-only and the server rejects interactive writes that change them. `catalyst config push` requires the separate `config_assets.release` permission and may change everything.

Five agent fields are not governed by `editableAgentFields`: `modelBindingId`, `reasoningEffort`, `fastMode`, `userSelectableModelBindingIds`, and `modelReasoningEfforts`. They are editable exactly when the caller holds `agent_models.manage`, and read-only otherwise. Listing `modelBindingId` or `reasoningEffort` in `editableAgentFields` is still accepted but has no effect.

`fastMode` (boolean, default `false`) runs the agent on the provider's priority tier, billed at the rate card's fast rates. It is valid only when the agent's model binding declares `supportsFastMode` in release config. The CLI writes `fastMode: true` to the agent YAML and omits the key when it is off.

### Models users may choose

`userSelectableModelBindingIds` (list of binding ids, default empty) names the models chat users may pick for this agent instead of its own:

```yaml
modelBindingId: primary
reasoningEffort: high
userSelectableModelBindingIds:
  - fast
modelReasoningEfforts:
  fast: low
```

- Every id must be a binding agents may use (`agentSelectable` not `false` in release config); anything else is a validation error when the list is saved or pushed. The binding-level `userSelectable` key has no effect. The agent's own `modelBindingId` is always available and need not be listed.
- The admin panel shows one model list per agent: a "Default" radio picks `modelBindingId`, a "Selectable by users" checkbox per model fills this list. The default's row is ticked and locked. Changing the default leaves the other ticks as they are, so tick the previous default to keep offering it.
- The composer shows a model picker with the agent's own model first, followed by the list. With an empty list there is no model to choose; the picker then appears only if the agent's own model offers a choice of reasoning effort, see [what the model picker shows](/configure/release-config/#what-the-model-picker-shows). Switching the agent updates the options and falls back to the new agent's own model when it does not offer the current pick.
- The server rejects a run that requests a model the resolved agent does not offer.
- An id whose binding is later removed or set to `agentSelectable: false` is ignored instead of failing the agent. It stays in the stored config until the list is next changed.
- Reasoning effort is set per model. `reasoningEffort` is the effort of the agent's own model. `modelReasoningEfforts` maps a listed binding id to the effort for runs where a user picked that model; without an entry the binding's own default applies. The agent's `reasoningEffort` is never applied to a model the user picked instead. Every key must be in `userSelectableModelBindingIds`; anything else is a validation error.
- In the admin panel each model in use (the default and the ticked ones) has its own reasoning-effort select in the list. When the default changes, each effort stays with its model.
- The CLI omits both keys from the agent YAML when they are empty.

Set `enabled: true`, leave `editableAgentFields` empty, and set all interactive mutation flags (including `allowSkillEditing`) to `false` for a readable, release-controlled Config tab. Agents, complete skill packages, and revision history remain inspectable while create, save, delete, default-change, and restore controls are hidden. Enabling skill editing later exposes the same atomic package through a root/reference editor; no storage migration is required.

Optimistic concurrency protects both surfaces: UI saves carry the loaded config version, and a save after a concurrent CLI push surfaces a conflict dialog instead of silently overwriting.

## Agent skill changes

Agents can propose small changes to their assigned skills through
`propose_skill_change`. Enable the policy in release config, enable the tool
in `tools`, and add it to the agent's `toolNames` alongside `read_skill`:

```yaml
administration:
  agentConfiguration:
    agentSkillChanges:
      enabled: true
      allowSkillCreation: true
```

Both switches default to `false`. Remove `propose_skill_change` from every agent's `toolNames` before setting `enabled` back to `false`. This policy is independent of interactive
skill editing and editable agent fields. Any user of an agent with the tool
can propose a change. Skills are shared by all users; proposals must never
include personal or customer-specific data.

A proposal stays pending until someone with `agent_skills.approve` approves it.
Admins and superadmins hold this permission by default; individual grants and
revocations also apply. Reviewers see whole paragraphs for replacements and
the added text for additions, as source text exactly as the agent will read it. Approval applies the operations to the current skill. A request becomes
superseded only when its operations no longer apply cleanly, or a proposed new
skill already exists. Independent changes to the same skill can both be approved. The original preview remains available in history.

Approval writes a skill revision with the approving user as actor and the
request ID and summary as provenance. Creating a skill adds it to the proposing
agent in the same atomic write. A proposal for a new skill may also carry its
supporting files, such as `references/checklist.md`, as `create_resource`
operations after `create_skill`. Proposals are limited to 20,000 characters per
operation text, 60,000 per root or resource, and 30 resources per skill.

The same permission allows reverting an approved request. Revert writes a new
revision restoring the previous content and records the reverting user. It is
blocked if the skill has newer revisions. Reverting a newly created skill
removes it and its agent reference together; other agents' references must be
removed first. Reverting retains the original approval and proposal history.

## Permissions

| Permission              | Grants                                                                       | Default roles              |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| `config_assets.read`    | View assets, revisions, and the export bundle                                | admin, superadmin          |
| `config_assets.write`   | Interactive edits within `editableAgentFields`, skill editing, default agent | admin, superadmin          |
| `config_assets.release` | Release synchronization via `catalyst config push`                           | none (service tokens only) |
| `agent_models.manage`   | Interactive changes to an agent's model settings and user-selectable models  | superadmin                 |

Effective permissions resolve from role defaults plus per-user grants (`"config_assets.write"`) and revocations (`"!config_assets.write"`) stored on the product user.
