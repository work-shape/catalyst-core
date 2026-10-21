---
section: Database
---

- **Access:** Migration `0141_agent_use_limits` adds the table `agent_use_limits`: one row per agent that only holders of `agent.use` may use, removed with its agent. It is created empty, so every agent stays usable by everyone where it is available; it moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the table, so a rollback of the application ignores any limit set meanwhile; remove the table only through a later committed migration.
