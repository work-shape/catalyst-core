---
section: Added
---

- **Studio:** "Available in" offers a third choice beside "All workspaces" and "Selected
  workspaces": "All workspaces except…" ("Alle Arbeitsbereiche außer…"). The asset stays offered
  in every shared workspace, also those made later, except the ones ticked under "Not in"
  ("Nicht in"); "Personal workspaces" keeps its own switch. It applies to agents, Knowledge Bases
  and Connections. The agent's line then says "All except 1" ("Alle außer 1").
- **Assets:** `assets.set_availability` and every read of an asset's availability take the mode
  `all_except`, whose `collaborationWorkspaceIds` are the Shared Workspaces left out. Leaving out
  a workspace whose own default the agent is, or one where the instance default is needed, is
  refused as with `selected`. `catalyst <kind> set-availability <name> --mode all_except
  [--personal] --except <workspace-id>` sets it from the CLI.
- **Database:** Migrations 0197 and 0198 let `config_asset_availability.mode` hold `all_except`.
  An older release reads such a row as `selected`; set those assets to another mode before
  rolling back past this release.
