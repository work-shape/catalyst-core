---
section: Database
---

- **Agents:** Migration `0145_agent_awaiting_first_publish` adds the column `config_asset_availability.awaiting_first_publish` (boolean, default false, not null). It marks a workspace's agent that its maker, who holds no `agent.approve` there, left offered nowhere: only the approval of its first publish offers it in its workspace, and every later availability write clears it. Existing agents keep false, so no approval re-offers an agent an admin hid. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the column; remove it only through a later committed migration.
