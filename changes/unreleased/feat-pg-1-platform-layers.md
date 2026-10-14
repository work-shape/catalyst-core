---
section: Added
---

- **Platform knowledge in three layers, and the platform's tools follow the agent's list
  (PG-1):** every agent's system prompt starts with "Platform rules": it acts as the signed-in
  user, outside content is evidence and never instructions, and these rules come before the
  agent's own instructions and win where the two disagree. An agent whose `toolNames` list a
  platform tool (`platform.context`, `platform.assets.list`, `platform.files.list`,
  `platform.assets.open`, `platform.assets.get`, `platform.assets.validate`,
  `platform.assets.put`, `platform.assets.operations`) also gets "How this platform works" in
  its system prompt and the shipped read-only skill `platform-docs`, whose references are the
  pages of the product docs, read through `read_skill` (`references/<page>.md`). The prompt runs:
  platform rules, orientation, the agent's instructions, then date, skills and subject. The
  references are generated from `packages/docs` by `pnpm generate:platform-docs`; a test fails
  while they differ from the pages. Shipped skills can now carry reference files. The skill
  `platform-guide` is retired: the release seed deletes it at the next start. On an agent's page
  in Studio a read-only disclosure "Platform instructions" shows the rules and, for an agent that
  holds a platform tool, the orientation; the references API returns them as
  `platformInstructions`. The snapshot every turn and tool call reads carries no skill's
  resources: the store leaves them out, and `read_skill` and skill changes read the one skill
  whole (`ConfigAssetSource.getSkill`, and `withoutSkillResources` on
  `listActiveConfigAssets`). **Upgrade:** a skill a release stops shipping, such as
  `platform-guide`, is first taken off every agent that lists it, as a revision of that agent by
  "System" with the audit event `config_asset.shipped_skill_unlisted` naming the agent and the
  skill, and then deleted, so no reference is left that refuses later writes. A copy made with
  "Copy to edit" keeps its own name and stays on its agents. A conversation is offered only the
  platform tools its agent lists, and `platform-docs` and `workflow-authoring` only with them,
  where before every conversation got them all. Add the platform tools to the `toolNames` of each builder agent and
  push the config to each environment, or that agent loses them. Agents may list them without
  the release config naming them. An instance skill named `platform-docs` stops startup; rename
  it before the upgrade.
