# Changelog

All platform packages are released in lockstep under one version. Before 1.0 a minor version may
contain breaking changes; a patch version does not.

## Unreleased

### Added

- **Chat:** the composer's model selector is a model picker. It opens as a short menu with the
  model and its reasoning effort; the model list shows each model's provider logo and an EU
  mark for providers with `compliance.residency: eu`, and a model under the pointer brings up a
  card with its description and usage consumption. A model binding can carry `description`,
  `vendor` and `usageTier` for it. The usage tier comes from the Customer Rate Card unless the
  binding sets one.
- **Chat:** users can pick the reasoning effort of a model whose binding lists
  `userSelectableReasoningEfforts`. The agent's configured effort stays the default. The run
  API accepts `reasoningEffort` and rejects an effort the model that runs does not offer. A
  migration adds `agent_runs.reasoning_effort`.
- **Chat:** a model or reasoning effort the user picks becomes their default for new
  conversations, on every device. A conversation that already ran stays on what its latest run
  used, and a user who never picked anything follows the configured defaults. The pick is
  stored per user (`/api/me/model-preference`); a migration adds `product_users.model_preference`.

## 0.6.3 — 2026-10-08

### Fixed

- **Chat:** a file is read before its upload request opens, and an upload that fails without an
  answer from the API is retried. A browser that could not read a file promptly used to stall
  the request until the reverse proxy gave up. The remaining error names the file.
- **Models:** a provider `server_error` or `rate_limit_exceeded` inside a Responses stream is
  retried like the same failure on the request. A stream that stays silent for 10 minutes is
  given up as a timeout instead of holding the run until the provider answers.

## 0.6.2 — 2026-10-08

### Changed

- **Chat:** a long user message is collapsed to a few lines with "Show more" and "Show less".

## 0.6.1 — 2026-10-08

### Changed

- **Skill change proposals:** a proposal for a new skill can carry its supporting files in the
  same request: `create_skill` first, followed by `create_resource` operations such as
  `references/checklist.md`. The limit per operation text is 20,000 characters instead of 4,000.

## 0.6.0 — 2026-10-06

### Added

- **Deployment kit:** the release and deploy tooling of operated instances is the package
  `@vivd-catalyst/deployment-kit` with the command `catalyst-deploy` (`check`, `update-refs`,
  `prepare-workspace`, `publish`, `manifest`, `deploy`). It carries what each deployment repo
  kept as its own copy: the deploy by image digest, release manifests, staging and production
  publishing, Postgres backup and restore with their systemd units, the zram setup, and the
  checks of the worker wiring in Compose. A deployment names its instance in
  `deploy/deployment.env` (`INSTANCE`, `IMAGE_REPOSITORY`, `APP_PACKAGE`,
  `EXECUTION_WORKSPACES`); host paths, dump names and unit names follow from it. The package is
  not published yet and is used from the platform checkout at the pinned ref.

### Changed

- **Deployment kit:** the scripts under `scripts/deployment-kit/` moved into the package. The
  old paths remain as forwarding stubs, so deployments pinned to them keep working.
- **Release check:** `check-release.sh` no longer requires a `deploy/scripts` directory in the
  deployment.

## 0.5.1 — 2026-10-06

### Added

- **Retention:** the hourly retention job removes orphaned managed files. A `managed_files` row
  older than 24 hours that no active conversation refers to, through an attachment of any
  status or as the source of an artifact, is marked deleted and its stored object is removed.
  This reaches what user deletions before 2026-08-31 and interrupted uploads left behind. The
  job records one `storage.orphaned_files_deleted` audit event with counts per run that removed
  something. An attachment handler takes part by implementing the optional
  `deleteOrphanedFileObjects`; without it nothing is removed.

### Fixed

- **Admin pages:** a table taller than the window, such as the user list, scrolls again instead
  of being cut off.
- **show_view:** the layout guidance for views closes two padding loopholes.
- **Conversation rail:** the collapse handle on the rail's edge no longer covers the list's
  scrollbar. It appears while the pointer is on the rail's right border or the handle has
  keyboard focus.
- **Uploads into a deleted conversation:** a draft attachment whose conversation is deleted
  while the file is still arriving is rejected before any bytes are stored. The conversation
  was checked only when the request started, so a slow upload could leave a stored object and
  a `managed_files` row that no deletion would reach.

## 0.5.0 — 2026-10-06

### Added

- **Retention:** `retention.expireConversations: false` lets a client instance keep
  conversations indefinitely.

### Changed

- **Packaging:** the library packages carry publish metadata for npm (`files`, typed `exports`
  without the `development` condition, restricted access, licence, `engines`) and are no longer
  marked `private`. `pnpm release:check` builds, packs and inspects every tarball and installs a
  consumer set outside the workspace; `pnpm release:metadata` reapplies the shared fields.
  Nothing is published yet.
- **chat-ui:** `tailwindcss` and `tw-animate-css` are peer dependencies. The stylesheet no longer
  scans `chat-standalone`, which has its own stylesheet now, and finds Streamdown's classes when
  installed from a tarball as well as in the workspace.

### Fixed

- **Abandoned draft conversations:** attaching files on the start page and removing them again
  no longer leaves an empty conversation in the rail. `GET /api/conversations` lists a
  conversation without messages only to its creator, and only while it holds draft attachments;
  access by id is unchanged. Removing the last draft attachment returns the composer to the
  start page, and the retention job expires conversations that have had neither messages nor
  draft attachments for 24 hours. This cleanup also runs with
  `retention.expireConversations: false`, which keeps every conversation that has a message or
  a draft attachment.
- The `catalyst` CLI did nothing when started through the `node_modules/.bin` link of an
  installed package.

## 0.4.0 — 2026-10-06

### Changed

- **Agent model settings:** an agent may offer its users any model binding agents may use. The
  binding-level `userSelectable` key in release config is still accepted but no longer has an
  effect; `agent_models.manage` governs the choice. The agent editor shows one model list with
  a default and a "Selectable by users" tick per model.
- **Reasoning effort per model:** `modelReasoningEfforts` sets the effort for each model an
  agent offers to users, edited per row in the model list. `reasoningEffort` stays the effort
  of the agent's own model and is no longer applied to a model a user picked instead, which
  now runs with its own entry or the binding's default.
- **API:** the safe config view no longer carries the top-level `selectableModels`; use
  `agents[].selectableModels`. The config assets overview no longer carries
  `references.userSelectableModelBindings`.

## 0.3.0 — 2026-10-06

### Changed

- **Agent model settings:** each agent lists the models chat users may pick in
  `userSelectableModelBindingIds`, editable with `agent_models.manage`. The composer offers the
  agent's own model plus that list instead of every `userSelectable` binding, so a deployment
  that offered a model choice must add the list to its agents to keep it. The safe config view
  carries `agents[].selectableModels`.

### Fixed

- Saving an agent's model settings no longer fails with 403 when its other fields are locked:
  unchanged fields were reported as changed because stored JSON key order differs.
- A rejected save shows the server's message next to the save button.
- Viewers of a shared conversation can no longer interrupt another user's active run.

## 0.2.0 — 2026-10-06

First versioned release. Compared with production, which runs `staging-2026.09.14-1` (platform
`a2a13a8`, deployed 2026-09-14):

### Added

- **Email:** transactional mail with password reset and user invitations.
- **Approvals:** agents propose skill changes; reviewers approve, reject or request changes on an
  approvals page with an open queue and a collapsed history. Decisions appear in the conversation.
  Release-configured checks fail closed. A reviewer revises someone else's proposal in their own
  conversation.
- **Conversation visibility:** private conversations in Shared Workspaces, with a default per
  workspace.
- **Agent availability:** agents can be limited to selected Collaboration Workspaces.
- **Start page:** centred composer with starter prompts and agent cards.
- **Agent model settings:** model, reasoning effort and fast mode per agent behind the
  `agent_models.manage` permission; fast runs are settled by the tier the provider reports.
- **Operations:** the agent-run worker drains active runs on shutdown; the config CLI detects
  conflicts per asset and lists agents left hidden after a push.

### Fixed

- Workspace conversations stay in the rail on settings, approvals and admin pages.
- User messages with wide code blocks stay inside the thread; code and quotes are readable in
  user message bubbles.
- Forwarding headers are trusted from private proxy peers.
- Emailed password setup completes in one transaction and rejects invalid tokens early.

### Database

Migrations 0025 to 0029. 0027 backfills existing conversations as visible to the workspace; 0028
backfills existing agents as available everywhere.
