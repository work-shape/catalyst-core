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
