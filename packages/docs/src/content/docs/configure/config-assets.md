---
title: Config Assets
description: Agents and skills live in the database and are edited through the admin UI or synchronized with the Catalyst CLI.
---

Agents, skills, and the default agent are **config assets**: they live in the client instance's database, not in config files. The server never reads agent or skill files — a release config that still contains `agents`, `agentFiles`, `skills`, `skillFiles`, or `defaultAgentName` fails validation with a pointer to this workflow.

This gives config assets a different lifecycle than release config:

- **Release config** (`app.yaml`) ships with a deployment and owns infrastructure: auth, model providers and bindings, usage budgets, tool enablement, workspaces.
- **Config assets** change at runtime — in [Studio](/configure/build/) or with a `catalyst config push` — and apply to new conversations immediately, without a deployment. A running conversation keeps the agent snapshot it started with.

Skill content is read on demand by the `read_skill` tool, so edits are visible to reads after the edit even within an already-running conversation; the agent's system prompt, model selection, and tool list remain on the run's snapshot. A skill is one atomic package: its required `SKILL.md` root may include selectively readable UTF-8 text resources. The root read returns a compact resource manifest, and a second `read_skill` call can load one exact listed path.

Every mutation is validated against the full resulting asset set before it is stored (unknown tool or skill references, missing default agent, duplicate names, and skill use without the `read_skill` tool are all rejected), appended to a per-asset revision history, and audited. A fresh instance boots with zero assets; the chat UI shows a "not configured" notice until the first push.

## The CLI working copy

[The Catalyst CLI](/configure/cli/) says how the `catalyst` command is installed.

The repo's YAML and Markdown files are a **working copy**, not the live configuration. Nothing you edit locally is live until you push it:

```sh
catalyst config pull        # replace the working copy with the live assets
catalyst config diff        # show local changes, remote newer assets, and conflicts
catalyst config validate    # schema + cross-reference check without writing
catalyst config push        # merge changed local assets into the live instance
```

A `catalyst.yaml` manifest in the working-copy root names instances and the asset file globs. The database is the live authoring source; the folder is a pulled working copy. `.catalyst-state.json` (gitignored) records each pulled asset's revision and content hash, plus the default agent. Skill hashes cover the root and all resources. YAML formatting and provenance comments do not count as edits.

`push` sends only assets changed locally since their last pull, in one `assets.sync` call that is applied completely or not at all. Each asset names the revision of its last pull, and an asset the working copy never pulled names none: it is a creation, which the instance refuses when it holds the name. Unchanged files leave instance edits alone. Assets missing locally stay on the instance unless you use `--prune`, which deletes them at the revision of the last pull; an asset that appeared on the instance since is reported as a conflict instead of being deleted. `--prune` cannot be combined with `--only`, and a push whose listing of the instance fails deletes nothing.

A working copy that never pulled from an instance pushes every asset as a creation, so a first release to an empty instance needs no pull. Each pulled asset is recorded with its revision and with the id of the asset on the instance, and a push names both. A working copy that was pulled from another database, or whose asset was deleted for good and made again on the instance, is refused for that asset, on the CLI before anything is sent and on the instance with `409 CONFLICT` and `details.reason` `asset_replaced`: the revision numbers of two assets say nothing about each other. The CLI names the asset and the command that repairs it, `catalyst config pull --only <kind>:<name>`, which reads the asset again whenever its id differs. A `.catalyst-state.json` written by an earlier CLI holds no ids and is refused the same way until the assets are pulled once.

There is no `--force`. A push never overwrites a change it did not read: the flag is refused with the procedure below. A deleted asset keeps its name with its history. `pull` records the revision of a delete it sees, and the next push that creates the asset again names it; without that pull the creation is reported as a conflict with the delete.

The CLI reads with `assets.list` and `assets.get` and writes with `assets.sync`, the operations under [The asset API](#the-asset-api). Each push is one Operation Run of the key's service principal. A push whose answer is lost on the way is sent again under the same idempotency key, so it is applied once. One push holds at most 2,000 assets and 20 MiB, and one asset in it at most 2 MiB; a larger release is pushed in parts with `--only`. `validate` asks `assets.sync_check` whether a push of the whole working copy would be accepted and writes nothing. On an instance whose policy holds a release for approval, `push` reports the waiting Operation Run and exits with 1; pull after the approval.

If a touched asset was updated, deleted, or created on the instance since its baseline, the server rejects the **whole push** without applying anything. The CLI lists every conflicting asset with its current revision, whether that revision is its delete, who wrote it and when, then prints a scoped pull command. A key that may not read an asset is told its name only:

```sh
catalyst config pull --only skill:support_review --only agent:assistant
```

Commit or stash local edits in git before running that command: pull overwrites the selected files and removes selected assets deleted on the instance. Re-apply your edits to the pulled content, review with `diff`, and push again. There is no automatic content merge or conflict resolution.

`diff` labels assets **changed locally**, **remote newer**, or **conflict** when both sides changed. Remote-newer assets are not local updates. A full pull refreshes all written asset baselines and the manifest's default agent; `pull --only` refreshes only the selected assets. The default-agent pointer is guarded only when you change it locally. Resolving a default-agent conflict requires a full pull.

State files from an older CLI remain readable, but their global version is not a per-asset baseline. Pull before a guarded push.

CLI and server ship together. The addresses the CLI used before, `/api/v1/instance/config/export`, `/import` and `/validate`, are gone: an older CLI is answered `404` with the sentence to upgrade it. This CLI against an older server reports that the instance does not serve the asset operations it uses. `push` and `validate` need the instance on the release of this CLI or later: they send the batch to `assets.sync_check` first, where the instance checks it and writes nothing, and against an instance that has `assets.sync` without the check they say so and write nothing.

The canonical skill package layout is:

```text
skills/support_review/
├── SKILL.md
└── references/
    ├── escalation.md
    └── response-format.json
```

The CLI recursively includes `.md`, `.txt`, `.json`, `.yaml`, and `.yml` resources below each matched skill directory. It validates them as UTF-8 text, includes them in pull/diff/push, and rejects unsupported files instead of silently dropping them. Resource paths are normalized relative paths; absolute paths, traversal, duplicate paths, and a second `SKILL.md` resource are invalid. Binary assets do not belong in config assets.

The front matter of `SKILL.md` holds `title`, `description` and, optionally, `name`, `summary` and `starters`. The two texts have different readers:

- `description` is for the agent. It says when to use the skill.
- `summary` is for people. It is one sentence on one line, at most 120 characters, that says what an agent with the skill knows how to do, such as "Knows how to write short, easy sentences in German and English." The agent editor and the Skills list show it under the title. A skill without a summary shows its title alone.

A skill is instructions the agent follows. It adds no tools, so a summary never names something only a tool can do.

`starters` are first requests the empty chat offers under the composer for an agent that has the skill. A skill carries at most two:

```yaml
starters:
  - title:
      en: Check an invoice
      de: Rechnung prüfen
    hint:
      en: Required details and tax rate
      de: Pflichtangaben und Steuersatz
    prompt:
      en: "Check this invoice for the required details and the right tax rate:"
      de: "Prüfe diese Rechnung auf Pflichtangaben und den richtigen Steuersatz:"
    tools:
      - workspace.read_file
```

- `title` and the optional `hint` are one line of at most 60 characters each. `prompt` is the text that fills the composer when the starter is chosen. Nothing is sent until the person sends it. Each of the three is one text or one text per language (`en`, `de`).
- `tools` is optional. A starter shows only for an agent that holds every tool it names, so it never offers what the agent cannot do.
- The chat shows at most four starters for an agent, the skills in the order the agent lists them. An agent whose skills carry none shows the empty chat as before.

The server URL can come from a named `catalyst.yaml` instance or directly from `--instance https://catalyst.example.com`. Authentication is environment-only for now:

```sh
export CATALYST_API_KEY='the-one-time-value-from-api-access'
catalyst config diff --instance production
```

Create the credential once as a superadmin under **Administration → API Access**:

1. Create a service principal such as `Catalyst CLI` with `config_assets.read` and `config_assets.release`.
2. Create a key restricted to `config_assets:read` and `config_assets:release`. A push is a release only with both: the right on the principal and the release scope on the key. Under a key with `config_assets:write` instead, the same principal syncs as any writer does, inside one Namespace and within the editing limits.
3. Copy the secret when it is shown once and expose it as `CATALYST_API_KEY` in the operator environment or CI secret store.

For a local development instance, one script of the client repository does these steps:

```sh
pnpm config:local-key
```

The script calls `catalyst-local-key --instance <url>`, a command of the private `client-assembly` package. It is not part of the public `catalyst` tool, because it reads the release config and its secrets. It signs in as the seeded superadmin of the development config (`config/app.yaml`, or `--config <file>`), creates the service principal `Local config CLI` and a key with the two config scopes, and writes the key as `CATALYST_API_KEY` into `.env` (`--write-env <file>`, `--env-name <variable>`). The key is not printed. A later call reuses the principal and replaces the key in the file, so run it again after a database reset. The command takes the address of the instance as a URL and refuses any host other than `localhost`, `127.0.0.1` or `::1`, and any config whose environment is not `development`.

The CLI sends the API key only to `POST /api/v1/auth/access-token`, then uses the returned short-lived access token for config operations. It refuses to send an API key over plain HTTP except to `localhost`, `127.0.0.0/8`, or `::1`; remote instances must use HTTPS. A key belongs to a service principal but is independently named, audited, expirable, and revocable. Create separate keys for developer machines and CI jobs so they can be rotated without disrupting one another.

Do not pass the key on the command line or put it in `catalyst.yaml` or `.catalyst-state.json`. Keychain-backed profiles are a future enhancement; the current CLI intentionally reads only environment variables.

The exchange needs `SERVICE_ACCESS_TOKEN_SECRET` set on the server; without it the instance has no API access and the exchange answers 404. The API key is the CLI's only sign-in. A CLI without `CATALYST_API_KEY` stops before it sends a request and names Administration, API Access as the place a key comes from; `CATALYST_SERVER_CREDENTIAL` and `CHAT_SERVER_CREDENTIAL` are not read.

## A skill as a folder of files

A skill follows the public Agent Skills convention, so a folder taken unchanged from a public skill library saves, reads and round-trips byte for byte: `SKILL.md` with YAML frontmatter and Markdown, and whatever lies beside it, commonly below `scripts/`, `references/` and `assets/`, and also files at the root such as `LICENSE.txt` or `reference.md`. The asset API writes and reads the whole folder: `assets.put` with `files` (each `{ path, text }` or `{ path, base64 }`, `SKILL.md` among them) and `assets.get` with `files=true`, which answers every file with its hash and its content as it was written.

**Frontmatter.** `name` and `description` are required; a file without a `name` takes the name of the asset. `title` is optional: where it is absent the skill is shown under the first Markdown heading of its content, or else under its name with spaces for hyphens and a capital first letter. `summary` and `starters` are read as fields of the skill, as before. Every other key (`license`, `metadata`, `allowed-tools`, `compatibility`, anything else) is kept as it is, returned as `frontmatter` of the config, and read by nothing; a `frontmatter` of a config that holds one of the skill's own fields is refused. The file is stored as its bytes, so nothing reorders or reformats it.

**Names.** Every name of the convention is accepted (lowercase letters, digits and hyphens), and so is what a skill here could always be named: letters, digits, dots, underscores and hyphens, starting with a letter or a digit. A write of a skill whose name is outside the convention or longer than 64 characters, or whose description is longer than 1,024, is answered with a warning (`skill_name_not_portable`, `skill_description_not_portable`) and is not refused.

**Files.** Any normalized relative path is a file of the skill. A file whose extension says script or text (`.py`, `.js`, `.mjs`, `.ts`, `.sh`, `.rb`, `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.xml`, `.html`, `.css`, `.csv`) is UTF-8; every other file is bytes.

The config of a skill stays where its text is read from: `content` from `SKILL.md`, and `resources` for every text file with a resource extension (`.md`, `.txt`, `.json`, `.yaml`, `.yml`) outside `scripts/`, at whatever path it lies. Every other file is kept in the file set of the revision, and the config names it in `files`, an index of `path`, `sha256`, `bytes` and `mediaType` without content. So a skill that is text alone has the config it always had, `read_skill` and a proposal of an agent work on it unchanged, and a write of the config alone (a release sync, the interface, an approved proposal) changes the text and leaves the other files and the further frontmatter of the skill where they are. Reverting to a revision brings its files back with it. What a caller sends as `files` in a config is not read; `frontmatter` is, and an empty one clears it.

A folder is refused with the path and a reason of its own:

| Reason | What is refused |
| --- | --- |
| `skill_manifest_missing`, `skill_manifest_invalid` | no `SKILL.md`, or one whose frontmatter does not read or lacks a description |
| `skill_frontmatter_alias`, `skill_frontmatter_too_deep`, `skill_frontmatter_too_large` | a frontmatter that uses a YAML anchor with an alias or a merge key, nests deeper than 8 levels, or holds more than 8,192 characters beside the fields of the skill |
| `skill_path_invalid`, `skill_path_duplicate` | a path that escapes the folder or is not normalized, is longer than 240 characters or has a segment longer than 100, a `SKILL.md` below the root; two paths that differ in case alone, a path that is the folder of another one |
| `skill_file_not_text` | a file whose extension says script or text and whose bytes are no UTF-8 |
| `skill_file_executable` | a compiled program by its first bytes (ELF, Mach-O, and PE by both of its headers), whatever its name |
| `skill_file_lfs_pointer` | a Git LFS pointer in place of the file |
| `skill_file_too_large` | a file over 2 MiB |
| `files_too_large`, a schema issue on `files` | more than 8 MiB in all, more than 500 files: the limits of every write of files of the API, which are the skill's too |
| `files_unavailable` | a file the config cannot hold, on an instance without a `files` object store |

The two limits of a whole folder are answered by the API's general limits of a write of files, before any file is decoded and for every kind alike, so a call over one costs nothing; the skill's own `skill_too_large` and `skill_too_many_files` name the same numbers and answer a caller that reaches the rule another way. A YAML anchor with an alias is refused outright in a frontmatter, as in `store.yaml`, `workflow.yaml`, `app.yaml` and an App's action files: a reader answers an alias as the object its anchor made, so a few lines of nested aliases are a value of any size, and no file the platform reads needs one.

An instance without a `files` object store holds skills as their text, as before. An agent's proposal stays with instruction text: it creates and changes no file below `scripts/` and no file that is not a text resource. The audit event of a write of a folder names each file by path, hash and size and holds no content. `read_skill` does not list the other files yet, and an agent's workspace does not hold them yet.

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
selector when the pointer is on it. `ui.showAgentDescriptions` is `true` by
default and lists each description in the selector; with `false`, or for an
agent without a description, the selector shows only the display name.

The **Agents** page, the row under New chat in the main rail, shows every agent
a person may use in the open workspace as a card: the agent mark, the display
name, the description in two lines at most, and **Start chat**. Start chat
opens a new conversation with that agent selected, where its starter prompts
wait. The card always shows the description, whatever
`ui.showAgentDescriptions` says, and it marks the workspace's default agent. A
person who may read agents in Studio also finds **Edit in Studio** on each card.
A person who may create one finds **New agent** in the page head, when
`allowAgentCreation` is on and the person holds the right to write one: it opens
the dialog that names the agent on the page itself, and **Continue** leads to the
new agent's page in Studio, where it is written. Cancel stays on the page.

People with the `config_assets.write` permission, or with a grant in a Namespace, edit assets in [Studio](/configure/build/). The module `assetManagement` turns that on, and release config decides how much of an agent is interactively editable:

```yaml
modules:
  assetManagement:
    enabled: true

administration:
  agentConfiguration:
    editableAgentFields:
      - displayName
      - description
      - welcomeMessage
      - welcomeSubtitle
      - instructions
```

Fields outside `editableAgentFields` are owned by the CLI workflow: the UI shows them read-only and the server rejects interactive writes that change them. `catalyst config push` requires the separate `config_assets.release` permission and may change everything.

Five agent fields are not governed by `editableAgentFields`: `modelBindingId`, `reasoningEffort`, `fastMode`, `userSelectableModelBindingIds`, and `modelReasoningEfforts`. They are editable exactly when the caller holds `agent_models.manage`, and read-only otherwise. Listing `modelBindingId` or `reasoningEffort` in `editableAgentFields` is still accepted but has no effect.

One exception: a Namespace can carry a list of allowed model bindings. A user who may write agents in such a Namespace sets `modelBindingId` to a binding on that list without holding `agent_models.manage`. A binding that is not on the list is refused for every writer. An agent there that names a provider or no model is refused unless the writer holds `agent_models.manage`. The other four fields keep the rule above.

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
- Studio shows the models in the agent's **Model** section: **Default model** picks `modelBindingId`, and a tick per model under **Models people can choose in chat** fills this list. The default is always offered and has no tick of its own. Changing the default leaves the other ticks as they are, so tick the previous default to keep offering it.
- The composer shows a model picker with the agent's own model first, followed by the list. With an empty list there is no model to choose; the picker then appears only if the agent's own model offers a choice of reasoning effort, see [what the model picker shows](/configure/release-config/#what-the-model-picker-shows). Switching the agent updates the options and falls back to the new agent's own model when it does not offer the current pick.
- The server rejects a run that requests a model the resolved agent does not offer.
- An id whose binding is later removed or set to `agentSelectable: false` is ignored instead of failing the agent. It stays in the stored config until the list is next changed.
- Reasoning effort is set per model. `reasoningEffort` is the effort of the agent's own model. `modelReasoningEfforts` maps a listed binding id to the effort for runs where a user picked that model; without an entry the binding's own default applies. The agent's `reasoningEffort` is never applied to a model the user picked instead. Every key must be in `userSelectableModelBindingIds`; anything else is a validation error.
- In Studio each model in use (the default and the ticked ones) has its own reasoning-effort select. When the default changes, each effort stays with its model.
- The CLI omits both keys from the agent YAML when they are empty.

Set `enabled: true`, leave `editableAgentFields` empty, and set all interactive mutation flags (including `allowSkillEditing`) to `false` for a readable, release-controlled Config tab. Agents, complete skill packages, and revision history remain inspectable while create, save, delete, default-change, and restore controls are hidden. Enabling skill editing later exposes the same atomic package through a root/reference editor; no storage migration is required.

Optimistic concurrency protects both surfaces, per asset: a save in Studio carries the revision the page loaded, and a save after somebody else's write of the same asset shows a notice that names who saved first and when, with "Load the newer version" and "Open history", instead of overwriting. A save of another asset never blocks it.

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
blocked if the skill has newer revisions, and where a guardrail on
`asset.before_write` blocks the restored content; the request then stays
approved. Reverting a newly created skill
removes it and its agent reference together; other agents' references must be
removed first. Reverting retains the original approval and proposal history.

## The asset API

Every asset is read and written at one address, `/api/v1/assets/{kind}/{name}`, where `kind` is a registered kind such as `agent` or `skill`. The admin panel uses these operations, and so can a script or an outside editor. Each changing call is one Operation Run with its actor and outcome. A read is checked the same way and leaves a run only when it is refused or fails. The [API reference](/reference/api/) lists the fields.

| Operation                 | Address                                      | Right                |
| ------------------------- | -------------------------------------------- | -------------------- |
| `assets.list`             | `GET /api/v1/assets/{kind}`                  | `<kind>.read`        |
| `assets.get`              | `GET /api/v1/assets/{kind}/{name}`           | `<kind>.read`        |
| `assets.put`              | `PUT /api/v1/assets/{kind}/{name}`           | `<kind>.write`       |
| `assets.delete`           | `POST /api/v1/assets/{kind}/{name}/delete`   | `<kind>.delete`      |
| `assets.revisions.list`   | `GET /api/v1/assets/{kind}/{name}/revisions` | `<kind>.read`        |
| `assets.revert`           | `POST /api/v1/assets/{kind}/{name}/revert`   | `<kind>.write`       |
| `assets.validate`         | `POST /api/v1/assets/{kind}/validate`        | `<kind>.read`        |
| `assets.publish` | `POST /api/v1/assets/{kind}/{name}/publish` | `<kind>.publish` |
| `assets.discard_draft` | `POST /api/v1/assets/{kind}/{name}/discard-draft` | `<kind>.write` |
| `assets.sync`             | `POST /api/v1/assets/sync`                   | per item             |
| `assets.sync_check`       | `POST /api/v1/assets/sync/check`             | per item             |
| `platform.context.get`    | `GET /api/v1/context`                        | any signed-in caller |
| `platform.references.get` | `GET /api/v1/context/references`             | a right on any kind  |

The right is decided for the one asset: an instance right, a grant in the Namespace of its name, or a grant on the asset. `assets.list` answers only the assets the caller may read, as summaries without content, in the order of their names. It filters by `prefix` (a name prefix such as a Namespace) and by `text` (a part of the name, in any case), and pages with `limit` and `cursor`. It is built for up to 10,000 assets of a kind.

A write names the revision it was made against, for every asset it writes. `assets.put` with a number in `expectedRevision` replaces the asset at that revision; with `null` it creates the asset and is refused when the name is taken. `assets.delete` and `assets.revert` take a number. A write that leaves `expectedRevision` out is answered `428 PRECONDITION_REQUIRED` with `details.assets`, the assets it named no revision for, and changes nothing: no call overwrites what it did not read.

When the asset stands at another revision the call answers `412 REVISION_CONFLICT` and changes nothing; read the asset again and repeat the call. `details.conflicts` holds one entry per stale asset with its `kind` and `name`. A caller who may read the asset's history, the right `assets.revisions.list` asks, is also told `currentRevision` (`null` where the name was never stored), `deleted: true` where that revision is the delete of the asset, and `changedBy` and `changedAt` of that revision. Everyone else is told the name they sent and nothing more.

A write is refused for the first of these that applies, in this order: a right the caller lacks, on the asset and beside it (the right to manage model settings, the right on the instance for a change of its default agent); then the missing `expectedRevision` with `428`; then the stale revision with `412`. A caller without a right is told that and nothing of the revision.

A caller who may write or delete an asset and may not read it is told nothing the instance holds of it. A delete of an asset that is not there, of one that is deleted and of one at another revision are answered the same `412` with the name alone, where a reader is answered `404` for the first two. A name that another owner holds, such as a workspace, is answered that `412` too, where a reader of that asset is answered `422` with `details.reason` `invalid_scope`. That a stored asset takes no write at all (`read_only_origin`) is told only against the revision the asset is at. One thing cannot be kept back, since a name is unique on the instance: a create with `expectedRevision: null` of a name that is taken is refused with the name alone, so its caller learns that the name is used, and not by whom, at which revision, or whether it is active or deleted. An App's id is answered `409` `app_id_taken` in the same case.

The revision a write answers is the one that write was given, not what the asset is at when the answer is built. A write that was committed is answered as made even when its audit row could not be written: the failure is logged with the correlation id.

A deleted asset keeps its name, its history and the revision of its delete. `null` creates only a name that was never stored: creating a deleted asset again names the revision of its delete, which the conflict tells to who may read it. An App is the exception: deleting it removes it with its files, and its name is free again. The four writing operations answer the new `revision`, the configuration `version` and a list `warnings`, which is empty today.

`assets.sync` applies up to 200 puts and deletes for one registered Namespace, named by its prefix in `namespace`. Each item is checked like the single call: the right on that asset, its revision, its content. An item may also carry `expectedAssetId`, the id of the asset its revision was read from; where the instance holds another asset under the name the batch is refused with `409 CONFLICT` and `details.reason` `asset_replaced`. Each applied item answers the `id` and the `revision` it wrote. One put item holds at most 2 MiB as JSON (`ASSET_SYNC_ITEM_MAX_BYTES`). Every item carries `expectedRevision` as the single call does, and the answers are the same two: `428` with `details.assets` when an item names none, `412` with `details.conflicts` when an item is stale. The rights are decided first, those beside the right on the item included, so a caller without a right learns nothing of a revision. The whole set is validated against what the transaction's lock protects: a write that another write made invalid between its check and its commit is refused. An asset the batch does not name is not read for its revision and never refuses the batch. The batch is applied completely or not at all, in one transaction: an agent may name a skill the same batch creates. A kind with a draft and a published revision has its draft moved by a put; the published revision and the version of the asset set stay. An App is refused as an item, since its files are built per write. When any item is refused the answer carries `details.items` with one entry per item, `refused` with its error or `not_applied`, and nothing is written. An item whose name does not start with the prefix is refused for every caller, an administrator included. The right on every item is decided before the instance's policy is asked, and a policy setting narrowed to a kind or to a Namespace applies to a batch that names an asset of that kind or in that Namespace.

A holder of `config_assets.release` whose key carries the scope `config_assets:release` may leave `namespace` out. That batch is a release, which is what `catalyst config push` sends: it may name any agent or skill of the instance, holds up to 2,000 items, may carry `defaultAgentName` and `expectedDefaultAgentName`, is not bound by `editableAgentFields` or the right for model settings, and is checked against the whole stored set instead of what its key may read. A delete of an asset that is not there is answered `absent` and refuses nothing, unless the asset was created meanwhile. Every batch answers `hiddenAgentNames` for agents it wrote that no workspace offers.

`assets.sync_check` takes the body of a sync, runs every check of it and writes nothing. It answers `{ "valid": true }` or the refusal the sync would answer.

A request body over one megabyte is answered `400` with `details.reason` `body_too_large`. `assets.sync` and `assets.sync_check` take up to 20 MiB (`ASSET_SYNC_BODY_MAX_BYTES`).

A definition is checked against what its caller may read. A reference to an asset the caller may not read, such as a skill of another Namespace, is answered like a reference to an asset that does not exist, by `assets.validate` and by a write. An asset may always refer to the assets beside it in its own Namespace, and a reference an asset already carries is kept when somebody edits it who may not read its target. A name with a NUL byte is refused with `422`.

The writing operations and `assets.sync` belong to the module `assetManagement` and follow the same rules as edits in the admin panel: `editableAgentFields`, the lists of a Namespace, and the rights for the default agent and for model settings. Only a release, as described above, is exempt, so `catalyst config push` also works where interactive editing is narrowed or off.

`platform.context.get` tells a caller where it is: the instance, its release, the asset kinds with their rights, and the Namespaces in which the caller may do something. It answers a person and a service principal. An action is named only when the credential's scopes allow it: `config_assets:read` for reading, `config_assets:write` for writing and deleting.

A new agent starts in the workspace it is made in. `assets.put` takes `availableIn`: `{ "workspaceId": "…" }`, a Shared Workspace the caller is a member of, or `"all"`, which needs the right to write agents on the whole instance. A call of an agent in a conversation is made in that conversation's workspace without naming it. A new agent made in no Shared Workspace is hidden everywhere, and the answer carries the warning `agent_hidden`. `assets.sync` without the release right is made in no workspace, so the agents it creates start hidden and its answer names them in `hiddenAgentNames`. A write of an agent that exists refuses `availableIn`: its availability is set with `assets.set_availability`.

`assets.list` and `assets.get` mark the instance's default agent with `isDefault: true` and leave the field out on every other asset. `assets.get` of an agent also carries its `availability`, the workspaces it is offered in, when one is stored.

`assets.set_default` (`POST /api/v1/assets/{kind}/default` with `{ "name": "…" }`) makes one asset the instance's default of its kind, and `assets.set_availability` (`PUT /api/v1/assets/{kind}/{name}/availability`) sets the workspaces one asset is offered in. Only the agent kind takes either today. Both are Operation Runs of the module `assetManagement`, and both need the right to write the kind on the whole instance: a grant in a Namespace or on one asset does not answer it, and a deny on the named asset refuses. The default also needs `allowDefaultAgentChange`. A changed availability moves the version of the asset set, and the next run that starts reads it. Either call may name what it was decided against: `expectedAssetId`, the id of the asset as it was read, and for the availability `expectedAvailability`, the availability as it was read or `null` for none. Where the instance holds something else by then, the call answers `409` and writes nothing, which matters for a call that waited for an approval. Without the fields the call replaces what is stored.

`platform.references.get` answers what a definition may refer to on this instance: the model providers and bindings, the reasoning efforts, the enabled tools, and the tools whose module is off. It answers a caller who holds at least one right on an asset kind, on the instance or in one Namespace, with a credential that carries `config_assets:read` and the scope of that right. It writes no Operation Run, so an editor may read it each time it opens a definition.

### Apps: a draft and a published revision

An App is the asset kind `app`, on an instance with the module `apps` on. Two things set it apart from an agent or a skill, and the kind list of `platform.context.get` reports both: its `lifecycle` is `draft_published`, and its `representation` is `files`.

A write moves the draft and nothing else. The revision the members of the App's workspace are served is the published one, and only `assets.publish` moves it. `assets.list` and `assets.get` answer `draftRevision` and `publishedRevision`; the second is absent before the first publish. `assets.publish` names the revision number to publish. Publishing an earlier number is the way back, so `assets.revert` answers `use_publish` for such a kind. `assets.discard_draft` moves the draft back to the published revision. The discarded revision keeps its number and can still be published, and the next write takes the highest number plus one. A draft write leaves the configuration `version` as it is.

`assets.put` for an App carries `files`, the whole source set of the App with its `app.yaml`, and no `config`: `[{ "path": "index.html", "text": "..." }, { "path": "logo.png", "base64": "..." }]`. One call carries at most 8 MiB of decoded files (`ASSET_PUT_FILES_MAX_BYTES`). The instance builds the files as it builds a Page and waits up to 60 seconds. A set that does not build answers `422` with `details.issues`, each with its file and line. A build that did not end in time answers `504 TIMEOUT` with `build_timeout`; nothing was written, and the `Idempotency-Key` of that call is used up, so send the write again under a new key. In both cases the draft is the revision it was. The answer of a write names `fileSetId` and, for every source file, `path`, `sha256` and `bytes`. The Operation Run keeps those and never the contents. Without `expectedRevision` the call creates the App in the workspace named by `workspaceId`; an App belongs to one workspace, and a write without one answers `scope_unavailable`. `assets.sync` takes no App. Where a policy holds `assets.put` for an approval, a write whose input is above 256 KiB (`HELD_OPERATION_INPUT_MAX_BYTES`) cannot be held: it answers `422` with the reason `input_too_large_to_hold` before a file is stored or built. `assets.publish` answers `422` with `revision_files_removed` for a revision whose built files are not stored, and the published revision stays the one it was.

`assets.get` reads one revision of an App: `revision` is `draft` (the default), `published` or a revision number, and `contentRevision` in the answer names the revision that is shown, while `revision` stays the number of the draft that a write names. With `files=true` the answer carries the source files of that revision in the order of their paths, each with `path`, `contentType`, `sha256`, `bytes` and its content as `text` where the bytes are UTF-8 text and as `base64` otherwise, so the files of an answer can be put again as they are. One answer carries at most 8 MiB of files (`ASSET_GET_FILES_MAX_BYTES`); for a larger set it carries the index without contents and `filesOmitted: true`. The published revision needs `app.read`; the draft and a numbered revision need `app.write` or `app.publish`. A read that names no revision answers the draft to whoever may read it. Everybody else who holds `app.read` or `app.use` is answered the published view: the published revision's config, `revision`, `contentRevision` and `publishedRevision` all naming that revision, and no `draftRevision`. `assets.list` shows a holder of `app.use` alone the same view of every published App, with the title it was published under, and no App that has only a draft. Through `app.use` no files are read. `assets.revisions.list` holds every draft and needs `app.write` or `app.publish`. `published` before the first publish answers `404` with `not_published`, an unknown number `revision_unknown`, and a revision whose files are not stored `revision_files_removed`. For a kind without files `files=true` answers `422` with `no_files`, and any `revision` but `draft` answers `no_draft`.

`apps.create_from_page` (`POST /api/v1/apps`) saves the newest revision of a Page as an App with a draft. It copies the files, so the App stays when the conversation of the Page is deleted. The source files become the first commit of the App's git repository, and the audit event `app.created` names the asset, the revision and the commit. The commit is made by the workspace command worker with the git of the runner image: on a runner image older than the release the call is refused with `409` and `details.reason` `runner_image_outdated`, and without a worker with `commit_unavailable`. The revision records the Page as its `origin`: `{ "kind": "page", "conversationId", "pageId", "fileSetNumber" }`. The Page an App is updated from is the one its newest revision with such an origin names.

`apps.update_from_page` (`POST /api/v1/apps/{app}/update-from-page`) writes the newest revision of that Page as the next draft revision of the App. It needs `app.write` on the App and read access to the Page, and it names `expectedRevision`, the draft revision the caller last read. Nothing is published, and the App keeps its title. The update is the next commit of the App's repository, made as the commit of a save is and refused as one is. An App that is updated from another Page or from none answers `409` with `details.reason: "app_not_from_page"`; that includes every App saved before a release with this operation. With `"link": true` such an App is written too and is this Page's from then on; the audit event `config_asset.updated` of that write carries `pageLinked: true`. A draft that moved since answers `412 REVISION_CONFLICT`, and a call with the new number replaces it.

`apps.get_from_page` (`GET /api/v1/conversations/{conversationId}/pages/{pageId}/app`) answers the App of a Page, or `null`: among the Apps updated from the Page that the caller may write, the one the caller wrote from it last, and otherwise the one created first. `draftFromPage` is `false` where the draft was last written another way than from this Page. With `?app=<id>` the answer also carries `candidate`: that App where the caller may write it, with `page` saying whether it is updated from `none`, `this` Page, an `other_page` of the conversation or one of an `other_conversation`; `null` otherwise. In the interface the header of a Page with an App offers Update app in place of Save as app, and Save as app under the id of an App the reader may write offers to update that App from the Page.

With the module `apps` on, every conversation offers its agent `page.save`, `page.save_as_app` and the file tools a Page's folder is written with (`workspace.write_file`, and `workspace.edit_file` and `workspace.read_file` where the release enables them), whatever the agent's `toolNames` list; without `workspace.write_file` in the release none of them is offered. The surface beside the chat opens when the first save starts, as the Page building. `page.save_as_app` is the agent's Save as app: it saves the newest revision of a Page of the conversation as an App of the conversation's workspace, with `app.created` as above, and makes the App what the conversation is about. It is refused in a conversation shared with its workspace, as an open is. From then on each built `page.save` of that Page in the conversation also writes the next draft revision of the App, as `apps.update_from_page` does; its answer carries `app` with `saved: true`, the revision and the `warnings` of guardrails that warn about the draft, or `saved: false` with the reason where the draft was written another way since, another Page was put into the App, the person may not write it, a guardrail blocked it or asked for an approval, which this save cannot wait for (the person's Update app on the Page can), or the write failed. The Page is saved either way. What an administrator sets on `assets.put` for an App holds for both tools, as it does for `platform.assets.put`; a setting on `apps.create_from_page` holds for `page.save_as_app`, and one on `apps.update_from_page` for `page.save` in a conversation about an App.

`apps.preview` (`POST /api/v1/apps/{app}/preview`) answers the address a frame loads, for the mode `published` or `draft`, and `interfacePath`, the path of the App in the interface. `assets.delete` removes an App with its revisions and its files; its Operation Runs and audit events stay.

The address `apps.preview` answers is the credential of the frame it is loaded in: the sandboxed frame has no origin and cannot send the session, so whoever holds the address is served its files. The address names the person it was made for and one file set, is valid for one hour, and that person's right is asked again at most every 30 seconds. A browser keeps a file no longer than the address is valid. Treat the address as a secret of that person and do not pass it on; share the App by its path in the interface (`interfacePath`).

| Right | Who holds it | What it allows |
| --- | --- | --- |
| `app.read`, `app.write`, `app.delete` | admin, superadmin | Read, write and delete Apps. A writer is shown the draft. |
| `app.publish` | admin, superadmin | Move the published revision. A credential needs the scope `config_assets:publish`, which `config_assets:write` does not include. |
| `app.use` | every member of the App's workspace | Open the published revision, and see it in `assets.list` and `assets.get`. A member is never shown a draft. |

## Permissions

| Permission              | Grants                                                                       | Default roles              |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| `config_assets.read`    | View assets and revisions                                                    | admin, superadmin          |
| `config_assets.write`   | Interactive edits within `editableAgentFields`, skill editing, default agent | admin, superadmin          |
| `config_assets.release` | Release synchronization via `catalyst config push`                           | none (service tokens only) |
| `agent_models.manage`   | Interactive changes to an agent's model settings and user-selectable models  | superadmin                 |

Effective permissions resolve from role defaults plus per-user grants (`"config_assets.write"`) and revocations (`"!config_assets.write"`) stored on the product user.

Beside these, an administrator can allow or deny one user read, write or delete on agents or skills in a Namespace (a registered name prefix) or on one asset, through the operations under `/api/v1/instance/access`. A deny on an asset belongs to its name: it stays until it is revoked, also when the asset is deleted and created again, and the grant list keeps showing it. Allow rows on an asset are removed when the asset is deleted.
