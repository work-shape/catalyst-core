---
section: Added
---

- **Guardrails written as assets (EW-6a):** the kind `guardrail` is written as a draft and made
  to enforce by a publish, on the `draft_published` lifecycle, through `assets.put`, the CLI and
  the agent's asset tools. A guardrail belongs to the instance or to one Collaboration
  Workspace. Published guardrails run beside the floor of release config, which the release
  seed now stores published and which stays read-only; every guardrail that applies runs and
  the strictest answer wins. A workspace guardrail answers its workspace's events only, and a
  filter that reaches outside it (another workspace, an agent the workspace does not offer, an
  operation of another workspace's asset) is refused at save and at publish. Filters take a new
  key `workspace`. Guardrail assets never run on writes, publishes, deletes or tests of
  guardrails; only the floor does.
- **`guardrail.publish`:** a right of its own, held by administrators at instance scope and
  grantable at one Shared Workspace through `permissions.grant`. No bundle carries it.
- **`guardrails.test`, `guardrails.dry_run` and `guardrails.unpublish`:** a test checks a
  revision, the draft unless named, on sample content or on an asset, and keeps no hit. A dry
  run counts what it would have blocked, asked an approval for or warned on in the last 14 days,
  by actions and people and without names: writes and publishes of assets are checked again, a
  judge on at most the newest 200; calls of operations and approval requests are counted only.
  Unpublish stops a guardrail and keeps its draft. Publish and unpublish are audited as
  `guardrail.published` and `guardrail.unpublished` with revision, scope and actor, and a judge's
  usage counts for the guardrail's scope.
- **CLI:** `catalyst guardrail test`, `dry-run` and `unpublish`; `catalyst guardrail publish`
  shows the dry run first and asks `--confirm <n>` on a first publish that would block. `catalyst
  config pull|push` carries `guardrails/<name>/guardrail.yaml` with `check.md` for a judge's
  instruction.
- **Studio > Guardrails says when each guardrail runs:** every row of the list and the page of
  a guardrail show one line built from its event, filter, check, outcome and scope, in English
  and German, such as "Runs before an agent saves a skill, in workspace Kai Spezis. Checks the
  content for a text pattern. Blocks if the check fails." A guardrail of release config reads
  "set by the operator", and no event id is shown. A workspace guardrail's page names its
  workspace in place of "Instance".
- **Which calls skip the published guardrails** is decided by the operation: `guardrails.*`, the
  asset operations on the kind `guardrail`, a sync of guardrails alone and the agent's save of
  the guardrail its conversation is about. An input that names `kind: guardrail` no longer
  does. The dry run answers the guardrail's `outcome`, and `catalyst guardrail publish` asks
  `--confirm` also for the actions a first blocking publish could not check.
