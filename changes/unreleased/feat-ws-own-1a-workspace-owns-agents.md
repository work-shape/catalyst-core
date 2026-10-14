---
section: Added
---

- **A workspace owns agents and skills (WS-OWN-1a):** an agent or skill made in a Shared
  Workspace's Studio scope, or pushed from a working copy bound with
  `catalyst config pull --workspace <id>`, belongs to that workspace; one made with the scope
  Instance, or from an unbound working copy, belongs to the instance. `assets.put`,
  `assets.sync` and the reads take the owner as `workspaceId`; a batch names a Namespace or a
  workspace, never both, and a workspace batch is never a release. Only an asset of the same
  workspace may name a workspace's skill: an instance agent or another workspace's agent that
  names it is refused with `invalid_scope`, and a workspace agent names an instance skill only
  where its writer holds `skill.read` on it. A name that is taken is refused without saying
  where. A new workspace agent is offered in the workspace it was made in when its maker is a
  member there, and starts hidden after a push. Agent and skill rights can be granted "In
  workspace X" on Instance > Access. Studio has a scope filter, shows a workspace chip on a
  workspace's assets and writes into the scope chosen. `platform.context` names, per workspace,
  the actions the caller holds on what it owns (`workspaces`), and each kind's `owners`. What a
  workspace owns is deleted with it. The demo seed gives the workspace `Nordlicht Beratung` the
  skill `nordlicht-house-style` and the agent `nordlicht-front-desk`.
